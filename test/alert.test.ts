import { describe, expect, it } from "vitest";
import { cleanChat, cleanToken, errorKind, reportFailure, reportSuccess, welcomeOnce } from "../src/alert";

class FakeKV {
  m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

function setup() {
  const sent: string[] = [];
  const f = (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body).text);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const env: any = { TELEGRAM_BOT_TOKEN: "123456:ABC-def_1", TELEGRAM_CHAT_ID: "987654", ALERTS: new FakeKV() };
  return { sent, f, env };
}

const T0 = Date.parse("2026-11-25T14:00:00Z");
const H = 3600_000;

describe("텔레그램 실패 알림", () => {
  it("처음 실패는 바로, 같은 오류는 하루 한 번만", async () => {
    const { sent, f, env } = setup();
    await reportFailure(env, "❌ GET api.notion.com 실패: HTTP 401", T0, f);
    await reportFailure(env, "❌ GET api.notion.com 실패: HTTP 401", T0 + 5 * 60_000, f);
    await reportFailure(env, "❌ GET api.notion.com 실패: HTTP 401", T0 + 23 * H, f);
    expect(sent).toHaveLength(1);
    await reportFailure(env, "❌ GET api.notion.com 실패: HTTP 401", T0 + 25 * H, f);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("아직 실패 중");
  });

  it("다른 종류의 오류는 바로 알림", async () => {
    const { sent, f, env } = setup();
    await reportFailure(env, "❌ GET api.notion.com 실패: HTTP 401", T0, f);
    await reportFailure(env, "⛔ 안전장치로 멈춤: 한 번에 7개를 지우려 해서 멈춤", T0 + 10 * 60_000, f);
    expect(sent).toHaveLength(2);
  });

  it("숫자만 다른 오류는 같은 종류로 봄", () => {
    expect(errorKind("한 번에 6개를 지우려 해서")).toBe(errorKind("한 번에 9개를 지우려 해서"));
  });

  it("다시 정상이 되면 한 번만 '복구' 알림", async () => {
    const { sent, f, env } = setup();
    await reportSuccess(env, T0, f);
    expect(sent).toHaveLength(0); // 실패한 적 없으면 조용히
    await reportFailure(env, "❌ 오류", T0, f);
    await reportSuccess(env, T0 + 5 * 60_000, f);
    await reportSuccess(env, T0 + 10 * 60_000, f);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("다시 정상");
  });

  it("텔레그램 설정이 없으면 아무것도 안 함", async () => {
    const { sent, f } = setup();
    await reportFailure({ ALERTS: new FakeKV() as any }, "❌ 오류", T0, f);
    expect(sent).toHaveLength(0);
  });

  it("연결 메시지는 한 번만", async () => {
    const { sent, f, env } = setup();
    expect(await welcomeOnce(env, f)).toBe("sent");
    expect(await welcomeOnce(env, f)).toBe("already");
    expect(sent).toHaveLength(1);
  });

  it("복사할 때 같이 붙은 글자는 걸러냄", () => {
    expect(cleanToken(" 토큰: 123456789:AAH-x_y \n")).toBe("123456789:AAH-x_y");
    expect(cleanChat("123456789 예요")).toBe("123456789");
  });

  it("알림에 할 일 내용이 들어가지 않음 (오류 메시지 그대로만)", async () => {
    const { sent, f, env } = setup();
    await reportFailure(env, "❌ PATCH api.notion.com 실패: HTTP 400 validation_error", T0, f);
    expect(sent[0]).toContain("validation_error");
  });
});
