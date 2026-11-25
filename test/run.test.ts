// 실제 요청 모양 그대로 가짜 서버에 보내서 전체 흐름을 확인한다.
import { describe, expect, it } from "vitest";
import { runSync } from "../src/index";

const env = {
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "sec",
  GOOGLE_REFRESH_TOKEN: "1//refresh",
  NOTION_TOKEN: "ntn_x",
  NOTION_STATE_PAGE_ID: "state-page",
  NOTION_TODO_DS_ID: "ds-1",
};

function fakeServer() {
  const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [];
  let savedState: string | null = null;
  const f = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? (url.includes("oauth2") ? init.body : JSON.parse(init.body)) : undefined;
    calls.push({ method, url, body, headers: init.headers ?? {} });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "at", expires_in: 3600 });
    if (url.includes("/users/@me/lists")) return ok({ items: [{ id: "L1", title: "할 일" }] });
    if (url.includes("/lists/L1/tasks") && method === "GET")
      return ok({ items: [{ id: "G1", title: "새 할 일", status: "needsAction", updated: "2026-11-25T09:00:00Z" }] });
    if (url.includes("/lists/L1/tasks") && method === "POST") return ok({ id: "G2" });
    if (url.includes("/blocks/state-page/children") && method === "GET") return ok({ results: [] });
    if (url.includes("/blocks/state-page/children") && method === "PATCH") {
      savedState = body.children[0].code.rich_text.map((r: any) => r.text.content).join("");
      return ok({});
    }
    if (url.includes("/data_sources/ds-1/query"))
      return ok({
        results: [
          {
            object: "page",
            id: "N1",
            created_time: "2026-11-25T08:00:00Z",
            last_edited_time: "2026-11-25T08:00:00Z",
            properties: {
              "할 일": { title: [{ plain_text: "노션 할 일" }] },
              완료: { checkbox: false },
              메모: { rich_text: [] },
              마감일: { date: { start: "2026-11-30T15:00:00.000+09:00" } },
              "Parent Task": { relation: [] },
              Frequency: { rich_text: [] },
              "Next Due": { formula: { type: "date", date: null } },
            },
          },
        ],
        has_more: false,
      });
    if (url.endsWith("/v1/pages") && method === "POST") return ok({ id: "N2" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls, saved: () => savedState };
}

describe("전체 흐름", () => {
  it("첫 실행: 양쪽 새 항목을 만들고 장부를 저장", async () => {
    const s = fakeServer();
    const r = await runSync(env, false, Date.parse("2026-11-25T10:00:00Z"), s.f);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.lists.todo).toContain("구글: 새로 1");
    expect(r.lists.todo).toContain("Notion: 새로 1");
    expect(r.requests).toBeLessThanOrEqual(10);

    const notionCreate = s.calls.find((c) => c.url.endsWith("/v1/pages") && c.method === "POST")!;
    expect(notionCreate.body.parent).toEqual({ type: "data_source_id", data_source_id: "ds-1" });
    expect(notionCreate.body.properties["할 일"].title[0].text.content).toBe("새 할 일");
    expect(notionCreate.headers["notion-version"]).toBe("2025-09-03");

    const googleCreate = s.calls.find((c) => c.url.includes("/lists/L1/tasks") && c.method === "POST")!;
    expect(googleCreate.body).toMatchObject({ title: "노션 할 일", due: "2026-11-30T00:00:00.000Z", status: "needsAction" });

    const query = s.calls.find((c) => c.url.includes("/query"))!;
    expect(query.body.filter.or).toHaveLength(2);

    const saved = s.saved()!;
    expect(saved).toBeTruthy();
    expect(saved).not.toContain("새 할 일");
    expect(saved).not.toContain("노션 할 일");
  });

  it("설정값이 없으면 아무것도 안 하고 알려줌", async () => {
    const s = fakeServer();
    const r = await runSync({}, false, Date.now(), s.f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("설정값");
    expect(s.calls).toHaveLength(0);
  });

  it("시험 실행은 쓰기 요청을 보내지 않음", async () => {
    const s = fakeServer();
    const r = await runSync(env, true, Date.parse("2026-11-25T10:00:00Z"), s.f);
    expect(r.ok).toBe(true);
    const writes = s.calls.filter((c) => c.method !== "GET" && !c.url.includes("/query") && !c.url.includes("oauth2"));
    expect(writes).toHaveLength(0);
  });
});
