"""가짜 구글/Notion으로 동기화 시나리오를 검사한다. 실행: python3 -m pytest -q tests"""
import itertools
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sync  # noqa: E402
from sync import Item, SafetyStop, sync_list  # noqa: E402

CFG = sync.LIST_CONFIGS[0]
_ids = itertools.count(1)
T0 = datetime(2026, 11, 25, 7, 0, tzinfo=timezone.utc)


class FakeGoogle:
    def __init__(self):
        self.t: dict[str, Item] = {}
        self.calls = 0
        self.clock = T0

    def add(self, title, **kw):
        gid = f"g{next(_ids)}"
        self.t[gid] = Item(id=gid, title=title, updated=kw.pop("updated", T0 - timedelta(days=1)), **kw)
        return gid

    def list_tasks(self, _):
        return {k: Item(**vars(v)) for k, v in self.t.items()}

    def create(self, _, vals):
        self.calls += 1
        gid = f"g{next(_ids)}"
        self.t[gid] = Item(id=gid, updated=self.clock, **{k: vals[k] for k in ("title", "notes", "due", "done")})
        return gid

    def update(self, _, gid, vals):
        self.calls += 1
        for k, v in vals.items():
            setattr(self.t[gid], k, v)
        self.t[gid].updated = self.clock

    def move(self, _, gid, parent):
        self.calls += 1
        self.t[gid].parent_raw = parent
        self.t[gid].updated = self.clock

    def delete(self, _, gid):
        self.calls += 1
        self.t[gid].gone = True


class FakeNotion:
    def __init__(self):
        self.p: dict[str, Item] = {}
        self.trashed = set()
        self.calls = 0
        self.clock = T0

    def add(self, title, **kw):
        nid = f"n{next(_ids)}"
        kw.setdefault("created", T0 - timedelta(days=1))
        kw.setdefault("updated", T0 - timedelta(days=1))
        self.p[nid] = Item(id=nid, title=title, **kw)
        return nid

    def list_pages(self, *_):
        return {k: Item(**vars(v)) for k, v in self.p.items() if k not in self.trashed}

    def create(self, _ds, _p, vals):
        self.calls += 1
        nid = f"n{next(_ids)}"
        self.p[nid] = Item(id=nid, created=self.clock, updated=self.clock,
                           due_raw=vals["due"] or None,
                           **{k: vals[k] for k in ("title", "notes", "due", "done")})
        return nid

    def update(self, _p, page, vals):
        self.calls += 1
        it = self.p[page.id]
        for k, v in vals.items():
            if k == "due":
                it.due_raw = (v + it.due_raw[10:]) if (v and it.due_raw and len(it.due_raw) > 10) else (v or None)
            setattr(it, k, v)
        it.updated = self.clock

    def set_parent(self, _p, nid, parent):
        self.calls += 1
        self.p[nid].parent_raw = parent
        self.p[nid].updated = self.clock

    def trash(self, nid):
        self.calls += 1
        self.trashed.add(nid)


def run(G, N, state, now, dry=False):
    init = sync.parse_ts(state.get("initialized_at")) or now
    state.setdefault("initialized_at", sync.iso(init))
    G.clock = N.clock = now
    return sync_list(CFG, G, N, "L", "DS", state, init, now, dry)


def pair_of(state, gid):
    return state["pairs"][gid]["nid"]


@pytest.fixture
def setup():
    G, N = FakeGoogle(), FakeNotion()
    a = G.add("보수교육")
    b = G.add("같은제목")
    old_done = G.add("옛날완료", done=True, done_at=T0 - timedelta(days=30))
    n_same = N.add("같은제목", notes="노션메모")
    n_only = N.add("노션에만")
    n_old_done = N.add("테스트", done=True)
    n_blank = N.add("")
    state: dict = {}
    _, c = run(G, N, state, T0)
    return G, N, state, dict(a=a, b=b, old_done=old_done, n_same=n_same,
                             n_only=n_only, n_old_done=n_old_done, n_blank=n_blank)


def test_initial_link(setup):
    G, N, state, ids = setup
    pairs = state["pairs"]
    assert pair_of(state, ids["b"]) == ids["n_same"]          # 같은 제목끼리 짝
    assert G.t[ids["b"]].notes == "노션메모"                    # 빈 쪽은 채워짐
    assert ids["a"] in pairs and N.p[pair_of(state, ids["a"])].title == "보수교육"
    assert ids["old_done"] not in pairs                         # 옛 완료 항목은 무시
    linked_n = {p["nid"] for p in pairs.values()}
    assert ids["n_only"] in linked_n                            # Notion에만 있던 것 → 구글 생성
    assert ids["n_old_done"] not in linked_n and ids["n_blank"] not in linked_n
    assert len(pairs) == 3


def test_second_run_no_changes(setup):
    G, N, state, _ = setup
    G.calls = N.calls = 0
    _, c = run(G, N, state, T0 + timedelta(minutes=15))
    assert G.calls == 0 and N.calls == 0
    assert (c.g_update, c.n_update, c.g_create, c.n_create) == (0, 0, 0, 0)


def test_google_complete_flows_to_notion(setup):
    G, N, state, ids = setup
    t1 = T0 + timedelta(minutes=10)
    G.t[ids["a"]].done = True
    G.t[ids["a"]].updated = t1
    run(G, N, state, T0 + timedelta(minutes=15))
    assert N.p[pair_of(state, ids["a"])].done is True


def test_field_merge_both_sides(setup):
    G, N, state, ids = setup
    nid = pair_of(state, ids["b"])
    N.p[nid].title = "노션에서 고친 제목"
    N.p[nid].updated = T0 + timedelta(minutes=5)
    G.t[ids["b"]].notes = "구글에서 고친 메모"
    G.t[ids["b"]].updated = T0 + timedelta(minutes=8)
    run(G, N, state, T0 + timedelta(minutes=15))
    for it in (G.t[ids["b"]], N.p[nid]):
        assert it.title == "노션에서 고친 제목"
        assert it.notes == "구글에서 고친 메모"


def test_conflict_newer_wins(setup):
    G, N, state, ids = setup
    nid = pair_of(state, ids["b"])
    N.p[nid].title = "노션판"
    N.p[nid].updated = T0 + timedelta(minutes=5)
    G.t[ids["b"]].title = "구글판"
    G.t[ids["b"]].updated = T0 + timedelta(minutes=9)
    run(G, N, state, T0 + timedelta(minutes=15))
    assert N.p[nid].title == "구글판" and G.t[ids["b"]].title == "구글판"


def test_delete_both_directions(setup):
    G, N, state, ids = setup
    nid_a = pair_of(state, ids["a"])
    G.t[ids["a"]].gone = True                                   # 구글에서 삭제
    gid_only = next(g for g, p in state["pairs"].items() if p["nid"] == ids["n_only"])
    N.trashed.add(ids["n_only"])                                # Notion에서 삭제
    _, c = run(G, N, state, T0 + timedelta(minutes=15))
    assert nid_a in N.trashed
    assert G.t[gid_only].gone
    assert c.g_delete == 1 and c.n_delete == 1


def test_safety_stop_on_mass_delete(setup):
    G, N, state, ids = setup
    for i in range(6):
        g = G.add(f"추가{i}")
    run(G, N, state, T0 + timedelta(minutes=15))                # 6개 연결됨
    for gid in list(state["pairs"])[:6]:
        G.t[gid].gone = True
    G.calls = N.calls = 0
    with pytest.raises(SafetyStop):
        run(G, N, state, T0 + timedelta(minutes=30))
    assert G.calls == 0 and N.calls == 0                        # 아무것도 안 바꿈


def test_repeating_uses_next_due(setup):
    G, N, state, ids = setup
    nid = N.add("물 주기", repeat=True, due="2026-11-20", due_raw="2026-11-20",
                extra={"next_due": "2026-11-27"}, created=T0 + timedelta(minutes=1))
    run(G, N, state, T0 + timedelta(minutes=15))
    gid = next(g for g, p in state["pairs"].items() if p["nid"] == nid)
    assert G.t[gid].due == "2026-11-27"
    G.t[gid].due = "2026-12-01"                                 # 구글에서 날짜 바꿔도
    G.t[gid].updated = T0 + timedelta(minutes=20)
    run(G, N, state, T0 + timedelta(minutes=30))
    assert G.t[gid].due == "2026-11-27"                         # Notion 기준으로 되돌림
    assert N.p[nid].due == "2026-11-20"                         # Notion 날짜는 그대로


def test_subtasks_both_ways(setup):
    G, N, state, ids = setup
    child = G.add("하위", parent_raw=ids["a"], updated=T0 + timedelta(minutes=2))
    run(G, N, state, T0 + timedelta(minutes=15))
    assert N.p[pair_of(state, child)].parent_raw == pair_of(state, ids["a"])
    # Notion 손자 → 구글에선 최상위 조상 아래로
    n_child = pair_of(state, child)
    grand = N.add("손자", parent_raw=n_child, created=T0 + timedelta(minutes=16))
    run(G, N, state, T0 + timedelta(minutes=30))
    g_grand = next(g for g, p in state["pairs"].items() if p["nid"] == grand)
    assert G.t[g_grand].parent_raw == ids["a"]
    assert N.p[grand].parent_raw == n_child                     # Notion 구조는 유지


def test_due_keeps_notion_time(setup):
    G, N, state, ids = setup
    nid = pair_of(state, ids["b"])
    N.p[nid].due, N.p[nid].due_raw = "2026-11-26", "2026-11-26T15:00:00.000+09:00"
    N.p[nid].updated = T0 + timedelta(minutes=3)
    run(G, N, state, T0 + timedelta(minutes=15))
    assert G.t[ids["b"]].due == "2026-11-26"
    G.t[ids["b"]].due = "2026-11-28"
    G.t[ids["b"]].updated = T0 + timedelta(minutes=20)
    run(G, N, state, T0 + timedelta(minutes=30))
    assert N.p[nid].due_raw == "2026-11-28T15:00:00.000+09:00"


def test_dry_run_changes_nothing():
    G, N = FakeGoogle(), FakeNotion()
    G.add("하나")
    N.add("둘")
    state: dict = {}
    _, c = run(G, N, state, T0, dry=True)
    assert G.calls == 0 and N.calls == 0
    assert c.n_create == 1 and c.g_create == 1


def test_quick_capture_done_recently_is_linked(setup):
    G, N, state, ids = setup
    q = G.add("금방끝냄", done=True, done_at=T0 + timedelta(minutes=5),
              updated=T0 + timedelta(minutes=5))
    run(G, N, state, T0 + timedelta(minutes=15))
    assert q in state["pairs"] and N.p[pair_of(state, q)].done
