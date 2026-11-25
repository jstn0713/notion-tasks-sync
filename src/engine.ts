// 동기화 핵심 규칙. 구글/Notion API 와 분리되어 있어서 가짜 데이터로 테스트할 수 있다.
//
// 정해둔 규칙
// - 칸: 제목·메모·날짜·완료·하위 할 일(부모)
// - 양쪽이 같은 칸을 고치면 나중에 고친 쪽, 한쪽만 고치면 그쪽
// - 처음 연결 때 제목이 같으면 짝, 제목은 Notion 쪽으로
// - 반복 항목(Notion Frequency 가 있음)은 'Next Due' 를 구글 날짜로 보내고, 날짜는 Notion 기준
// - 한쪽에서 지우면 반대쪽도 지움 (Notion 은 휴지통). 한 번에 5개 넘게 지우려 하면 멈춤
// - 장부에는 내용 대신 지문(해시)만
// - 무료 플랜 요청 한도 때문에 일이 많으면 나눠서 처리 (나머지는 다음 실행 때)

import type { GoogleApi, Item, ListConfig, NotionApi, Vals } from "./types";
import { Budget } from "./http";

export const MAX_DELETES_PER_RUN = 5;
export const RECENT_DONE_WINDOW = 2 * 86400_000; // 짝 없는 '완료' 항목은 최근 2일 것만 새로 연결
export const FETCH_WINDOW = 30 * 86400_000; // 오래전에 완료된 항목은 목록 조회에서 뺌
export const PRUNE_AFTER = 120 * 86400_000; // 양쪽 다 완료된 지 오래된 짝은 장부에서 정리
export const RESERVE = 3; // 장부 저장용으로 남겨둘 요청 수

const FIELDS = ["title", "notes", "due", "done", "parent"] as const;
type Field = (typeof FIELDS)[number];
const HASHED: Field[] = ["title", "notes", "due"];

export class SafetyStop extends Error {}

export interface Last {
  title?: string;
  notes?: string;
  due?: string;
  done?: boolean;
  parent?: string;
  t?: string;
  h?: number;
}
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
}

export function summary(c: Counts): string {
  return (
    `짝 ${c.linked}개 | 구글: 새로 ${c.gCreate}, 수정 ${c.gUpdate}, 삭제 ${c.gDelete} | ` +
    `Notion: 새로 ${c.nCreate}, 수정 ${c.nUpdate}, 휴지통 ${c.nDelete}` +
    (c.deferred ? ` | 다음 실행으로 미룸 ${c.deferred}` : "") +
    ` | 확인한 항목: 구글 ${c.gSeen}·Notion ${c.nSeen}`
  );
}

async function sha16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function fp(f: Field, v: string | boolean): Promise<string | boolean> {
  return HASHED.includes(f) ? sha16(String(v)) : v;
}

/** 예전 장부(내용이 그대로 적힌 형식)를 지문 형식으로 바꾼다. */
export async function migrateLast(last: Last | null): Promise<Last | null> {
  if (!last || last.h) return last;
  return {
    title: (await fp("title", last.title ?? "")) as string,
    notes: (await fp("notes", last.notes ?? "")) as string,
    due: (await fp("due", last.due ?? "")) as string,
    done: last.done,
    parent: last.parent ?? "",
    t: last.t,
    h: 1,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

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
}): Promise<Counts> {
  const { cfg, g, n, budget, gList, dsId, st, now, dryRun } = opts;
  const p = cfg.props;
  const c: Counts = { linked: 0, gCreate: 0, gUpdate: 0, gDelete: 0, nCreate: 0, nUpdate: 0, nDelete: 0, deferred: 0, gSeen: 0, nSeen: 0 };
  const can = (k: number) => budget.left() - RESERVE >= k;
  const initializedAt = st.initialized_at ? Date.parse(st.initialized_at) : now;
  st.initialized_at ??= iso(initializedAt);
  const pairs: Record<string, Pair> = (st.pairs ??= {});
  const firstRun = !st.initialized;

  for (const pr of Object.values(pairs)) pr.last = await migrateLast(pr.last);

  const G = await g.listTasks(gList, now - FETCH_WINDOW);
  const N = await n.listPages(dsId, p, now - FETCH_WINDOW);
  const liveG = new Map([...G].filter(([, t]) => !t.gone));
  c.gSeen = liveG.size;
  c.nSeen = N.size;

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
    if (gs === "unknown" && ns === "have") {
      if (!can(1)) gs = "unknown";
      else {
        const t = await g.getTask(gList, gid);
        if (t && !t.gone) {
          liveG.set(gid, t);
          gs = "have";
        } else gs = "gone";
      }
    }
    if (ns === "unknown" && gs === "have") {
      if (can(1)) {
        const pg = await n.getPage(pr.nid, p);
        if (pg) {
          N.set(pg.id, pg);
          ns = "have";
        } else ns = "gone";
      }
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
    for (const [nid, it] of N) {
      if (!it.done && it.title && !linkedN.has(nid)) byTitle.set(it.title, [...(byTitle.get(it.title) ?? []), nid]);
    }
    for (const [gid, t] of liveG) {
      if (pairs[gid] || t.done || !t.title) continue;
      const cands = byTitle.get(t.title);
      const nid = cands?.shift();
      if (nid) {
        pairs[gid] = { nid, last: null };
        linkedN.add(nid);
        mode.set(gid, "init");
      }
    }
  }

  // --- 4) 짝 없는 새 항목 → 반대쪽에 만들기 ---
  const cutoff = Math.max(initializedAt, now - RECENT_DONE_WINDOW);
  const shouldLink = (it: Item, at: number | undefined) => Boolean(it.title) && (!it.done || (at !== undefined && at >= cutoff));
  const nDue = (it: Item) => (it.repeat ? it.nextDue || it.due : it.due);

  for (const [gid, t] of [...liveG]) {
    if (pairs[gid] || !shouldLink(t, t.doneAt ?? t.updated)) continue;
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    const v: Vals = { title: t.title, notes: t.notes, due: t.due, done: t.done };
    const nid = dryRun ? `dry-n-${gid}` : await n.create(dsId, p, v);
    N.set(nid, { id: nid, title: t.title, notes: t.notes, due: t.due, done: t.done, parentRaw: "", updated: now, created: now, dueRaw: t.due || null });
    pairs[gid] = { nid, last: null };
    linkedN.add(nid);
    mode.set(gid, "fromG");
    c.nCreate++;
  }
  for (const [nid, it] of [...N]) {
    if (linkedN.has(nid) || !shouldLink(it, it.created)) continue;
    if (!can(1)) {
      c.deferred++;
      continue;
    }
    const v: Vals = { title: it.title, notes: it.notes, due: nDue(it), done: it.done };
    const gid = dryRun ? `dry-g-${nid}` : await g.create(gList, v);
    liveG.set(gid, { id: gid, title: it.title, notes: it.notes, due: nDue(it), done: it.done, parentRaw: "", updated: now });
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
    const gv = { title: gt.title, notes: gt.notes, due: gt.due, done: gt.done, parent: gt.parentRaw && pairs[gt.parentRaw] ? gt.parentRaw : "" };
    const top = topAncestor(nt.id);
    const nv = { title: nt.title, notes: nt.notes, due: nDue(nt), done: nt.done, parent: top ? nToG.get(top) ?? "" : "" };
    const gNewer = gt.updated > nt.updated;

    const nw: Record<Field, any> = { ...gv };
    for (const f of FIELDS) {
      const a = gv[f];
      const b = nv[f];
      if (a === b) nw[f] = a;
      else if (f === "due" && nt.repeat) nw[f] = b; // 반복 항목 날짜는 Notion 기준
      else if (m === "fromG") nw[f] = a;
      else if (m === "fromN") nw[f] = b;
      else if (m === "init") {
        if (f === "title") nw[f] = b; // 처음 연결 시 Notion 제목으로 통일
        else if (a === "" || a === false || b === "" || b === false) nw[f] = a || b;
        else nw[f] = gNewer ? a : b;
      } else if (last && (await fp(f, a)) === last[f]) nw[f] = b; // Notion 쪽만 바뀜
      else if (last && (await fp(f, b)) === last[f]) nw[f] = a; // 구글 쪽만 바뀜
      else nw[f] = gNewer ? a : b; // 둘 다 바뀜 → 나중에 고친 쪽
    }

    const gPatch: Vals = {};
    const nPatch: Vals = {};
    for (const f of ["title", "notes", "due", "done"] as const) {
      if (gv[f] !== nw[f]) (gPatch as any)[f] = nw[f];
      if (nv[f] !== nw[f]) (nPatch as any)[f] = nw[f];
    }
    if (nt.repeat) delete nPatch.due; // 반복 항목의 Notion 날짜는 건드리지 않음
    const gParent = gv.parent !== nw.parent;
    const nParent = nv.parent !== nw.parent;
    const cost = (Object.keys(gPatch).length ? 1 : 0) + (Object.keys(nPatch).length ? 1 : 0) + (gParent ? 1 : 0) + (nParent ? 1 : 0);
    if (!can(cost)) {
      c.deferred++;
      continue; // 장부를 안 바꿨으니 다음 실행 때 다시 처리
    }
    if (Object.keys(gPatch).length) {
      c.gUpdate++;
      if (!dryRun) await g.update(gList, gid, gPatch);
    }
    if (Object.keys(nPatch).length) {
      c.nUpdate++;
      if (!dryRun) await n.update(p, nt, nPatch);
    }
    if (gParent) {
      c.gUpdate++;
      if (!dryRun) await g.move(gList, gid, nw.parent);
    }
    if (nParent) {
      c.nUpdate++;
      if (!dryRun) await n.setParent(p, pr.nid, nw.parent ? pairs[nw.parent].nid : "");
    }

    const newFp: Last = {};
    for (const f of FIELDS) (newFp as any)[f] = await fp(f, nw[f]);
    const changed = !last || FIELDS.some((f) => last[f] !== newFp[f]);
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
