// 외부 요청 도우미.
// - Cloudflare 무료 플랜은 실행 한 번에 외부 요청 50개까지라서, 요청 수를 Budget 으로 센다.
// - 오류 내용에 할 일 내용이 섞일 수 있어서, 오류 메시지에는 주소의 호스트와 상태 코드만 남긴다.

export class ApiError extends Error {}

export class Budget {
  used = 0;
  constructor(public readonly limit: number) {}
  left(): number {
    return this.limit - this.used;
  }
  take(): void {
    if (this.used >= this.limit) throw new ApiError("이번 실행의 요청 한도를 다 썼어요");
    this.used += 1;
  }
}

export interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  ok?: number[];
  tries?: number;
}

export type Fetcher = typeof fetch;

export async function request<T = any>(
  fetcher: Fetcher,
  budget: Budget,
  url: string,
  o: ReqOpts = {},
): Promise<T | null> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  }
  const ok = o.ok ?? [200];
  const tries = o.tries ?? 3;
  const method = o.method ?? "GET";
  for (let attempt = 0; attempt < tries; attempt++) {
    budget.take();
    const r = await fetcher(u.toString(), { method, headers, body });
    if (ok.includes(r.status)) {
      const text = await r.text();
      return text ? (JSON.parse(text) as T) : null;
    }
    if ([429, 500, 502, 503, 504].includes(r.status) && attempt < tries - 1) {
      const wait = Math.min(Number(r.headers.get("retry-after")) || 2 ** attempt, 5);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    let code = "";
    try {
      const j: any = await r.json();
      code = j?.code ?? j?.error?.status ?? (typeof j?.error === "string" ? j.error : "");
    } catch {
      /* 본문 없음 */
    }
    throw new ApiError(`${method} ${u.host} 실패: HTTP ${r.status} ${code}`.trim());
  }
  throw new ApiError("재시도 초과");
}
