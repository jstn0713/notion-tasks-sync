// Notion API (데이터베이스 항목 + '동기화 기록' 페이지).
// 칸 구성은 목록 설정(ListConfig.fields)을 따른다.
import { ApiError, Budget, Fetcher, request } from "./http";
import type { Fields, ListConfig, NPage, NotionApi, Value } from "./types";

const API = "https://api.notion.com/v1";
const VERSION = "2025-09-03";

const plain = (rich: any[] | undefined) => (rich ?? []).map((x) => x.plain_text ?? "").join("");
const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

export function rich(text: string): any[] {
  const out: any[] = [];
  for (let i = 0; i < text.length; i += 2000) out.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  return out;
}

const doneSpec = (cfg: ListConfig) => cfg.fields.find((f) => f.name === "done")!;

/** 진행 중(완료 아님) 항목만 고르는 Notion 조회 조건 */
function notDoneFilters(cfg: ListConfig): any[] {
  const d = doneSpec(cfg);
  if (d.type === "stage") return [{ property: d.notion, select: { equals: d.idea } }, { property: d.notion, select: { is_empty: true } }];
  return [{ property: d.notion, checkbox: { equals: false } }];
}

export function pageToItem(pg: any, cfg: ListConfig): NPage | null {
  if (pg.in_trash || pg.archived) return null;
  const pr = pg.properties ?? {};
  const f: Fields = {};
  const dateRaw: Record<string, string | null> = {};
  for (const spec of cfg.fields) {
    const p = pr[spec.notion];
    switch (spec.type) {
      case "title":
        f[spec.name] = norm(plain(p?.title));
        break;
      case "rich_text":
        f[spec.name] = norm(plain(p?.rich_text));
        break;
      case "checkbox":
        f[spec.name] = Boolean(p?.checkbox);
        break;
      case "date":
        dateRaw[spec.name] = p?.date?.start ?? null;
        f[spec.name] = (p?.date?.start ?? "").slice(0, 10);
        break;
      case "select":
        f[spec.name] = p?.select?.name ?? "";
        break;
      case "number":
        f[spec.name] = typeof p?.number === "number" ? String(p.number) : "";
        break;
      case "url":
        f[spec.name] = (p?.url ?? "").trim();
        break;
      case "stage": {
        const s = p?.select?.name ?? "";
        f[spec.name] = s !== "" && s !== spec.idea;
        break;
      }
    }
  }
  let repeat = false;
  let nextDue = "";
  if (cfg.repeat) {
    repeat = plain(pr[cfg.repeat.frequencyProp]?.rich_text).trim().length > 0;
    const fm = pr[cfg.repeat.nextDueProp]?.formula;
    if (fm?.type === "date" && fm.date?.start) nextDue = String(fm.date.start).slice(0, 10);
    else if (fm?.type === "string" && fm.string) nextDue = String(fm.string).slice(0, 10);
  }
  const rel = cfg.parentProp ? pr[cfg.parentProp]?.relation ?? [] : [];
  return {
    id: pg.id,
    f,
    parentRaw: rel[0]?.id ?? "",
    updated: Date.parse(pg.last_edited_time),
    created: Date.parse(pg.created_time),
    dateRaw,
    repeat,
    nextDue,
  };
}

export function propsFor(cfg: ListConfig, vals: Fields, old: NPage | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of cfg.fields) {
    if (!(spec.name in vals)) continue;
    const v: Value = vals[spec.name];
    const s = typeof v === "string" ? v : "";
    switch (spec.type) {
      case "title":
        out[spec.notion] = { title: rich(s) };
        break;
      case "rich_text":
        out[spec.notion] = { rich_text: rich(s) };
        break;
      case "checkbox":
        out[spec.notion] = { checkbox: Boolean(v) };
        break;
      case "date": {
        if (!s) out[spec.notion] = { date: null };
        else {
          // Notion 에 시간이 들어 있었다면 시간은 그대로 두고 날짜만 바꾼다
          const raw = old?.dateRaw[spec.name];
          out[spec.notion] = { date: { start: raw && raw.length > 10 ? s + raw.slice(10) : s } };
        }
        break;
      }
      case "select":
        out[spec.notion] = { select: s ? { name: s } : null };
        break;
      case "number":
        out[spec.notion] = { number: s === "" ? null : Number(s) };
        break;
      case "url":
        out[spec.notion] = { url: s || null };
        break;
      case "stage":
        out[spec.notion] = { select: { name: v ? spec.started : spec.idea } };
        break;
    }
  }
  return out;
}

export class Notion implements NotionApi {
  private h: Record<string, string>;
  constructor(private f: Fetcher, private budget: Budget, token: string) {
    this.h = { authorization: `Bearer ${token}`, "notion-version": VERSION };
  }

  async selectOptions(dsId: string, prop: string): Promise<string[]> {
    const res = await request<any>(this.f, this.budget, `${API}/data_sources/${dsId}`, { headers: this.h });
    const p = res?.properties?.[prop];
    return (p?.select?.options ?? []).map((o: any) => String(o.name));
  }

  async listPages(dsId: string, cfg: ListConfig, editedSince: number): Promise<Map<string, NPage>> {
    const out = new Map<string, NPage>();
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
              ...notDoneFilters(cfg),
              { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(editedSince).toISOString() } },
            ],
          },
        },
      });
      for (const pg of res?.results ?? []) {
        const it = pageToItem(pg, cfg);
        if (it) out.set(it.id, it);
      }
      cursor = res?.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  async getPage(id: string, cfg: ListConfig): Promise<NPage | null> {
    const res = await request<any>(this.f, this.budget, `${API}/pages/${id}`, { headers: this.h, ok: [200, 404] });
    if (!res || res.object !== "page") return null;
    return pageToItem(res, cfg);
  }

  async create(dsId: string, cfg: ListConfig, vals: Fields): Promise<string> {
    const res = await request<any>(this.f, this.budget, `${API}/pages`, {
      method: "POST",
      once: true,
      headers: this.h,
      json: { parent: { type: "data_source_id", data_source_id: dsId }, properties: propsFor(cfg, vals, null) },
    });
    return res.id;
  }

  async update(cfg: ListConfig, page: NPage, vals: Fields): Promise<void> {
    const properties = propsFor(cfg, vals, page);
    if (Object.keys(properties).length === 0) return;
    await request(this.f, this.budget, `${API}/pages/${page.id}`, { method: "PATCH", headers: this.h, json: { properties } });
  }

  async setParent(cfg: ListConfig, id: string, parentId: string): Promise<void> {
    if (!cfg.parentProp) return;
    await request(this.f, this.budget, `${API}/pages/${id}`, {
      method: "PATCH",
      headers: this.h,
      json: { properties: { [cfg.parentProp]: { relation: parentId ? [{ id: parentId }] : [] } } },
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
        once: true,
        headers: this.h,
        json: { children: [{ object: "block", type: "code", code }] },
      });
    }
  }
}
