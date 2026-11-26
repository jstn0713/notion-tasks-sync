// 잠깐 생기는 오류는 다시 보내기
import { describe, expect, it, vi } from "vitest";
import { Budget, request, retryable } from "../src/http";

const res = (status: number, body = "{}") => new Response(body, { status });

describe("다시 보내기", () => {
  it("520 같은 Cloudflare 연결 오류도 다시 보냄 (읽기·고치기)", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValueOnce(res(520, "")).mockResolvedValueOnce(res(200, '{"a":1}'));
    const p = request(f as any, new Budget(10), "https://tasks.googleapis.com/x");
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it("연결이 끊겨도 다시 보냄", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(res(200, '{"a":2}'));
    const p = request(f as any, new Budget(10), "https://api.notion.com/x");
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ a: 2 });
    vi.useRealTimers();
  });
  it("새로 만드는 요청은 520 뒤에 다시 보내지 않음 (두 번 생기지 않게)", async () => {
    const f = vi.fn().mockResolvedValue(res(520, ""));
    await expect(request(f as any, new Budget(10), "https://api.notion.com/v1/pages", { method: "POST", once: true })).rejects.toThrow("HTTP 520");
    expect(f).toHaveBeenCalledTimes(1);
    expect(retryable(503, true)).toBe(true);
    expect(retryable(429, true)).toBe(true);
  });
});
