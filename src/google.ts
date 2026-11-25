// 구글 Tasks API.
import { ApiError, Budget, Fetcher, request } from "./http";
import type { GRaw, GTask, GoogleApi } from "./types";

const API = "https://tasks.googleapis.com/tasks/v1";

// 같은 Worker 인스턴스가 다시 쓰이면 토큰을 재사용해서 요청 수를 아낀다
let cached: { key: string; token: string; exp: number } | null = null;

const ts = (s?: string) => (s ? Date.parse(s) : 0);
const norm = (s?: string) => (s ?? "").replace(/\r\n/g, "\n").trim();

function toItem(t: any): GTask {
  return {
    id: t.id,
    title: norm(t.title),
    notes: norm(t.notes),
    due: (t.due ?? "").slice(0, 10),
    done: t.status === "completed",
    parentRaw: t.parent ?? "",
    updated: ts(t.updated),
    doneAt: t.completed ? ts(t.completed) : undefined,
    gone: Boolean(t.deleted),
  };
}

function body(v: Partial<GRaw>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (v.title !== undefined) b.title = v.title;
  if (v.notes !== undefined) b.notes = v.notes;
  if (v.due !== undefined) b.due = v.due ? `${v.due}T00:00:00.000Z` : null;
  if (v.done !== undefined) {
    b.status = v.done ? "completed" : "needsAction";
    if (!v.done) b.completed = null;
  }
  return b;
}

export class Google implements GoogleApi {
  private h: Record<string, string> = {};

  private constructor(private f: Fetcher, private budget: Budget) {}

  static async connect(f: Fetcher, budget: Budget, clientId: string, clientSecret: string, refreshToken: string, now: number) {
    const g = new Google(f, budget);
    const key = `${clientId}:${refreshToken.slice(-8)}`;
    if (!cached || cached.key !== key || cached.exp < now + 60_000) {
      const res = await request<any>(f, budget, "https://oauth2.googleapis.com/token", {
        method: "POST",
        form: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" },
      });
      if (!res?.access_token) throw new ApiError("구글 로그인 토큰을 받지 못함");
      cached = { key, token: res.access_token, exp: now + (Number(res.expires_in) || 3600) * 1000 };
    }
    g.h = { authorization: `Bearer ${cached.token}` };
    return g;
  }

  private lists: any[] | null = null;

  async findList(title: string): Promise<string> {
    if (!this.lists) {
      const res = await request<any>(this.f, this.budget, `${API}/users/@me/lists`, { headers: this.h, query: { maxResults: "100" } });
      this.lists = res?.items ?? [];
    }
    const found = this.lists!.find((l: any) => l.title === title);
    if (!found) throw new ApiError("구글 Tasks에서 지정한 목록 이름을 찾지 못함");
    return found.id;
  }

  async listTasks(listId: string, completedMin: number): Promise<Map<string, GTask>> {
    const out = new Map<string, GTask>();
    // 구글은 completedMin 을 주면 '완료 안 된 항목'까지 빼버려서, 두 번에 나눠 가져온다.
    // 1) 진행 중 항목 전부 (+ 지워진 진행 중 항목)
    await this.fetchAll(listId, { showCompleted: "false", showHidden: "false", showDeleted: "true" }, out);
    // 2) 최근에 완료된 항목만 (오래전에 완료된 항목은 빼서 요청 수 절약)
    await this.fetchAll(
      listId,
      { showCompleted: "true", showHidden: "true", showDeleted: "true", completedMin: new Date(completedMin).toISOString() },
      out,
    );
    return out;
  }

  private async fetchAll(listId: string, q: Record<string, string>, out: Map<string, GTask>): Promise<void> {
    let pageToken: string | undefined;
    do {
      const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks`, {
        headers: this.h,
        query: { maxResults: "100", ...q, pageToken },
      });
      for (const t of res?.items ?? []) out.set(t.id, toItem(t));
      pageToken = res?.nextPageToken;
    } while (pageToken);
  }

  async getTask(listId: string, id: string): Promise<GTask | null> {
    const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks/${id}`, { headers: this.h, ok: [200, 404] });
    if (!res || res.error || !res.id) return null;
    return toItem(res);
  }

  async create(listId: string, v: Partial<GRaw>): Promise<string> {
    const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks`, { method: "POST", headers: this.h, json: body(v) });
    return res.id;
  }

  async update(listId: string, id: string, v: Partial<GRaw>): Promise<void> {
    await request(this.f, this.budget, `${API}/lists/${listId}/tasks/${id}`, { method: "PATCH", headers: this.h, json: body(v) });
  }

  async move(listId: string, id: string, parent: string): Promise<void> {
    await request(this.f, this.budget, `${API}/lists/${listId}/tasks/${id}/move`, {
      method: "POST",
      headers: this.h,
      query: { parent: parent || undefined },
    });
  }

  async remove(listId: string, id: string): Promise<void> {
    await request(this.f, this.budget, `${API}/lists/${listId}/tasks/${id}`, { method: "DELETE", headers: this.h, ok: [200, 204, 404] });
  }
}
