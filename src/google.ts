// 구글 Tasks API.
import { ApiError, Budget, Fetcher, request } from "./http";
import type { GoogleApi, Item, Vals } from "./types";

const API = "https://tasks.googleapis.com/tasks/v1";

// 같은 Worker 인스턴스가 다시 쓰이면 토큰을 재사용해서 요청 수를 아낀다
let cached: { key: string; token: string; exp: number } | null = null;

const ts = (s?: string) => (s ? Date.parse(s) : 0);
const norm = (s?: string) => (s ?? "").replace(/\r\n/g, "\n").trim();

function toItem(t: any): Item {
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

function body(v: Vals): Record<string, unknown> {
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

  async findList(title: string): Promise<string> {
    const res = await request<any>(this.f, this.budget, `${API}/users/@me/lists`, { headers: this.h, query: { maxResults: "100" } });
    const found = (res?.items ?? []).find((l: any) => l.title === title);
    if (!found) throw new ApiError("구글 Tasks에서 지정한 목록 이름을 찾지 못함");
    return found.id;
  }

  async listTasks(listId: string, completedMin: number): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    let pageToken: string | undefined;
    do {
      const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks`, {
        headers: this.h,
        query: {
          maxResults: "100",
          showCompleted: "true",
          showHidden: "true",
          showDeleted: "true",
          // 오래전에 완료된 항목은 빼고 가져온다 (요청 수 절약). 진행 중 항목은 항상 포함된다.
          completedMin: new Date(completedMin).toISOString(),
          pageToken,
        },
      });
      for (const t of res?.items ?? []) out.set(t.id, toItem(t));
      pageToken = res?.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getTask(listId: string, id: string): Promise<Item | null> {
    const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks/${id}`, { headers: this.h, ok: [200, 404] });
    if (!res || res.error || !res.id) return null;
    return toItem(res);
  }

  async create(listId: string, v: Vals): Promise<string> {
    const res = await request<any>(this.f, this.budget, `${API}/lists/${listId}/tasks`, { method: "POST", headers: this.h, json: body(v) });
    return res.id;
  }

  async update(listId: string, id: string, v: Vals): Promise<void> {
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
