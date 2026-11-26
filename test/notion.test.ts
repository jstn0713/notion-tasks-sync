// Notion 칸 읽기·쓰기 (AI 공방의 '단계' 칸)
import { describe, expect, it } from "vitest";
import { LISTS } from "../src/lists";
import { pageToItem, propsFor } from "../src/notion";

const AI = LISTS.find((l) => l.key === "ai")!;
const page = (stage: string | null) => ({
  id: "p",
  last_edited_time: "2026-11-26T00:00:00Z",
  created_time: "2026-11-26T00:00:00Z",
  properties: {
    이름: { title: [{ plain_text: "주차 위치 기록 앱" }] },
    메모: { rich_text: [] },
    단계: { select: stage ? { name: stage } : null },
  },
});

describe("AI 공방 단계 칸", () => {
  it("아이디어·비어 있음 = 완료 아님, 그 밖의 단계 = 완료", () => {
    expect(pageToItem(page("💡 아이디어"), AI)!.f.done).toBe(false);
    expect(pageToItem(page(null), AI)!.f.done).toBe(false);
    for (const s of ["🛠 개발 중", "🧪 다듬는 중", "✅ 완성", "⏸ 보류"]) expect(pageToItem(page(s), AI)!.f.done).toBe(true);
  });
  it("구글 완료 → 개발 중, 완료 풀기 → 아이디어", () => {
    expect(propsFor(AI, { done: true }, null)).toEqual({ 단계: { select: { name: "🛠 개발 중" } } });
    expect(propsFor(AI, { done: false }, null)).toEqual({ 단계: { select: { name: "💡 아이디어" } } });
  });
});
