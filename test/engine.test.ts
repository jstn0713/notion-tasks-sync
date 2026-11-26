// 가짜 구글/Notion 으로 동기화 규칙을 검사한다.
import { beforeEach, describe, expect, it } from "vitest";
import { Budget } from "../src/http";
import { FETCH_WINDOW, SafetyStop, syncList, type ListState } from "../src/engine";
import { LISTS } from "../src/lists";
import type { Ctx, Fields, GRaw, GTask, GoogleApi, ListConfig, NPage, NotionApi } from "../src/types";

const TODO = LISTS.find((l) => l.key === "todo")!;
const SHOP = LISTS.find((l) => l.key === "shopping")!;
const MIN = 60_000;
const T0 = Date.parse("2026-11-25T10:00:00Z");
let seq = 1;

export class FakeGoogle implements GoogleApi {
  t = new Map<string, GTask>();
  calls = 0;
  clock = T0;
  budget = new Budget(10_000);
  add(title: string, kw: Partial<GTask> = {}) {
    const id = `g${seq++}`;
    this.t.set(id, { id, title, notes: "", due: "", done: false, parentRaw: "", updated: T0 - 86400_000, position: String(seq).padStart(5, "0"), ...kw });
    return id;
  }
  async findList() {
    return "L";
  }
  async listTasks(_l: string, completedMin: number) {
    this.budget.take();
    const out = new Map<string, GTask>();
    for (const [k, v] of this.t) if (!(v.done && (v.doneAt ?? 0) < completedMin)) out.set(k, { ...v });
    return out;
  }
  async getTask(_l: string, id: string) {
    this.budget.take();
    const v = this.t.get(id);
    return v ? { ...v } : null;
  }
  async create(_l: string, v: Partial<GRaw>) {
    this.budget.take();
    this.calls++;
    const id = `g${seq++}`;
    this.t.set(id, { id, title: v.title ?? "", notes: v.notes ?? "", due: v.due ?? "", done: !!v.done, parentRaw: "", updated: this.clock, doneAt: v.done ? this.clock : undefined, position: "00000" });
    return id;
  }
  async update(_l: string, id: string, v: Partial<GRaw>) {
    this.budget.take();
    this.calls++;
    const it = this.t.get(id)!;
    Object.assign(it, v, { updated: this.clock });
    if (v.done) it.doneAt = this.clock;
  }
  async move(_l: string, id: string, parent: string, previous?: string) {
    this.budget.take();
    this.calls++;
    const position = previous ? this.t.get(previous)!.position + "5" : "00000";
    Object.assign(this.t.get(id)!, { parentRaw: parent, updated: this.clock, position });
  }
  /** 목록에 보이는 순서대로 (완료 안 된 것만) */
  order() {
    return [...this.t.values()].filter((t) => !t.done && !t.gone).sort((a, b) => a.position!.localeCompare(b.position!)).map((t) => t.title);
  }
  async remove(_l: string, id: string) {
    this.budget.take();
    this.calls++;
    this.t.get(id)!.gone = true;
  }
}

export class FakeNotion implements NotionApi {
  p = new Map<string, NPage>();
  trashed = new Set<string>();
  calls = 0;
  clock = T0;
  budget = new Budget(10_000);
  stores = ["쿠팡", "네이버", "다이소", "마트", "약국", "당근"];
  constructor(private cfg: ListConfig = TODO) {}
  private blank(): Fields {
    const f: Fields = {};
    for (const s of this.cfg.fields) f[s.name] = s.type === "checkbox" ? false : "";
    return f;
  }
  add(title: string, kw: Partial<NPage> & { f?: Fields } = {}) {
    const id = `n${seq++}`;
    const f = { ...this.blank(), [this.cfg.titleField]: title, ...(kw.f ?? {}) };
    this.p.set(id, { id, parentRaw: "", updated: T0 - 86400_000, created: T0 - 86400_000, dateRaw: {}, ...kw, f });
    return id;
  }
  async selectOptions() {
    this.budget.take();
    return [...this.stores];
  }
  async listPages(_ds: string, _c: ListConfig, since: number) {
    this.budget.take();
    const out = new Map<string, NPage>();
    for (const [k, v] of this.p) if (!this.trashed.has(k) && (!v.f.done || v.updated >= since)) out.set(k, structuredClone(v));
    return out;
  }
  async getPage(id: string) {
    this.budget.take();
    const v = this.p.get(id);
    return v && !this.trashed.has(id) ? structuredClone(v) : null;
  }
  async create(_ds: string, _c: ListConfig, f: Fields) {
    this.budget.take();
    this.calls++;
    const id = `n${seq++}`;
    const dateRaw: Record<string, string | null> = {};
    for (const s of this.cfg.fields) if (s.type === "date") dateRaw[s.name] = (f[s.name] as string) || null;
    this.p.set(id, { id, f: { ...this.blank(), ...f }, parentRaw: "", updated: this.clock, created: this.clock, dateRaw });
    return id;
  }
  async update(_c: ListConfig, page: NPage, v: Fields) {
    this.budget.take();
    this.calls++;
    const it = this.p.get(page.id)!;
    for (const [k, val] of Object.entries(v)) {
      const raw = it.dateRaw[k];
      if (k in it.dateRaw || this.cfg.fields.find((s) => s.name === k)?.type === "date")
        it.dateRaw[k] = val && raw && raw.length > 10 ? String(val) + raw.slice(10) : (val as string) || null;
      it.f[k] = val;
    }
    // 실제 Notion 처럼: 완료 쪽 단계에서는 '개발 중' 표시가 없음
    if (this.cfg.openOnlyField && it.f.done) it.f[this.cfg.openOnlyField] = false;
    it.updated = this.clock;
  }
  async setParent(_c: ListConfig, id: string, parent: string) {
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
let CFG: ListConfig = TODO;

async function run(now: number, opts: { dry?: boolean; budget?: Budget } = {}) {
  G.clock = N.clock = now;
  const budget = opts.budget ?? new Budget(10_000);
  G.budget = N.budget = budget;
  const ctx: Ctx = { stores: CFG.storeProp ? await N.selectOptions() : [] };
  return syncList({ cfg: CFG, g: G, n: N, budget, gList: "L", dsId: "DS", st, now, dryRun: !!opts.dry, ctx });
}
const nidOf = (gid: string) => st.pairs![gid].nid;
const gidOf = (nid: string) => Object.entries(st.pairs!).find(([, p]) => p.nid === nid)![0];
const nf = (nid: string) => N.p.get(nid)!.f;

describe("TO-DO", () => {
  beforeEach(async () => {
    CFG = TODO;
    G = new FakeGoogle();
    N = new FakeNotion(TODO);
    st = {};
    ids = {
      a: G.add("보수교육"),
      b: G.add("같은제목"),
      oldDone: G.add("옛날완료", { done: true, doneAt: T0 - 40 * 86400_000 }),
      nSame: N.add("같은제목", { f: { notes: "노션메모" } }),
      nOnly: N.add("노션에만"),
      nOldDone: N.add("테스트", { f: { done: true } }),
      nBlank: N.add(""),
    };
    await run(T0);
  });

  it("처음 연결: 같은 제목끼리 짝, 빈 칸은 채우고, 옛 완료·빈 제목은 무시", () => {
    expect(nidOf(ids.b)).toBe(ids.nSame);
    expect(G.t.get(ids.b)!.notes).toBe("노션메모");
    expect(nf(nidOf(ids.a)).title).toBe("보수교육");
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
  it("바뀐 게 없으면 아무것도 안 함", async () => {
    G.calls = N.calls = 0;
    const c = await run(T0 + 5 * MIN);
    expect(G.calls + N.calls).toBe(0);
    expect(c.gUpdate + c.nUpdate + c.gCreate + c.nCreate).toBe(0);
  });
  it("구글에서 완료 → Notion 완료", async () => {
    Object.assign(G.t.get(ids.a)!, { done: true, doneAt: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nidOf(ids.a)).done).toBe(true);
  });
  it("양쪽에서 다른 칸을 고치면 둘 다 반영", async () => {
    const nid = nidOf(ids.b);
    nf(nid).title = "노션에서 고친 제목";
    N.p.get(nid)!.updated = T0 + 2 * MIN;
    Object.assign(G.t.get(ids.b)!, { notes: "구글에서 고친 메모", updated: T0 + 3 * MIN });
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.b)!.title).toBe("노션에서 고친 제목");
    expect(nf(nid).notes).toBe("구글에서 고친 메모");
  });
  it("같은 칸을 양쪽에서 고치면 나중에 고친 쪽", async () => {
    const nid = nidOf(ids.b);
    nf(nid).title = "노션판";
    N.p.get(nid)!.updated = T0 + 2 * MIN;
    Object.assign(G.t.get(ids.b)!, { title: "구글판", updated: T0 + 4 * MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nid).title).toBe("구글판");
  });
  it("Notion 시간은 유지하고 날짜만 바뀜", async () => {
    const nid = nidOf(ids.b);
    nf(nid).due = "2026-11-26";
    N.p.get(nid)!.dateRaw.due = "2026-11-26T15:00:00.000+09:00";
    N.p.get(nid)!.updated = T0 + MIN;
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.b)!.due).toBe("2026-11-26");
    Object.assign(G.t.get(ids.b)!, { due: "2026-11-28", updated: T0 + 7 * MIN });
    await run(T0 + 10 * MIN);
    expect(N.p.get(nid)!.dateRaw.due).toBe("2026-11-28T15:00:00.000+09:00");
  });
  it("금방 적고 바로 완료한 구글 항목도 넘어옴", async () => {
    const q = G.add("금방끝냄", { done: true, doneAt: T0 + 2 * MIN, updated: T0 + 2 * MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nidOf(q)).done).toBe(true);
  });
  it("삭제: 구글 삭제 → Notion 휴지통, Notion 삭제 → 구글 삭제", async () => {
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
    G.calls = N.calls = 0;
    await run(T0 + FETCH_WINDOW + 86400_000);
    expect(N.trashed.has(nidOf(ids.a))).toBe(false);
    expect(G.calls + N.calls).toBe(0);
  });
  it("오래된 완료 항목을 Notion에서 되살리면 구글도 되살아남", async () => {
    Object.assign(G.t.get(ids.a)!, { done: true, doneAt: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    const later = T0 + FETCH_WINDOW + 86400_000;
    nf(nidOf(ids.a)).done = false;
    N.p.get(nidOf(ids.a))!.updated = later - MIN;
    await run(later);
    expect(G.t.get(ids.a)!.done).toBe(false);
  });
  it("반복 항목은 Next Due 를 구글로, 날짜는 Notion 기준", async () => {
    const nid = N.add("물 주기", { repeat: true, nextDue: "2026-11-27", created: T0 + MIN, f: { due: "2026-11-20" } });
    await run(T0 + 5 * MIN);
    const gid = gidOf(nid);
    expect(G.t.get(gid)!.due).toBe("2026-11-27");
    Object.assign(G.t.get(gid)!, { due: "2026-12-01", updated: T0 + 7 * MIN });
    await run(T0 + 10 * MIN);
    expect(G.t.get(gid)!.due).toBe("2026-11-27");
    expect(nf(nid).due).toBe("2026-11-20");
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
  it("요청 한도: 일이 많으면 나눠서 처리하고 결국 다 맞춰짐 (중복 없음)", async () => {
    for (let i = 0; i < 30; i++) G.add(`많음${i}`, { updated: T0 + MIN });
    let c = await run(T0 + 5 * MIN, { budget: new Budget(20) });
    expect(c.deferred).toBeGreaterThan(0);
    for (let k = 2; k < 6; k++) c = await run(T0 + k * 5 * MIN, { budget: new Budget(20) });
    expect(c.deferred).toBe(0);
    const titles = [...N.p.values()].map((x) => x.f.title);
    for (let i = 0; i < 30; i++) expect(titles.filter((t) => t === `많음${i}`).length).toBe(1);
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
  it("시험 실행은 아무것도 안 바꿈", async () => {
    G = new FakeGoogle();
    N = new FakeNotion(TODO);
    st = {};
    G.add("하나");
    N.add("둘");
    const c = await run(T0, { dry: true });
    expect(G.calls + N.calls).toBe(0);
    expect([c.nCreate, c.gCreate]).toEqual([1, 1]);
  });
});

describe("장바구니", () => {
  beforeEach(async () => {
    CFG = SHOP;
    G = new FakeGoogle();
    N = new FakeNotion(SHOP);
    st = {};
    ids = {
      g1: G.add("다이소 신발 얼룩 지우개"),
      old: G.add("물티슈", { done: true, doneAt: T0 - 10 * 86400_000 }),
      n1: N.add("신발 얼룩 지우개", { f: { store: "다이소" } }),
      blank: N.add(""),
    };
    await run(T0);
  });

  it("처음 연결: 구글 '다이소 신발 얼룩 지우개' ↔ Notion 품목+구매처, 바꿀 것 없음", async () => {
    expect(nidOf(ids.g1)).toBe(ids.n1);
    expect(G.t.get(ids.g1)!.title).toBe("다이소 신발 얼룩 지우개");
    expect(Object.keys(st.pairs!).length).toBe(1); // 옛 완료·빈 줄은 무시
    G.calls = N.calls = 0;
    await run(T0 + 5 * MIN);
    expect(G.calls + N.calls).toBe(0);
  });

  it("구글에 '쿠팡 물티슈 3개 !' + 세부정보 주소 → Notion 칸으로 나뉨", async () => {
    const g = G.add("쿠팡 물티슈 3개 !", { notes: "두꺼운 걸로\nhttps://link.coupang.com/a/abc123", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nidOf(g))).toMatchObject({ item: "물티슈", store: "쿠팡", qty: "3", urgent: true, memo: "두꺼운 걸로", link: "https://link.coupang.com/a/abc123", done: false });
  });

  it("Notion에서 수량·급함·구매처를 바꾸면 구글 제목이 다시 만들어짐", async () => {
    Object.assign(nf(ids.n1), { qty: "2", urgent: true, store: "쿠팡" });
    N.p.get(ids.n1)!.updated = T0 + MIN;
    const c = await run(T0 + 5 * MIN);
    expect(G.t.get(ids.g1)!.title).toBe("쿠팡 신발 얼룩 지우개 2개 !");
    expect(c.gFields).toMatchObject({ store: 1, qty: 1, urgent: 1 });
  });

  it("Notion 링크·메모 → 구글 세부정보에 합쳐짐", async () => {
    Object.assign(nf(ids.n1), { memo: "검정색", link: "https://naver.me/xyz" });
    N.p.get(ids.n1)!.updated = T0 + MIN;
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.g1)!.notes).toBe("검정색\nhttps://naver.me/xyz");
  });

  it("구글에서 제목 앞 매장을 바꾸면 Notion 구매처가 바뀜 (다른 이름도 인식)", async () => {
    Object.assign(G.t.get(ids.g1)!, { title: "엔플 신발 얼룩 지우개", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(ids.n1)).toMatchObject({ store: "네이버", item: "신발 얼룩 지우개" });
    // 구글 제목은 대표 이름으로 정리됨
    expect(G.t.get(ids.g1)!.title).toBe("네이버 신발 얼룩 지우개");
  });

  it("살 날짜·구매완료 양쪽 연동", async () => {
    Object.assign(G.t.get(ids.g1)!, { due: "2026-11-28", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(ids.n1).due).toBe("2026-11-28");
    nf(ids.n1).done = true;
    N.p.get(ids.n1)!.updated = T0 + 6 * MIN;
    await run(T0 + 10 * MIN);
    expect(G.t.get(ids.g1)!.done).toBe(true);
  });

  it("https:// 없는 Notion 링크가 메모로 넘어가지 않음 (예전에 꼬인 항목도 바로잡힘)", async () => {
    // 이번 버그로 꼬인 상태 재현: Notion 링크 비고 메모에 주소, 구글 세부정보도 같은 글자
    Object.assign(nf(ids.n1), { memo: "검정색\nwww.coupang.com", link: "" });
    N.p.get(ids.n1)!.updated = T0 + MIN;
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.g1)!.notes).toBe("검정색\nwww.coupang.com");
    await run(T0 + 10 * MIN);
    expect(nf(ids.n1)).toMatchObject({ memo: "검정색", link: "www.coupang.com" });
    // 그 뒤로는 더 바뀌지 않음
    G.calls = N.calls = 0;
    await run(T0 + 15 * MIN);
    expect(G.calls + N.calls).toBe(0);
    // Notion 에서 링크를 새로 넣어도 링크 칸에 그대로 남음
    Object.assign(nf(ids.n1), { link: "www.naver.com" });
    N.p.get(ids.n1)!.updated = T0 + 16 * MIN;
    await run(T0 + 20 * MIN);
    await run(T0 + 25 * MIN);
    expect(nf(ids.n1)).toMatchObject({ memo: "검정색", link: "www.naver.com" });
    expect(G.t.get(ids.g1)!.notes).toBe("검정색\nwww.naver.com");
  });

  it("Notion에 새로 추가한 구매처도 다음 실행부터 인식", async () => {
    N.stores.push("올리브영");
    const g = G.add("올리브영 선크림", { updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nidOf(g))).toMatchObject({ store: "올리브영", item: "선크림" });
  });

  it("장부에 장바구니 내용이 남지 않음", async () => {
    G.add("쿠팡 물티슈 3개 !", { notes: "https://link.coupang.com/a/abc123", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    const blob = JSON.stringify(st);
    for (const w of ["물티슈", "신발", "coupang", "다이소"]) expect(blob).not.toContain(w);
  });
});

describe("AI 공방", () => {
  const AI = LISTS.find((l) => l.key === "ai")!;
  // Notion 단계를 바꾸는 것처럼 (아이디어 / 개발 중 / 완료 쪽)
  const setStage = (nid: string, st: "idea" | "dev" | "later", at: number) => {
    Object.assign(nf(nid), { done: st === "later", dev: st === "dev" });
    N.p.get(nid)!.updated = at;
  };
  const gset = (gid: string, kw: Partial<GTask>, at: number) => Object.assign(G.t.get(gid)!, kw, { updated: at, ...(kw.done ? { doneAt: at } : {}) });

  beforeEach(async () => {
    CFG = AI;
    G = new FakeGoogle();
    N = new FakeNotion(AI);
    st = {};
    ids = {};
    ids.g1 = G.add("주차 위치 기록 앱");
    ids.g2 = G.add("기프티콘 보관함");
    ids.n1 = N.add("주차 위치 기록 앱", { f: { notes: "음성 메모도" } });
    ids.n2 = N.add("기프티콘 보관함");
    // 다듬는 중·완성 줄은 구글에 만들지 않음
    ids.nLater = N.add("데일리 자산 기록", { f: { done: true } });
    await run(T0);
  });

  it("처음 연결: 제목이 같은 아이디어끼리 짝, 다듬는 중 이상은 구글에 안 만듦", async () => {
    expect(nidOf(ids.g1)).toBe(ids.n1);
    expect(G.t.get(ids.g1)!.notes).toBe("음성 메모도");
    expect(G.order()).toEqual(["주차 위치 기록 앱", "기프티콘 보관함"]);
  });

  it("구글에 새로 적은 아이디어 → Notion 에 '아이디어'로", async () => {
    const g = G.add("새 아이디어", { notes: "사진으로 등록", updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    expect(nf(nidOf(g))).toMatchObject({ title: "새 아이디어", notes: "사진으로 등록", done: false, dev: false });
  });

  it("Notion 개발 중 → 구글 제목 앞 '(개발중)' + 맨 아래로, 완료는 아님", async () => {
    setStage(ids.n1, "dev", T0 + MIN);
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.g1)).toMatchObject({ title: "(개발중) 주차 위치 기록 앱", done: false });
    expect(G.order()).toEqual(["기프티콘 보관함", "(개발중) 주차 위치 기록 앱"]);
    // 다시 실행해도 더 바뀌지 않음
    G.calls = N.calls = 0;
    await run(T0 + 10 * MIN);
    expect(G.calls + N.calls).toBe(0);
    // 아이디어로 되돌리면 '(개발중)'이 빠짐
    setStage(ids.n1, "idea", T0 + 11 * MIN);
    await run(T0 + 15 * MIN);
    expect(G.t.get(ids.g1)!.title).toBe("주차 위치 기록 앱");
  });

  it("구글 제목에 '(개발중)'을 직접 붙이면 Notion 도 개발 중 (띄어쓰기 달라도)", async () => {
    gset(ids.g2, { title: "(개발 중)기프티콘 보관함" }, T0 + MIN);
    await run(T0 + 5 * MIN);
    expect(nf(ids.n2)).toMatchObject({ title: "기프티콘 보관함", dev: true, done: false });
    expect(G.t.get(ids.g2)!.title).toBe("(개발중) 기프티콘 보관함"); // 모양 정리
    expect(G.order().at(-1)).toBe("(개발중) 기프티콘 보관함");
  });

  it("구글 완료 → 다듬는 중, 완료를 풀면 완료 전 단계로 (개발 중이었으면 개발 중)", async () => {
    setStage(ids.n1, "dev", T0 + MIN);
    await run(T0 + 5 * MIN);
    gset(ids.g1, { done: true }, T0 + 6 * MIN);
    await run(T0 + 10 * MIN);
    expect(nf(ids.n1)).toMatchObject({ done: true, dev: false });
    G.calls = N.calls = 0;
    await run(T0 + 15 * MIN);
    expect(G.calls + N.calls).toBe(0);
    gset(ids.g1, { done: false, doneAt: undefined }, T0 + 16 * MIN);
    await run(T0 + 20 * MIN);
    expect(nf(ids.n1)).toMatchObject({ done: false, dev: true });
    expect(G.t.get(ids.g1)!.title).toBe("(개발중) 주차 위치 기록 앱");
  });

  it("아이디어에서 바로 완료했다가 풀면 아이디어로", async () => {
    gset(ids.g2, { done: true }, T0 + MIN);
    await run(T0 + 5 * MIN);
    expect(nf(ids.n2).done).toBe(true);
    gset(ids.g2, { done: false, doneAt: undefined }, T0 + 6 * MIN);
    await run(T0 + 10 * MIN);
    expect(nf(ids.n2)).toMatchObject({ done: false, dev: false });
  });

  it("Notion 개발 중 → 다듬는 중이면 구글 완료, 다시 개발 중으로 돌리면 구글도 '(개발중)'으로", async () => {
    setStage(ids.n1, "dev", T0 + MIN);
    await run(T0 + 5 * MIN);
    setStage(ids.n1, "later", T0 + 6 * MIN);
    await run(T0 + 10 * MIN);
    expect(G.t.get(ids.g1)!.done).toBe(true);
    setStage(ids.n1, "dev", T0 + 11 * MIN);
    await run(T0 + 15 * MIN);
    expect(G.t.get(ids.g1)).toMatchObject({ done: false, title: "(개발중) 주차 위치 기록 앱" });
    expect(G.order().at(-1)).toBe("(개발중) 주차 위치 기록 앱");
  });

  it("Notion 에 개발 중인 줄을 새로 넣으면 구글에 '(개발중)'으로 맨 아래에", async () => {
    const n = N.add("새 프로젝트", { f: { dev: true }, created: T0 + MIN, updated: T0 + MIN });
    await run(T0 + 5 * MIN);
    const g = gidOf(n);
    expect(G.t.get(g)).toMatchObject({ title: "(개발중) 새 프로젝트", done: false });
    expect(G.order().at(-1)).toBe("(개발중) 새 프로젝트");
  });

  it("구글 날짜는 연동하지 않고 그대로 둠", async () => {
    gset(ids.g1, { due: "2026-12-01" }, T0 + MIN);
    nf(ids.n1).notes = "바뀐 메모";
    N.p.get(ids.n1)!.updated = T0 + 2 * MIN;
    await run(T0 + 5 * MIN);
    expect(G.t.get(ids.g1)).toMatchObject({ notes: "바뀐 메모", due: "2026-12-01" });
    G.calls = N.calls = 0;
    await run(T0 + 10 * MIN);
    expect(G.calls + N.calls).toBe(0);
  });
});
