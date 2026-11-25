"""
구글 Tasks <-> Notion 데이터베이스 양방향 동기화.

- 공개 저장소용: 할 일 내용(제목 등)은 로그에 절대 출력하지 않고 개수만 출력한다.
- 어떤 구글 항목이 어떤 Notion 항목과 짝인지는 Notion의 '동기화 기록' 페이지에
  번호(ID)만 JSON으로 저장한다.
- 필요한 값은 모두 환경변수(깃허브 Secrets)로 받는다.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import requests

# ──────────────────────────────────────────────────────────────
# 설정: 연결할 목록들. 나중에 '살 것들', 'AI 개발'을 여기에 추가한다.
# ──────────────────────────────────────────────────────────────
LIST_CONFIGS = [
    {
        "key": "todo",
        "google_list_title": "할 일",
        "notion_ds_env": "NOTION_TODO_DS_ID",
        "props": {
            "title": "할 일",
            "done": "완료",
            "notes": "메모",
            "due": "마감일",
            "parent": "Parent Task",
            "frequency": "Frequency",  # 비어 있지 않으면 '반복 항목'
            "next_due": "Next Due",    # 반복 항목은 이 날짜를 구글로 보낸다
        },
    },
]

FIELDS = ["title", "notes", "due", "done", "parent"]
MAX_DELETES_PER_RUN = 5          # 한 번에 이보다 많이 지우려 하면 멈춘다
RECENT_DONE_WINDOW = timedelta(days=2)   # 짝 없는 '완료' 항목은 최근 것만 새로 연결
PRUNE_AFTER = timedelta(days=120)        # 양쪽 다 완료된 지 오래된 짝은 장부에서 정리

NOTION_VERSION = "2025-09-03"
GOOGLE_TASKS = "https://tasks.googleapis.com/tasks/v1"
NOTION_API = "https://api.notion.com/v1"


class SafetyStop(Exception):
    """안전장치가 동작해서 아무것도 바꾸지 않고 멈춤."""


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def norm_text(s: str | None) -> str:
    return (s or "").replace("\r\n", "\n").strip()


# ──────────────────────────────────────────────────────────────
# 공통 항목 모양
# ──────────────────────────────────────────────────────────────
@dataclass
class Item:
    id: str
    title: str = ""
    notes: str = ""
    due: str = ""            # "YYYY-MM-DD" 또는 ""
    done: bool = False
    parent_raw: str = ""     # 같은 쪽 안에서의 부모 ID
    updated: datetime | None = None
    created: datetime | None = None
    done_at: datetime | None = None
    gone: bool = False       # 구글: 삭제됨
    # Notion 전용
    due_raw: str | None = None
    repeat: bool = False
    extra: dict = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────
# HTTP 도우미 (재시도 + 내용 노출 없는 오류)
# ──────────────────────────────────────────────────────────────
class ApiError(Exception):
    pass


def http(method: str, url: str, *, headers=None, params=None, json_body=None,
         data=None, ok=(200,), tries: int = 5) -> dict:
    for attempt in range(tries):
        r = requests.request(method, url, headers=headers, params=params,
                             json=json_body, data=data, timeout=30)
        if r.status_code in ok:
            return r.json() if r.content else {}
        if r.status_code in (429, 500, 502, 503, 504) and attempt < tries - 1:
            wait = float(r.headers.get("Retry-After", 2 ** attempt))
            time.sleep(min(wait, 30))
            continue
        # 오류 본문에는 할 일 내용이 섞일 수 있으므로 코드만 남긴다
        code = ""
        try:
            code = r.json().get("code") or r.json().get("error", {}).get("status", "")
        except Exception:
            pass
        host = url.split("/")[2]
        raise ApiError(f"{method} {host} 실패: HTTP {r.status_code} {code}")
    raise ApiError("재시도 초과")


# ──────────────────────────────────────────────────────────────
# 구글 Tasks
# ──────────────────────────────────────────────────────────────
class Google:
    def __init__(self, client_id: str, client_secret: str, refresh_token: str):
        tok = http("POST", "https://oauth2.googleapis.com/token", data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })
        self.h = {"Authorization": f"Bearer {tok['access_token']}"}

    def find_list(self, title: str) -> str:
        res = http("GET", f"{GOOGLE_TASKS}/users/@me/lists", headers=self.h,
                   params={"maxResults": 100})
        for tl in res.get("items", []):
            if tl.get("title") == title:
                return tl["id"]
        raise ApiError("구글 Tasks에서 지정한 목록 이름을 찾지 못함")

    def list_tasks(self, list_id: str) -> dict[str, Item]:
        items: dict[str, Item] = {}
        token = None
        while True:
            params = {"maxResults": 100, "showCompleted": "true",
                      "showHidden": "true", "showDeleted": "true"}
            if token:
                params["pageToken"] = token
            res = http("GET", f"{GOOGLE_TASKS}/lists/{list_id}/tasks",
                       headers=self.h, params=params)
            for t in res.get("items", []):
                items[t["id"]] = Item(
                    id=t["id"],
                    title=norm_text(t.get("title")),
                    notes=norm_text(t.get("notes")),
                    due=(t.get("due") or "")[:10],
                    done=t.get("status") == "completed",
                    parent_raw=t.get("parent", ""),
                    updated=parse_ts(t.get("updated")),
                    done_at=parse_ts(t.get("completed")),
                    gone=bool(t.get("deleted")),
                )
            token = res.get("nextPageToken")
            if not token:
                return items

    @staticmethod
    def _body(vals: dict) -> dict:
        body: dict = {}
        if "title" in vals:
            body["title"] = vals["title"]
        if "notes" in vals:
            body["notes"] = vals["notes"]
        if "due" in vals:
            body["due"] = f"{vals['due']}T00:00:00.000Z" if vals["due"] else None
        if "done" in vals:
            body["status"] = "completed" if vals["done"] else "needsAction"
            if not vals["done"]:
                body["completed"] = None
        return body

    def create(self, list_id: str, vals: dict) -> str:
        res = http("POST", f"{GOOGLE_TASKS}/lists/{list_id}/tasks",
                   headers=self.h, json_body=self._body(vals))
        return res["id"]

    def update(self, list_id: str, task_id: str, vals: dict) -> None:
        http("PATCH", f"{GOOGLE_TASKS}/lists/{list_id}/tasks/{task_id}",
             headers=self.h, json_body=self._body(vals))

    def move(self, list_id: str, task_id: str, parent: str) -> None:
        params = {"parent": parent} if parent else None
        http("POST", f"{GOOGLE_TASKS}/lists/{list_id}/tasks/{task_id}/move",
             headers=self.h, params=params)

    def delete(self, list_id: str, task_id: str) -> None:
        http("DELETE", f"{GOOGLE_TASKS}/lists/{list_id}/tasks/{task_id}",
             headers=self.h, ok=(200, 204, 404))


# ──────────────────────────────────────────────────────────────
# Notion
# ──────────────────────────────────────────────────────────────
def _plain(rich: list) -> str:
    return "".join(x.get("plain_text", "") for x in rich or [])


def _rich(text: str) -> list:
    return [{"type": "text", "text": {"content": text[i:i + 2000]}}
            for i in range(0, len(text), 2000)] if text else []


class Notion:
    def __init__(self, token: str):
        self.h = {"Authorization": f"Bearer {token}",
                  "Notion-Version": NOTION_VERSION,
                  "Content-Type": "application/json"}

    # --- 데이터베이스 항목 ---
    def list_pages(self, ds_id: str, p: dict) -> dict[str, Item]:
        items: dict[str, Item] = {}
        cursor = None
        while True:
            body = {"page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            res = http("POST", f"{NOTION_API}/data_sources/{ds_id}/query",
                       headers=self.h, json_body=body)
            for pg in res.get("results", []):
                if pg.get("in_trash") or pg.get("archived"):
                    continue
                pr = pg["properties"]
                due_raw = ((pr.get(p["due"]) or {}).get("date") or {}).get("start")
                rel = (pr.get(p["parent"]) or {}).get("relation") or []
                freq = _plain((pr.get(p["frequency"]) or {}).get("rich_text")) if p.get("frequency") else ""
                next_due = ""
                if p.get("next_due") and pr.get(p["next_due"]):
                    f = pr[p["next_due"]].get("formula") or {}
                    if f.get("type") == "date" and f.get("date"):
                        next_due = (f["date"].get("start") or "")[:10]
                    elif f.get("type") == "string" and f.get("string"):
                        next_due = f["string"][:10]
                items[pg["id"]] = Item(
                    id=pg["id"],
                    title=norm_text(_plain(pr[p["title"]]["title"])),
                    notes=norm_text(_plain((pr.get(p["notes"]) or {}).get("rich_text"))),
                    due=(due_raw or "")[:10],
                    done=bool((pr.get(p["done"]) or {}).get("checkbox")),
                    parent_raw=rel[0]["id"] if rel else "",
                    updated=parse_ts(pg.get("last_edited_time")),
                    created=parse_ts(pg.get("created_time")),
                    due_raw=due_raw,
                    repeat=bool(freq.strip()),
                    extra={"next_due": next_due},
                )
            if not res.get("has_more"):
                return items
            cursor = res.get("next_cursor")

    @staticmethod
    def _props(p: dict, vals: dict, old: Item | None) -> dict:
        out: dict = {}
        if "title" in vals:
            out[p["title"]] = {"title": _rich(vals["title"])}
        if "notes" in vals:
            out[p["notes"]] = {"rich_text": _rich(vals["notes"])}
        if "done" in vals:
            out[p["done"]] = {"checkbox": bool(vals["done"])}
        if "due" in vals:
            d = vals["due"]
            if not d:
                out[p["due"]] = {"date": None}
            else:
                start = d
                # Notion에 시간이 들어 있었다면 시간은 그대로 두고 날짜만 바꾼다
                if old and old.due_raw and len(old.due_raw) > 10:
                    start = d + old.due_raw[10:]
                out[p["due"]] = {"date": {"start": start}}
        return out

    def create(self, ds_id: str, p: dict, vals: dict) -> str:
        res = http("POST", f"{NOTION_API}/pages", headers=self.h, json_body={
            "parent": {"type": "data_source_id", "data_source_id": ds_id},
            "properties": self._props(p, vals, None),
        })
        return res["id"]

    def update(self, p: dict, page: Item, vals: dict) -> None:
        props = self._props(p, vals, page)
        if props:
            http("PATCH", f"{NOTION_API}/pages/{page.id}", headers=self.h,
                 json_body={"properties": props})

    def set_parent(self, p: dict, page_id: str, parent_id: str) -> None:
        rel = [{"id": parent_id}] if parent_id else []
        http("PATCH", f"{NOTION_API}/pages/{page_id}", headers=self.h,
             json_body={"properties": {p["parent"]: {"relation": rel}}})

    def trash(self, page_id: str) -> None:
        http("PATCH", f"{NOTION_API}/pages/{page_id}", headers=self.h,
             json_body={"in_trash": True}, ok=(200, 404))

    # --- 동기화 기록 페이지 (코드 블록 하나에 JSON) ---
    def _state_block(self, page_id: str) -> dict | None:
        res = http("GET", f"{NOTION_API}/blocks/{page_id}/children",
                   headers=self.h, params={"page_size": 100})
        for b in res.get("results", []):
            if b.get("type") == "code":
                return b
        return None

    def load_state(self, page_id: str) -> dict:
        b = self._state_block(page_id)
        if not b:
            return {}
        txt = _plain(b["code"]["rich_text"]).strip()
        return json.loads(txt) if txt else {}

    def save_state(self, page_id: str, state: dict) -> None:
        txt = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if len(txt) > 190_000:
            raise ApiError("동기화 기록이 너무 커짐")
        code = {"language": "json", "rich_text": _rich(txt)}
        b = self._state_block(page_id)
        if b:
            http("PATCH", f"{NOTION_API}/blocks/{b['id']}", headers=self.h,
                 json_body={"code": code})
        else:
            http("PATCH", f"{NOTION_API}/blocks/{page_id}/children",
                 headers=self.h, json_body={"children": [
                     {"object": "block", "type": "code", "code": code}]})


# ──────────────────────────────────────────────────────────────
# 동기화 핵심 로직 (API와 분리되어 있어 테스트 가능)
# ──────────────────────────────────────────────────────────────
@dataclass
class Counts:
    g_create: int = 0
    g_update: int = 0
    g_delete: int = 0
    n_create: int = 0
    n_update: int = 0
    n_delete: int = 0
    linked: int = 0

    def summary(self) -> str:
        return (f"짝 {self.linked}개 | 구글: 새로 {self.g_create}, 수정 {self.g_update}, "
                f"삭제 {self.g_delete} | Notion: 새로 {self.n_create}, "
                f"수정 {self.n_update}, 휴지통 {self.n_delete}")


def _top_ancestor(nid: str, pages: dict[str, Item]) -> str:
    """Notion은 여러 단계 하위가 가능하지만 구글은 1단계뿐 → 최상위 조상으로."""
    seen = set()
    cur = pages[nid].parent_raw if nid in pages else ""
    top = ""
    while cur and cur in pages and cur not in seen:
        seen.add(cur)
        top = cur
        cur = pages[cur].parent_raw
    return top


def sync_list(cfg: dict, g_api, n_api, g_list: str, ds_id: str,
              lst_state: dict, initialized_at: datetime, now: datetime,
              dry_run: bool) -> tuple[dict, Counts]:
    p = cfg["props"]
    c = Counts()
    G = g_api.list_tasks(g_list)
    N = n_api.list_pages(ds_id, p)
    pairs: dict = lst_state.setdefault("pairs", {})
    first_run = not lst_state.get("initialized")

    live_g = {k: v for k, v in G.items() if not v.gone}

    # --- 안전장치: 한쪽이 통째로 비어 보이면 멈춤 ---
    if pairs and (not live_g or not N):
        raise SafetyStop("한쪽 목록이 비어 보여서 멈춤 (일시 오류 가능성)")

    def n_due(n: Item) -> str:
        return (n.extra.get("next_due") or n.due) if n.repeat else n.due

    # --- 1) 사라진 짝 → 삭제 계획 ---
    del_g, del_n, drop = [], [], []
    for gid, pr in pairs.items():
        g_ok = gid in live_g
        n_ok = pr["nid"] in N
        if g_ok and n_ok:
            continue
        drop.append(gid)
        if g_ok and not n_ok:
            del_g.append(gid)
        elif n_ok and not g_ok:
            del_n.append(pr["nid"])
    if len(del_g) + len(del_n) > MAX_DELETES_PER_RUN:
        raise SafetyStop(
            f"한 번에 {len(del_g) + len(del_n)}개를 지우려 해서 멈춤 "
            f"(한도 {MAX_DELETES_PER_RUN}개)")
    for gid in drop:
        pairs.pop(gid)

    # --- 2) 처음 실행: 진행 중 항목끼리 제목으로 짝짓기 (Notion 제목 우선) ---
    linked_n = {pr["nid"] for pr in pairs.values()}
    modes: dict[str, str] = {gid: "normal" for gid in pairs}
    if first_run:
        by_title: dict[str, list[str]] = {}
        for nid, n in N.items():
            if not n.done and n.title and nid not in linked_n:
                by_title.setdefault(n.title, []).append(nid)
        for gid, g in live_g.items():
            if gid in pairs or g.done or not g.title:
                continue
            cands = by_title.get(g.title)
            if cands:
                nid = cands.pop(0)
                pairs[gid] = {"nid": nid, "last": None}
                linked_n.add(nid)
                modes[gid] = "init"

    # --- 3) 짝 없는 새 항목 → 반대쪽에 만들기 ---
    cutoff = max(initialized_at, now - RECENT_DONE_WINDOW)

    def should_link(item: Item, ts: datetime | None) -> bool:
        if not item.title:
            return False
        if not item.done:
            return True
        return bool(ts and ts >= cutoff)

    for gid, g in live_g.items():
        if gid in pairs or not should_link(g, g.done_at or g.updated):
            continue
        vals = {"title": g.title, "notes": g.notes, "due": g.due, "done": g.done}
        nid = f"dry-n-{gid}" if dry_run else n_api.create(ds_id, p, vals)
        N[nid] = Item(id=nid, title=g.title, notes=g.notes, due=g.due, done=g.done,
                      due_raw=g.due or None, updated=now)
        pairs[gid] = {"nid": nid, "last": None}
        linked_n.add(nid)
        modes[gid] = "from_g"
        c.n_create += 1

    for nid, n in N.items():
        if nid in linked_n or not should_link(n, n.created):
            continue
        vals = {"title": n.title, "notes": n.notes, "due": n_due(n), "done": n.done}
        gid = f"dry-g-{nid}" if dry_run else g_api.create(g_list, vals)
        live_g[gid] = Item(id=gid, title=n.title, notes=n.notes, due=n_due(n),
                           done=n.done, updated=now)
        pairs[gid] = {"nid": nid, "last": None}
        linked_n.add(nid)
        modes[gid] = "from_n"
        c.g_create += 1

    # --- 4) 필드별 병합 ---
    n_to_g = {pr["nid"]: gid for gid, pr in pairs.items()}
    parent_fixes = []
    for gid, pr in pairs.items():
        g, n = live_g[gid], N[pr["nid"]]
        last = pr.get("last")
        mode = modes.get(gid, "normal")
        gv = {"title": g.title, "notes": g.notes, "due": g.due, "done": g.done,
              "parent": g.parent_raw if g.parent_raw in pairs else ""}
        top = _top_ancestor(n.id, N)
        nv = {"title": n.title, "notes": n.notes, "due": n_due(n), "done": n.done,
              "parent": n_to_g.get(top, "")}
        g_newer = (g.updated or now) > (n.updated or now)

        new = {}
        for f in FIELDS:
            a, b = gv[f], nv[f]
            if a == b:
                new[f] = a
            elif f == "due" and n.repeat:
                new[f] = b                      # 반복 항목 날짜는 Notion 기준
            elif mode == "from_g":
                new[f] = a
            elif mode == "from_n":
                new[f] = b
            elif mode == "init":
                if f == "title":
                    new[f] = b                  # 처음 연결 시 Notion 제목으로 통일
                elif a in ("", False) or b in ("", False):
                    new[f] = a or b
                else:
                    new[f] = a if g_newer else b
            elif last is not None and a == last.get(f):
                new[f] = b                      # Notion 쪽만 바뀜
            elif last is not None and b == last.get(f):
                new[f] = a                      # 구글 쪽만 바뀜
            else:
                new[f] = a if g_newer else b    # 둘 다 바뀜 → 나중에 고친 쪽

        g_patch = {f: new[f] for f in ("title", "notes", "due", "done") if gv[f] != new[f]}
        n_patch = {f: new[f] for f in ("title", "notes", "due", "done") if nv[f] != new[f]}
        if n.repeat:
            n_patch.pop("due", None)            # 반복 항목의 Notion 날짜는 건드리지 않음
        if g_patch:
            c.g_update += 1
            if not dry_run:
                g_api.update(g_list, gid, g_patch)
        if n_patch:
            c.n_update += 1
            if not dry_run:
                n_api.update(p, n, n_patch)
        if gv["parent"] != new["parent"] or nv["parent"] != new["parent"]:
            parent_fixes.append((gid, new["parent"], gv["parent"], nv["parent"]))

        prev_t = (last or {}).get("t")
        changed = bool(g_patch or n_patch) or last is None or any(
            (last or {}).get(f) != new[f] for f in FIELDS)
        pr["last"] = {**new, "t": iso(now) if changed or not prev_t else prev_t}

    # --- 5) 하위 할 일(부모) 맞추기 ---
    for gid, want, g_cur, n_cur in parent_fixes:
        if g_cur != want:
            c.g_update += 1
            if not dry_run:
                g_api.move(g_list, gid, want)
        if n_cur != want:
            c.n_update += 1
            if not dry_run:
                n_api.set_parent(p, pairs[gid]["nid"], pairs[want]["nid"] if want else "")

    # --- 6) 삭제 실행 ---
    for gid in del_g:
        c.g_delete += 1
        if not dry_run:
            g_api.delete(g_list, gid)
    for nid in del_n:
        c.n_delete += 1
        if not dry_run:
            n_api.trash(nid)

    # --- 7) 오래된 완료 짝 정리 ---
    for gid in list(pairs):
        last = pairs[gid].get("last") or {}
        t = parse_ts(last.get("t"))
        if last.get("done") and t and now - t > PRUNE_AFTER:
            pairs.pop(gid)

    lst_state["initialized"] = True
    c.linked = len(pairs)
    return lst_state, c


def main() -> int:
    dry_run = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")
    now = datetime.now(timezone.utc)
    try:
        g_api = Google(os.environ["GOOGLE_CLIENT_ID"],
                       os.environ["GOOGLE_CLIENT_SECRET"],
                       os.environ["GOOGLE_REFRESH_TOKEN"])
        n_api = Notion(os.environ["NOTION_TOKEN"])
        state_page = os.environ["NOTION_STATE_PAGE_ID"]

        state = n_api.load_state(state_page) or {"version": 1}
        lists = state.setdefault("lists", {})

        log(f"{'[시험 실행] ' if dry_run else ''}동기화 시작")
        for cfg in LIST_CONFIGS:
            ds_id = os.environ.get(cfg["notion_ds_env"])
            if not ds_id:
                log(f"- {cfg['key']}: Notion ID가 없어 건너뜀")
                continue
            g_list = g_api.find_list(cfg["google_list_title"])
            lst_state = lists.setdefault(cfg["key"], {})
            initialized_at = parse_ts(lst_state.get("initialized_at")) or now
            lst_state.setdefault("initialized_at", iso(initialized_at))
            lst, counts = sync_list(cfg, g_api, n_api, g_list, ds_id,
                                    lst_state, initialized_at, now, dry_run)
            lists[cfg["key"]] = lst
            log(f"- {cfg['key']}: {counts.summary()}")

        state["last_run"] = iso(now)
        if dry_run:
            log("시험 실행이라 실제로는 아무것도 바꾸지 않았어요.")
        else:
            n_api.save_state(state_page, state)
            log("완료")
        return 0
    except SafetyStop as e:
        log(f"⛔ 안전장치로 멈춤: {e}")
        return 2
    except KeyError as e:
        log(f"❌ 설정값(Secrets)이 없어요: {e}")
        return 1
    except ApiError as e:
        log(f"❌ {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
