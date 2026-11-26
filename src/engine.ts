// 동기화 핵심 규칙. 구글/Notion API 와 분리되어 있어서 가짜 데이터로 테스트할 수 있다.
// 목록마다 칸 구성이 달라서, 구글 쪽은 codec 으로 '칸'으로 풀어서(decode) 비교한다.
//
// 정해둔 규칙 (모든 목록 공통)
// - 칸별로 합침: 한쪽만 고치면 그쪽, 같은 칸을 양쪽이 고치면 나중에 고친 쪽
// - 처음 연결 때 제목(titleField)이 같으면 짝, 제목은 Notion 쪽으로
// - 한쪽에서 지우면 반대쪽도 지움 (Notion 은 휴지통). 한 번에 5개 넘게 지우려 하면 멈춤
// - 장부에는 내용 대신 지문(해시)만
// - 무료 플랜 요청 한도 때문에 일이 많으면 나눠서 처리 (나머지는 다음 실행 때)
// TO-DO 전용: 하위 할 일(parentProp), 반복 항목(repeat)

import type { Ctx, Fields, GRaw, GTask, GoogleApi, ListConfig, NPage, NotionApi, Value } from "./types";
import { Budget } from "./http";

export const MAX_DELETES_PER_RUN = 5;
export const RECENT_DONE_WINDOW = 2 * 86400_000; // 짝 없는 '완료' 항목은 최근 2일 것만 새로 연결
export const FETCH_WINDOW = 30 * 86400_000; // 오래전에 완료된 항목은 목록 조회에서 뺌
export const PRUNE_AFTER = 120 * 86400_000; // 양쪽 다 완료된 지 오래된 짝은 장부에서 정리
export const RESERVE = 3; // 장부 저장용으로 남겨둘 요청 수

export class SafetyStop extends Error {}

export type Last = Record<string, Value | number | undefined> & { t?: string; h?: number };
export interface Pair {
  nid: string;
  last: Last | null;
}
export interface ListState {
  initialized?: boolean;
  initialized_at?: string;
  pairs?: Record<string, Pair>;
}

export interface Counts {
  linked: number;
  gCreate: number;
  gUpdate: number;
  gDelete: number;
  nCreate: number;
  nUpdate: number;
  nDelete: number;
  deferred: number;
  gSeen: number;
  nSeen: number;
  gFields: Record<string, number>;
  nFields: Record<string, number>;
}

const FIELD_KO: Record<string, string> = {
  title: "제목", notes: "메모", due: "날짜", done: "완료", parent: "하위",
  item: "품목", store: "구매처", qty: "수량", urgent: "급함", memo: "메모", link: "링크",
};
const fieldsText = (m: Record<string, number>) => {
  const parts = Object.entries(m).filter(([, v]) => v > 0).map(([k, v]) => `${FIELD_KO[k] ?? k} ${v}`);
  return parts.length ? `(${parts.join("·")})` : "";
};

export function summary(c: Counts): string {
  return (
    `짝 ${c.linked}개 | 구글: 새로 ${c.gCreate}, 수정 ${c.gUpdate}${fieldsText(c.gFields)}, 삭제 ${c.gDelete} | ` +
    `Notion: 새로 ${c.nCreate}, 수정 ${c.nUpdate}${fieldsText(c.nFields)}, 휴지통 ${c.nDelete}` +
    (c.deferred ? ` | 다음 실행으로 미룸 ${c.deferred}` : "") +
    ` | 확인한 항목: 구글 ${c.gSeen}·Notion ${c.nSeen}`
  );
}

async function sha16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** 장부용 지문: 완료 여부·부모 ID 는 그대로, 나머지는 해시 */
export async function fp(name: string, v: Value): Promise<Value> {
  return typeof v === "boolean" || name === "parent" ? v : sha16(String(v));
}

/** 예전 장부(내용이 그대로 적힌 형식)를 지문 형식으로 바꾼다. (TO-DO 초기 장부용) */
export async function migrateLast(last: Last | null): Promise<Last | null> {
  if (!last || last.h) return last;
  const out: Last = { h: 1, t: last.t };
  for (const [k, v] of Object.entries(last)) {
    if (k === "t" || k === "h") continue;
    out[k] = await fp(k, (v ?? "") as Value);
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();
const RAW_KEYS = ["title", "notes", "due", "done"] as const;

export async function syncList(opts: {
  cfg: ListConfig;
  g: GoogleApi;
  n: NotionApi;
  budget: Budget;
  gList: string;
  dsId: string;
  st: ListState;
  now: number;
  dryRun: boolean;
  ctx?: Ctx;
}): Promise<Counts> {
  const { cfg, g, n, budget, gList, dsId, st, now, dryRun } = opts;
  const ctx: Ctx = opts.ctx ?? { stores: [] };
  const c: Counts = { linked: 0, gCreate: 0, gUpdate: 0, gDelete: 0, nCreate: 0, nUpdate: 0, nDelete: 0, deferred: 0, gSeen: 0, nSeen: 0, gFields: {}, nFields: {} };
  const bump = (m: Record<string, number>, ks: string[]) => ks.forEach((k) => (m[k] = (m[k] ?? 0) + 1));
  const can = (k: number) => budget.left() - RESERVE >= k;
  const initializedAt = st.initialized_at ? Date.parse(st.initialized_at) : now;
  st.initialized_at ??= iso(initializedAt);
  const pairs: Record<string, Pair> = (st.pairs ??= {});
  const firstRun = !st.initialized;
  const T = cfg.titleField;
  const names = [...cfg.fields.map((f) => f.name), ...(cfg.parentProp ? ["parent"] : [])];
  const dataNames = cfg.fields.map((f) => f.name);

  for (const pr of Object.values(pairs)) pr.last = await migrateLast(pr.last);

  const G = await g.listTasks(gList, now - FETCH_WINDOW);
  const N = await n.listPages(dsId, cfg, now - FETCH_WINDOW);
  const liveG = new Map([...G].filter(([, t]) => !t.gone));
  c.gSeen = liveG.size;
  c.nSeen = N.size;

  const decode = (t: GTask): Fields => cfg.codec.decode(t, ctx);
  // 반복 항목은 'Next Due' 를 날짜로 본다
  const nFields = (p: NPage): Fields => {
    const f = { ...p.f };
    if (cfg.repeat && p.repeat) f[cfg.repeat.field] = p.nextDue || f[cfg.repeat.field];
    return f;
  };

  // --- 안전장치: 진행 중인 짝이 있는데 한쪽이 통째로 비어 보이면 멈춤 ---
  const activePairs = Object.values(pairs).filter((pr) => !pr.last?.done).length;
  if (activePairs > 0 && (liveG.size === 0 || N.size === 0)) {
    throw new SafetyStop(`한쪽 목록이 비어 보여서 멈춤 (구글 ${liveG.size}개·Notion ${N.size}개 보임)`);
  }

  // --- 1) 짝 상태 확인: 한쪽이 안 보이면 지워진 건지, 오래돼서 조회에서 빠진 건지 가린다 ---
  const delG: string[] = [];
  const delN: { gid: string; nid: string }[] = [];
  const drop: string[] = [];
  const skip = new Set<string>();
  for (const [gid, pr] of Object.entries(pairs)) {
    const inG = liveG.has(gid);
    const inN = N.has(pr.nid);
    if (inG && inN) continue;
    const lastDone = Boolean(pr.last?.done);
    let gs: "have" | "gone" | "unknown" = inG ? "have" : G.get(gid)?.gone ? "gone" : lastDone ? "unknown" : "gone";
    let ns: "have" | "gone" | "unknown" = inN ? "have" : lastDone ? "unknown" : "gone";
    if (gs === "unknown" && ns === "have" && can(1)) {
      const t = await g.getTask(gList, gid);
      if (t && !t.gone) {
        liveG.set(gid, t);
        gs = "have";
      } else gs = "gone";
    }
    if (ns === "unknown" && gs === "have" && can(1)) {
      const pg = await n.getPage(pr.nid, cfg);
      if (pg) {
        N.set(pg.id, pg);
        ns = "have";
      } else ns = "gone";
    }
    if (gs === "have" && ns === "have") continue;
    if (gs === "unknown" || ns === "unknown") {
      skip.add(gid);
      continue;
    }
    if (gs === "gone" && ns === "gone") drop.push(gid);
    else if (gs === "gone") delN.push({ gid, nid: pr.nid });
    else delG.push(gid);
  }
  if (delG.length + delN.length > MAX_DELETES_PER_RUN) {
    throw new SafetyStop(
      `한 번에 ${delG.length + delN.length}개를 지우려 해서 멈춤 (한도 ${MAX_DELETES_PER_RUN}개) — ` +
        `구글에서 사라져 보이는 것 ${delN.length}개, Notion에서 사라져 보이는 것 ${delG.length}개 ` +
        `(구글 ${liveG.size}개·Notion ${N.size}개 보임)`,
    );
  }
  for (const gid of drop) delete pairs[gid];

  // --- 2) 삭제 실행 ---
  for (const gid of delG) {
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    if (!dryRun) await g.remove(gList, gid);
    liveG.delete(gid);
    delete pairs[gid];
    c.gDelete++;
  }
  for (const { gid, nid } of delN) {
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    if (!dryRun) await n.trash(nid);
    N.delete(nid);
    delete pairs[gid];
    c.nDelete++;
  }

  // --- 3) 처음 실행: 진행 중 항목끼리 제목으로 짝짓기 ---
  const linkedN = new Set(Object.values(pairs).map((pr) => pr.nid));
  const mode = new Map<string, "normal" | "init" | "fromG" | "fromN">();
  if (firstRun) {
    const byTitle = new Map<string, string[]>();
    for (const [nid, p] of N) {
      const t = String(p.f[T] ?? "");
      if (!p.f.done && t && !linkedN.has(nid)) byTitle.set(t, [...(byTitle.get(t) ?? []), nid]);
    }
    for (const [gid, t] of liveG) {
      if (pairs[gid] || t.done) continue;
      const title = String(decode(t)[T] ?? "");
      if (!title) continue;
      const nid = byTitle.get(title)?.shift();
      if (nid) {
        pairs[gid] = { nid, last: null };
        linkedN.add(nid);
        mode.set(gid, "init");
      }
    }
  }

  // --- 4) 짝 없는 새 항목 → 반대쪽에 만들기 ---
  const cutoff = Math.max(initializedAt, now - RECENT_DONE_WINDOW);
  const shouldLink = (title: Value | undefined, done: boolean, at: number | undefined) =>
    Boolean(title) && (!done || (at !== undefined && at >= cutoff));

  for (const [gid, t] of [...liveG]) {
    if (pairs[gid]) continue;
    const f = decode(t);
    if (!shouldLink(f[T], t.done, t.doneAt ?? t.updated)) continue;
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    const nid = dryRun ? `dry-n-${gid}` : await n.create(dsId, cfg, f);
    const dateRaw: Record<string, string | null> = {};
    for (const s of cfg.fields) if (s.type === "date") dateRaw[s.name] = (f[s.name] as string) || null;
    N.set(nid, { id: nid, f, parentRaw: "", updated: now, created: now, dateRaw });
    pairs[gid] = { nid, last: null };
    linkedN.add(nid);
    mode.set(gid, "fromG");
    c.nCreate++;
  }
  for (const [nid, p] of [...N]) {
    if (linkedN.has(nid) || !shouldLink(p.f[T], Boolean(p.f.done), p.created)) continue;
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    const raw = cfg.codec.encode(nFields(p), ctx);
    const gid = dryRun ? `dry-g-${nid}` : await g.create(gList, raw);
    liveG.set(gid, { id: gid, due: "", ...raw, parentRaw: "", updated: now });
    pairs[gid] = { nid, last: null };
    linkedN.add(nid);
    mode.set(gid, "fromN");
    c.gCreate++;
  }

  // --- 5) 칸별로 합치기 + 하위 할 일 맞추기 ---
  const nToG = new Map(Object.entries(pairs).map(([gid, pr]) => [pr.nid, gid]));
  const topAncestor = (nid: string): string => {
    // Notion 은 여러 단계 하위가 가능하지만 구글은 1단계뿐 → 최상위 조상으로
    let cur = N.get(nid)?.parentRaw ?? "";
    let top = "";
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      top = cur;
      cur = N.get(cur)?.parentRaw ?? "";
    }
    return top;
  };

  for (const [gid, pr] of Object.entries(pairs)) {
    if (skip.has(gid)) continue;
    const gt = liveG.get(gid);
    const nt = N.get(pr.nid);
    if (!gt || !nt) continue; // 오래된 완료 짝 (조회에서 빠짐) → 할 일 없음
    const last = pr.last;
    const m = mode.get(gid) ?? "normal";
    const gv: Fields = decode(gt);
    const nv: Fields = nFields(nt);
    if (cfg.parentProp) {
      gv.parent = gt.parentRaw && pairs[gt.parentRaw] ? gt.parentRaw : "";
      const top = topAncestor(nt.id);
      nv.parent = top ? nToG.get(top) ?? "" : "";
    }
    const gNewer = gt.updated > nt.updated;
    const repeatField = cfg.repeat && nt.repeat ? cfg.repeat.field : null;

    const nw: Fields = {};
    for (const f of names) {
      const a = gv[f] ?? "";
      const b = nv[f] ?? "";
      if (a === b) nw[f] = a;
      else if (f === repeatField) nw[f] = b; // 반복 항목 날짜는 Notion 기준
      else if (m === "fromG") nw[f] = a;
      else if (m === "fromN") nw[f] = b;
      else if (m === "init") {
        if (f === T) nw[f] = b; // 처음 연결 시 Notion 제목으로 통일
        else if (a === "" || a === false || b === "" || b === false) nw[f] = a || b;
        else nw[f] = gNewer ? a : b;
      } else if (last && (await fp(f, a)) === last[f]) nw[f] = b; // Notion 쪽만 바뀜
      else if (last && (await fp(f, b)) === last[f]) nw[f] = a; // 구글 쪽만 바뀜
      else nw[f] = gNewer ? a : b; // 둘 다 바뀜 → 나중에 고친 쪽
    }

    // 구글: 칸이 하나라도 달라졌으면 제목·세부정보를 다시 만들어서 바뀐 부분만 보냄
    const gChanged = dataNames.filter((f) => (gv[f] ?? "") !== nw[f]);
    const gPatch: Partial<GRaw> = {};
    const want = cfg.codec.encode(nw, ctx);
    if (gChanged.length) {
      for (const k of RAW_KEYS) if (want[k] !== undefined && gt[k] !== want[k]) (gPatch as any)[k] = want[k];
    } else if (gt.title !== want.title) {
      // 내용은 같지만 구글 제목 모양만 다를 때 (예: '엔플' → '네이버', '생수!' → '생수 !') 한 번 정리
      gPatch.title = want.title;
    }
    const nPatch: Fields = {};
    for (const f of dataNames) if ((nv[f] ?? "") !== nw[f] && f !== repeatField) nPatch[f] = nw[f];
    const gParent = Boolean(cfg.parentProp) && gv.parent !== nw.parent;
    const nParent = Boolean(cfg.parentProp) && nv.parent !== nw.parent;
    const hasG = Object.keys(gPatch).length > 0;
    const hasN = Object.keys(nPatch).length > 0;
    const cost = (hasG ? 1 : 0) + (hasN ? 1 : 0) + (gParent ? 1 : 0) + (nParent ? 1 : 0);
    if (!can(cost)) {
      c.deferred++;
      continue; // 장부를 안 바꿨으니 다음 실행 때 다시 처리
    }
    if (hasG) bump(c.gFields, gChanged);
    if (hasN) bump(c.nFields, Object.keys(nPatch));
    if (gParent) bump(c.gFields, ["parent"]);
    if (nParent) bump(c.nFields, ["parent"]);
    if (hasG) {
      c.gUpdate++;
      if (!dryRun) await g.update(gList, gid, gPatch);
    }
    if (hasN) {
      c.nUpdate++;
      if (!dryRun) await n.update(cfg, nt, nPatch);
    }
    if (gParent) {
      c.gUpdate++;
      if (!dryRun) await g.move(gList, gid, String(nw.parent));
    }
    if (nParent) {
      c.nUpdate++;
      if (!dryRun) await n.setParent(cfg, pr.nid, nw.parent ? pairs[String(nw.parent)].nid : "");
    }

    const newFp: Last = {};
    for (const f of names) newFp[f] = await fp(f, nw[f]);
    const changed = !last || names.some((f) => last[f] !== newFp[f]);
    pr.last = { ...newFp, h: 1, t: changed || !last?.t ? iso(now) : last.t };
  }

  // --- 6) 오래된 완료 짝 정리 ---
  for (const [gid, pr] of Object.entries(pairs)) {
    const t = pr.last?.t ? Date.parse(pr.last.t) : NaN;
    if (pr.last?.done && now - t > PRUNE_AFTER) delete pairs[gid];
  }

  st.initialized = true;
  c.linked = Object.keys(pairs).length;
  return c;
}
