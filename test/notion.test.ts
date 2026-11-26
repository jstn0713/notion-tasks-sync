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
  it("아이디어·비어 있음 = 진행 중, 개발 중 = 진행 중 + 개발중 표시, 그 밖 = 완료", () => {
    expect(pageToItem(page("💡 아이디어"), AI)!.f).toMatchObject({ done: false, dev: false });
    expect(pageToItem(page(null), AI)!.f).toMatchObject({ done: false, dev: false });
    expect(pageToItem(page("🛠 개발 중"), AI)!.f).toMatchObject({ done: false, dev: true });
    for (const s of ["🧪 다듬는 중", "✅ 완성", "⏸ 보류"]) expect(pageToItem(page(s), AI)!.f).toMatchObject({ done: true, dev: false });
  });
  it("바꿀 단계: 완료 → 다듬는 중(이미 완성·보류면 그대로), 완료 풀기 → 아이디어 또는 개발 중", () => {
    const old = (s: string) => pageToItem(page(s), AI);
    expect(propsFor(AI, { done: true }, old("🛠 개발 중"))).toEqual({ 단계: { select: { name: "🧪 다듬는 중" } } });
    expect(propsFor(AI, { done: true }, old("✅ 완성"))).toEqual({});
    expect(propsFor(AI, { done: false, dev: true }, old("🧪 다듬는 중"))).toEqual({ 단계: { select: { name: "🛠 개발 중" } } });
    expect(propsFor(AI, { done: false }, old("⏸ 보류"))).toEqual({ 단계: { select: { name: "💡 아이디어" } } });
    expect(propsFor(AI, { dev: true }, old("💡 아이디어"))).toEqual({ 단계: { select: { name: "🛠 개발 중" } } });
    expect(propsFor(AI, { title: "새 줄", notes: "", done: false, dev: false }, null)).toMatchObject({ 단계: { select: { name: "💡 아이디어" } } });
  });
});
