// Cloudflare Worker 시작점.
// - 5분마다 cron  : 구글 Tasks ↔ Notion 동기화
// - POST /run     : 배포 직후 확인용·수동 실행용 (x-run-secret 이 맞아야 함). ?dry=1 이면 시험 실행
// 로그에는 할 일 내용 없이 개수만 남긴다.

import { Budget, ApiError } from "./http";
import { Google } from "./google";
import { Notion } from "./notion";
import { SafetyStop, summary, syncList, type Counts, type ListState } from "./engine";
import type { ListConfig } from "./types";

export const LISTS: ListConfig[] = [
  {
    key: "todo",
    googleListTitle: "할 일",
    notionDsEnv: "NOTION_TODO_DS_ID",
    props: {
      title: "할 일",
      done: "완료",
      notes: "메모",
      due: "마감일",
      parent: "Parent Task",
      frequency: "Frequency", // 비어 있지 않으면 '반복 항목'
      nextDue: "Next Due", // 반복 항목은 이 날짜를 구글로 보낸다
    },
  },
  // 나중에 '살 것들' ↔ 장바구니, 'AI 개발' ↔ AI 개발을 여기에 추가
];

export interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  NOTION_TOKEN?: string;
  NOTION_STATE_PAGE_ID?: string;
  NOTION_TODO_DS_ID?: string;
  RUN_SECRET?: string;
  [k: string]: unknown;
}

const REQUEST_LIMIT = 48; // 무료 플랜: 실행 한 번에 외부 요청 50개 (여유 2개)

export interface RunResult {
  ok: boolean;
  dry: boolean;
  lists: Record<string, string>;
  error?: string;
  requests: number;
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");

export async function runSync(env: Env, dry: boolean, now = Date.now(), fetcher: typeof fetch = fetch): Promise<RunResult> {
  const budget = new Budget(REQUEST_LIMIT);
  const result: RunResult = { ok: false, dry, lists: {}, requests: 0 };
  try {
    const need = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NOTION_TOKEN", "NOTION_STATE_PAGE_ID"];
    const missing = need.filter((k) => !clean(env[k]));
    if (missing.length) throw new ApiError(`설정값(Secrets)이 없어요: ${missing.join(", ")}`);

    const g = await Google.connect(fetcher, budget, clean(env.GOOGLE_CLIENT_ID), clean(env.GOOGLE_CLIENT_SECRET), clean(env.GOOGLE_REFRESH_TOKEN), now);
    const n = new Notion(fetcher, budget, clean(env.NOTION_TOKEN));
    const statePage = clean(env.NOTION_STATE_PAGE_ID);
    const { state, blockId } = await n.loadState(statePage);
    state.version ??= 1;
    state.lists ??= {};

    for (const cfg of LISTS) {
      const dsId = clean(env[cfg.notionDsEnv]);
      if (!dsId) {
        result.lists[cfg.key] = "Notion ID 가 없어 건너뜀";
        continue;
      }
      const gList = await g.findList(cfg.googleListTitle);
      const st: ListState = (state.lists[cfg.key] ??= {});
      const counts: Counts = await syncList({ cfg, g, n, budget, gList, dsId, st, now, dryRun: dry });
      result.lists[cfg.key] = summary(counts);
    }

    state.last_run = new Date(now).toISOString();
    if (!dry) await n.saveState(statePage, blockId, state);
    result.ok = true;
  } catch (e) {
    if (e instanceof SafetyStop) result.error = `⛔ 안전장치로 멈춤: ${e.message}`;
    else if (e instanceof ApiError) result.error = `❌ ${e.message}`;
    else result.error = `❌ 예상 못 한 오류: ${e instanceof Error ? e.name : "unknown"}`;
  }
  result.requests = budget.used;
  return result;
}

function logResult(r: RunResult) {
  const head = `${r.dry ? "[시험 실행] " : ""}${r.ok ? "동기화 완료" : "동기화 실패"} (요청 ${r.requests}개)`;
  const lines = [head, ...Object.entries(r.lists).map(([k, v]) => `- ${k}: ${v}`)];
  if (r.error) lines.push(r.error);
  (r.ok ? console.log : console.error)(lines.join("\n"));
}

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const r = await runSync(env, false);
    logResult(r);
    if (!r.ok) throw new Error(r.error ?? "동기화 실패"); // Cloudflare 대시보드에 '실패'로 표시
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      const secret = clean(env.RUN_SECRET);
      if (!secret || req.headers.get("x-run-secret") !== secret) return new Response("forbidden", { status: 403 });
      const r = await runSync(env, url.searchParams.get("dry") === "1");
      logResult(r);
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("notion-tasks-sync: 동작 중", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
