// 가짜 구글/Notion 으로 동기화 규칙을 검사한다.
import { beforeEach, describe, expect, it } from "vitest";
import { Budget } from "../src/http";
import { FETCH_WINDOW, SafetyStop, syncList, type ListState } from "../src/engine";
import { LISTS } from "../src/index";
import type { GoogleApi, Item, NotionApi, Props, Vals } from "../src/types";

const CFG = LISTS[0];
const MIN = 60_000;
const T0 = Date.parse("2026-11-25T10:00:00Z");
let seq = 1;

class FakeGoogle implements GoogleApi {
  t = new Map<string, Item>();
  calls = 0;
  clock = T0;
  budget = new Budget(10_000);
  add(title: string, kw: Partial<Item> = {}) {
    const id = `g${seq++}`;
    this.t.set(id, { id, title, notes: "", due: "", done: false, parentRaw: "", updated: T0 - 86400_000, ...kw });
    return id;
  }
  async findList() {
    return "L";
  }
  async listTasks(_l: string, completedMin: number) {
    this.budget.take();
    const out = new Map<string, Item>();
    for (const [k, v] of this.t) if (!(v.done && (v.doneAt ?? 0) < completedMin)) out.set(k, { ...v });
    return out;
  }
  async getTask(_l: string, id: string) {
    this.budget.take();
    const v = this.t.get(id);
    return v ? { ...v } : null;
  }
  async create(_l: string, v: Vals) {
    this.budget.take();
    this.calls++;
    const id = `g${seq++}`;
    this.t.set(id, { id, title: v.title ?? "", notes: v.notes ?? "", due: v.due ?? "", done: !!v.done, parentRaw: "", updated: this.clock, doneAt: v.done ? this.clock : undefined });
    return id;
  }
  async update(_l: string, id: string, v: Vals) {
    this.budget.take();
    this.calls++;
    const it = this.t.get(id)!;
    Object.assign(it, v, { updated: this.clock });
    if (v.done) it.doneAt = this.clock;
  }
  async move(_l: string, id: string, parent: string) {
    this.budget.take();
    this.calls++;
    Object.assign(this.t.get(id)!, { parentRaw: parent, updated: this.clock });
  }
  async remove(_l: string, id: string) {
    this.budget.take();
    this.calls++;
    this.t.get(id)!.gone = true;
  }
}

class FakeNotion implements NotionApi {
  p = new Map<string, Item>();
  trashed = new Set<string>();
  calls = 0;
  clock = T0;
  budget = new Budget(10_000);
  add(title: string, kw: Partial<Item> = {}) {
    const id = `n${seq++}`;
    this.p.set(id, { id, title, notes: "", due: "", done: false, parentRaw: "", updated: T0 - 86400_000, created: T0 - 86400_000, dueRaw: null, ...kw });
    return id;
  }
  async listPages(_ds: string, _p: Props, since: number) {
    this.budget.take();
    const out = new Map<string, Item>();
    for (const [k, v] of this.p) if (!this.trashed.has(k) && (!v.done || v.updated >= since)) out.set(k, { ...v });
    return out;
  }
  async getPage(id: string) {
    this.budget.take();
    const v = this.p.get(id);
    return v && !this.trashed.has(id) ? { ...v } : null;
  }
  async create(_ds: string, _p: Props, v: Vals) {
    this.budget.take();
    this.calls++;
    const id = `n${seq++}`;
    this.p.set(id, { id, title: v.title ?? "", notes: v.notes ?? "", due: v.due ?? "", done: !!v.done, parentRaw: "", updated: this.clock, created: this.clock, dueRaw: v.due || null });
    return id;
  }
  async update(_p: Props, page: Item, v: Vals) {
    this.budget.take();
    this.calls++;
    const it = this.p.get(page.id)!;
    if (v.due !== undefined) it.dueRaw = v.due && it.dueRaw && it.dueRaw.length > 10 ? v.due + it.dueRaw.slice(10) : v.due || null;
    Object.assign(it, v, { updated: this.clock });
  }
  async setParent(_p: Props, id: string, parent: string) {
    this.budget.take();
    this.calls++;
    Object.assign(this.p.get(id)!, { parentRaw: parent, updated: this.clock });
  }
  async trash(id: string) {
    this.budget.take();
    this.calls++;
    this.trashed.add(id);
  }
}

let G: FakeGoogle;
let N: FakeNotion;
let st: ListState;
let ids: Record<string, string>;

async function run(now: number, opts: { dry?: boolean; budget?: Budget } = {}) {
  G.clock = N.clock = now;
  const budget = opts.budget ?? new Budget(10_000);
  G.budget = N.budget = budget;
  return syncList({ cfg: CFG, g: G, n: N, budget, gList: "L", dsId: "DS", st, now, dryRun: !!opts.dry });
}
const nidOf = (gid: string) => st.pairs![gid].nid;
const gidOf = (nid: string) => Object.entries(st.pairs!).find(([, p]) => p.nid === nid)![0];

beforeEach(async () => {
  G = new FakeGoogle();
  N = new FakeNotion();
  st = {};
  ids = {
    a: G.add("보수교육"),
    b: G.add("같은제목"),
    oldDone: G.add("옛날완료", { done: true, doneAt: T0 - 40 * 86400_000 }),
    nSame: N.add("같은제목", { notes: "노션메모" }),
    nOnly: N.add("노션에만"),
    nOldDone: N.add("테스트", { done: true }),
    nBlank: N.add(""),
  };
  await run(T0);
});

describe("처음 연결", () => {
  it("같은 제목끼리 짝, 빈 칸은 채우고, 옛 완료·빈 제목은 무시", () => {
    expect(nidOf(ids.b)).toBe(ids.nSame);
    expect(G.t.get(ids.b)!.notes).toBe("노션메모");
    expect(N.p.get(nidOf(ids.a))!.title).toBe("보수교육");
    expect(st.pairs![ids.oldDone]).toBeUndefined();
    const linked = new Set(Object.values(st.pairs!).map((p) => p.nid));
    expect(linked.has(ids.nOnly)).toBe(true);
    expect(linked.has(ids.nOldDone)).toBe(false);
    expect(linked.has(ids.nBlank)).toBe(false);
    expect(Object.keys(st.pairs!).length).toBe(3);
  });
  it("장부에 할 일 내용이 남지 않음", () => {
    const blob = JSON.stringify(st);
    for (const w of ["보수교육", "같은제목", "노션메모", "노션에만"]) expect(blob).not.toContain(w);
  });
});

describe("평소 동기화", () => {
  it("바뀐 게 없으면 아무것도 안 함", async () => {
    G.calls = N.calls = 0;
    const c = await run(T0 + 5 * MIN);
    expect(G.calls + N.calls).toBe(0);
    expect(c.gUpdate + c.nUpdate + c.gCreate + c.nCreate).toBe(0);
  });
  it("구글에서 완료 → Notion 완료", async () => {
    Object.assign(G.t.get(ids.a)!, { done: true, doneAt: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(N.p.get(nidOf(ids.a))!.done).toBe(true);
  });
  it("양쪽에서 다른 칸을 고치면 둘 다 반영", async () => {
    const nid = nidOf(ids.b);
    Object.assign(N.p.get(nid)!, { title: "노션에서 고친 제목", updated: T0 + 2 * MIN });
    Object.assign(G.t.get(ids.b)!, { notes: "구글에서 고친 메모", updated: T0 + 3 * MIN });
    await run(T0 + 5 * MIN);
    for (const it of [G.t.get(ids.b)!, N.p.get(nid)!]) {
      expect(it.title).toBe("노션에서 고친 제목");
      expect(it.notes).toBe("구글에서 고친 메모");
    }
  });
  it("같은 칸을 양쪽에서 고치면 나중에 고친 쪽", async () => {
    const nid = nidOf(ids.b);
    Object.assign(N.p.get(nid)!, { title: "노션판", updated: T0 + 2 * MIN });
    Object.assign(G.t.get(ids.b)!, { title: "구글판", updated: T0 + 4 * MIN });
    await run(T0 + 5 * MIN);
    expect(N.p.get(nid)!.title).toBe("구글판");
    expect(G.t.get(ids.b)!.title).toBe("구글판");
  });
  it("Notion 시간은 유지하고 날짜만 바뀜", async () => {
    const nid = nidOf(ids.b);
    Object.assign(N.p.get(nid)!, { due: "2026-11-26", dueRaw: "2026-11-26T15:00:00.000+09:00", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.b)!.due).toBe("2026-11-26");
    Object.assign(G.t.get(ids.b)!, { due: "2026-11-28", updated: T0 + 7 * MIN });
    await run(T0 + 10 * MIN);
    expect(N.p.get(nid)!.dueRaw).toBe("2026-11-28T15:00:00.000+09:00");
  });
  it("금방 적고 바로 완료한 구글 항목도 넘어옴", async () => {
    const q = G.add("금방끝냄", { done: true, doneAt: T0 + 2 * MIN, updated: T0 + 2 * MIN });
    await run(T0 + 5 * MIN);
    expect(N.p.get(nidOf(q))!.done).toBe(true);
  });
});

describe("삭제", () => {
  it("구글 삭제 → Notion 휴지통, Notion 삭제 → 구글 삭제", async () => {
    const nidA = nidOf(ids.a);
    G.t.get(ids.a)!.gone = true;
    const gOnly = gidOf(ids.nOnly);
    N.trashed.add(ids.nOnly);
    const c = await run(T0 + 5 * MIN);
    expect(N.trashed.has(nidA)).toBe(true);
    expect(G.t.get(gOnly)!.gone).toBe(true);
    expect([c.gDelete, c.nDelete]).toEqual([1, 1]);
  });
  it("한 번에 6개 넘게 지우려 하면 아무것도 안 바꾸고 멈춤", async () => {
    for (let i = 0; i < 6; i++) G.add(`추가${i}`);
    await run(T0 + 5 * MIN);
    for (const gid of Object.keys(st.pairs!).slice(0, 6)) G.t.get(gid)!.gone = true;
    G.calls = N.calls = 0;
    await expect(run(T0 + 10 * MIN)).rejects.toBeInstanceOf(SafetyStop);
    expect(G.calls + N.calls).toBe(0);
  });
  it("오래전에 완료돼서 조회에서 빠진 짝은 지우지 않음", async () => {
    Object.assign(G.t.get(ids.a)!, { done: true, doneAt: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    const later = T0 + FETCH_WINDOW + 86400_000;
    G.calls = N.calls = 0;
    await run(later);
    expect(N.trashed.has(nidOf(ids.a))).toBe(false);
    expect(G.t.get(ids.a)!.gone).toBeFalsy();
    expect(G.calls + N.calls).toBe(0);
  });
  it("오래된 완료 항목을 Notion에서 되살리면 구글도 되살아남", async () => {
    Object.assign(G.t.get(ids.a)!, { done: true, doneAt: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    const later = T0 + FETCH_WINDOW + 86400_000;
    Object.assign(N.p.get(nidOf(ids.a))!, { done: false, updated: later - MIN });
    await run(later);
    expect(G.t.get(ids.a)!.done).toBe(false);
  });
});

describe("반복·하위 할 일", () => {
  it("반복 항목은 Next Due 를 구글로, 날짜는 Notion 기준", async () => {
    const nid = N.add("물 주기", { repeat: true, due: "2026-11-20", dueRaw: "2026-11-20", nextDue: "2026-11-27", created: T0 + MIN });
    await run(T0 + 5 * MIN);
    const gid = gidOf(nid);
    expect(G.t.get(gid)!.due).toBe("2026-11-27");
    Object.assign(G.t.get(gid)!, { due: "2026-12-01", updated: T0 + 7 * MIN });
    await run(T0 + 10 * MIN);
    expect(G.t.get(gid)!.due).toBe("2026-11-27");
    expect(N.p.get(nid)!.due).toBe("2026-11-20");
  });
  it("구글 하위 → Notion Parent Task, Notion 손자 → 구글 최상위 조상 아래", async () => {
    const child = G.add("하위", { parentRaw: ids.a, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(N.p.get(nidOf(child))!.parentRaw).toBe(nidOf(ids.a));
    const grand = N.add("손자", { parentRaw: nidOf(child), created: T0 + 6 * MIN, updated: T0 + 6 * MIN });
    await run(T0 + 10 * MIN);
    expect(G.t.get(gidOf(grand))!.parentRaw).toBe(ids.a);
    expect(N.p.get(grand)!.parentRaw).toBe(nidOf(child));
  });
});

describe("무료 플랜 요청 한도", () => {
  it("일이 많으면 나눠서 처리하고, 몇 번 돌면 결국 다 맞춰짐", async () => {
    for (let i = 0; i < 30; i++) G.add(`많음${i}`, { updated: T0 + MIN });
    let c = await run(T0 + 5 * MIN, { budget: new Budget(20) });
    expect(c.deferred).toBeGreaterThan(0);
    for (let k = 2; k < 6; k++) c = await run(T0 + k * 5 * MIN, { budget: new Budget(20) });
    expect(c.deferred).toBe(0);
    const titles = new Set([...N.p.values()].map((x) => x.title));
    for (let i = 0; i < 30; i++) expect(titles.has(`많음${i}`)).toBe(true);
    expect([...N.p.values()].filter((x) => x.title === "많음0").length).toBe(1); // 중복 없음
  });
});

describe("기타", () => {
  it("시험 실행은 아무것도 안 바꿈", async () => {
    G = new FakeGoogle();
    N = new FakeNotion();
    st = {};
    G.add("하나");
    N.add("둘");
    const c = await run(T0, { dry: true });
    expect(G.calls + N.calls).toBe(0);
    expect([c.nCreate, c.gCreate]).toEqual([1, 1]);
  });
  it("예전 형식 장부(내용이 그대로 적힌 것)도 바뀌는 것 없이 옮겨짐", async () => {
    for (const [gid, pr] of Object.entries(st.pairs!)) {
      const g = G.t.get(gid)!;
      pr.last = { title: g.title, notes: g.notes, due: g.due, done: g.done, parent: "", t: pr.last!.t };
    }
    G.calls = N.calls = 0;
    await run(T0 + 5 * MIN);
    expect(G.calls + N.calls).toBe(0);
    expect(Object.values(st.pairs!).every((p) => p.last?.h === 1)).toBe(true);
  });
});
