// Notion API (데이터베이스 항목 + '동기화 기록' 페이지).
import { ApiError, Budget, Fetcher, request } from "./http";
import type { Item, NotionApi, Props, Vals } from "./types";

const API = "https://api.notion.com/v1";
const VERSION = "2025-09-03";

const plain = (rich: any[] | undefined) => (rich ?? []).map((x) => x.plain_text ?? "").join("");
const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

export function rich(text: string): any[] {
  const out: any[] = [];
  for (let i = 0; i < text.length; i += 2000) out.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  return out;
}

export function pageToItem(pg: any, p: Props): Item | null {
  if (pg.in_trash || pg.archived) return null;
  const pr = pg.properties ?? {};
  const dueRaw: string | null = pr[p.due]?.date?.start ?? null;
  const rel = pr[p.parent]?.relation ?? [];
  const freq = p.frequency ? plain(pr[p.frequency]?.rich_text) : "";
  let nextDue = "";
  const f = p.nextDue ? pr[p.nextDue]?.formula : undefined;
  if (f?.type === "date" && f.date?.start) nextDue = String(f.date.start).slice(0, 10);
  else if (f?.type === "string" && f.string) nextDue = String(f.string).slice(0, 10);
  return {
    id: pg.id,
    title: norm(plain(pr[p.title]?.title)),
    notes: norm(plain(pr[p.notes]?.rich_text)),
    due: (dueRaw ?? "").slice(0, 10),
    done: Boolean(pr[p.done]?.checkbox),
    parentRaw: rel[0]?.id ?? "",
    updated: Date.parse(pg.last_edited_time),
    created: Date.parse(pg.created_time),
    dueRaw,
    repeat: freq.trim().length > 0,
    nextDue,
  };
}

export function propsFor(p: Props, v: Vals, old: Item | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v.title !== undefined) out[p.title] = { title: rich(v.title) };
  if (v.notes !== undefined) out[p.notes] = { rich_text: rich(v.notes) };
  if (v.done !== undefined) out[p.done] = { checkbox: v.done };
  if (v.due !== undefined) {
    if (!v.due) out[p.due] = { date: null };
    else {
      // Notion 에 시간이 들어 있었다면 시간은 그대로 두고 날짜만 바꾼다
      const start = old?.dueRaw && old.dueRaw.length > 10 ? v.due + old.dueRaw.slice(10) : v.due;
      out[p.due] = { date: { start } };
    }
  }
  return out;
}

export class Notion implements NotionApi {
  private h: Record<string, string>;
  constructor(private f: Fetcher, private budget: Budget, token: string) {
    this.h = { authorization: `Bearer ${token}`, "notion-version": VERSION };
  }

  async listPages(dsId: string, p: Props, editedSince: number): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    let cursor: string | undefined;
    do {
      const res = await request<any>(this.f, this.budget, `${API}/data_sources/${dsId}/query`, {
        method: "POST",
        headers: this.h,
        json: {
          page_size: 100,
          start_cursor: cursor,
          // 진행 중 항목 + 최근에 고친 항목만 (오래전에 완료된 항목은 빼서 요청 수 절약)
          filter: {
            or: [
              { property: p.done, checkbox: { equals: false } },
              { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(editedSince).toISOString() } },
            ],
          },
        },
      });
      for (const pg of res?.results ?? []) {
        const it = pageToItem(pg, p);
        if (it) out.set(it.id, it);
      }
      cursor = res?.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  async getPage(id: string, p: Props): Promise<Item | null> {
    const res = await request<any>(this.f, this.budget, `${API}/pages/${id}`, { headers: this.h, ok: [200, 404] });
    if (!res || res.object !== "page") return null;
    return pageToItem(res, p);
  }

  async create(dsId: string, p: Props, v: Vals): Promise<string> {
    const res = await request<any>(this.f, this.budget, `${API}/pages`, {
      method: "POST",
      headers: this.h,
      json: { parent: { type: "data_source_id", data_source_id: dsId }, properties: propsFor(p, v, null) },
    });
    return res.id;
  }

  async update(p: Props, page: Item, v: Vals): Promise<void> {
    const properties = propsFor(p, v, page);
    if (Object.keys(properties).length === 0) return;
    await request(this.f, this.budget, `${API}/pages/${page.id}`, { method: "PATCH", headers: this.h, json: { properties } });
  }

  async setParent(p: Props, id: string, parentId: string): Promise<void> {
    await request(this.f, this.budget, `${API}/pages/${id}`, {
      method: "PATCH",
      headers: this.h,
      json: { properties: { [p.parent]: { relation: parentId ? [{ id: parentId }] : [] } } },
    });
  }

  async trash(id: string): Promise<void> {
    await request(this.f, this.budget, `${API}/pages/${id}`, { method: "PATCH", headers: this.h, json: { in_trash: true }, ok: [200, 404] });
  }

  // --- 동기화 기록 페이지: 코드 블록 하나에 JSON ---
  private async stateBlock(pageId: string): Promise<any | null> {
    const res = await request<any>(this.f, this.budget, `${API}/blocks/${pageId}/children`, { headers: this.h, query: { page_size: "100" } });
    return (res?.results ?? []).find((b: any) => b.type === "code") ?? null;
  }

  async loadState(pageId: string): Promise<{ state: any; blockId: string | null }> {
    const b = await this.stateBlock(pageId);
    if (!b) return { state: {}, blockId: null };
    const txt = plain(b.code.rich_text).trim();
    return { state: txt ? JSON.parse(txt) : {}, blockId: b.id };
  }

  async saveState(pageId: string, blockId: string | null, state: unknown): Promise<void> {
    const txt = JSON.stringify(state);
    if (txt.length > 190_000) throw new ApiError("동기화 기록이 너무 커짐");
    const code = { language: "json", rich_text: rich(txt) };
    if (blockId) {
      await request(this.f, this.budget, `${API}/blocks/${blockId}`, { method: "PATCH", headers: this.h, json: { code } });
    } else {
      await request(this.f, this.budget, `${API}/blocks/${pageId}/children`, {
        method: "PATCH",
        headers: this.h,
        json: { children: [{ object: "block", type: "code", code }] },
      });
    }
  }
}
