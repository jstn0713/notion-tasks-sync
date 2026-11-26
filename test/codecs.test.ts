// 장바구니 제목·세부정보 변환 규칙
import { describe, expect, it } from "vitest";
import { shoppingCodec } from "../src/codecs";
import type { GRaw } from "../src/types";

const ctx = { stores: ["쿠팡", "네이버", "다이소", "마트", "약국", "당근"] };
const dec = (title: string, notes = "") => shoppingCodec.decode({ title, notes, due: "", done: false }, ctx);

describe("장바구니 제목 읽기", () => {
  it("매장 + 품목 + 수량 + 급함", () => {
    expect(dec("다이소 물티슈 3개 !")).toMatchObject({ store: "다이소", item: "물티슈", qty: "3", urgent: true });
  });
  it("매장 없이 품목만", () => {
    expect(dec("물티슈")).toMatchObject({ store: "", item: "물티슈", qty: "", urgent: false });
  });
  it("다른 이름: N+·엔플 → 네이버, 이마트·코스트코 → 마트", () => {
    expect(dec("N+ 기저귀").store).toBe("네이버");
    expect(dec("엔플 기저귀").store).toBe("네이버");
    expect(dec("이마트 우유").store).toBe("마트");
    expect(dec("코스트코 휴지").store).toBe("마트");
  });
  it("띄어쓰기 없이 붙은 말은 매장으로 보지 않음", () => {
    expect(dec("다이소포인트 적립")).toMatchObject({ store: "", item: "다이소포인트 적립" });
  });
  it("매장 이름만 있으면 품목으로 봄", () => {
    expect(dec("당근")).toMatchObject({ store: "", item: "당근" });
  });
  it("'당근 2개'는 채소 당근 2개, '당근 유모차'는 당근마켓", () => {
    expect(dec("당근 2개")).toMatchObject({ store: "", item: "당근", qty: "2" });
    expect(dec("당근 유모차")).toMatchObject({ store: "당근", item: "유모차" });
  });
  it("'2팩' 같은 다른 단위는 품목 이름에 그대로", () => {
    expect(dec("쿠팡 생수 2팩")).toMatchObject({ store: "쿠팡", item: "생수 2팩", qty: "" });
  });
  it("느낌표는 붙여 써도 됨", () => {
    expect(dec("쿠팡 생수!")).toMatchObject({ item: "생수", urgent: true });
  });
  it("세부정보: 첫 주소는 링크, 나머지는 메모", () => {
    expect(dec("쿠팡 생수", "2L짜리\nhttps://link.coupang.com/a/x1")).toMatchObject({ memo: "2L짜리", link: "https://link.coupang.com/a/x1" });
    expect(dec("쿠팡 생수", "https://coupang.com/vp/1 이거")).toMatchObject({ memo: "이거", link: "https://coupang.com/vp/1" });
  });
});

describe("https:// 없이 적은 주소", () => {
  it("www.… / coupang.com/… / naver.me/… 도 링크로", () => {
    expect(dec("쿠팡 생수", "검정색\nwww.coupang.com")).toMatchObject({ memo: "검정색", link: "www.coupang.com" });
    expect(dec("쿠팡 생수", "coupang.com/vp/products/123")).toMatchObject({ memo: "", link: "coupang.com/vp/products/123" });
    expect(dec("쿠팡 생수", "naver.me/xYz 이거")).toMatchObject({ memo: "이거", link: "naver.me/xYz" });
    expect(dec("쿠팡 생수", "link.coupang.com/a/abc")).toMatchObject({ link: "link.coupang.com/a/abc" });
  });
  it("주소가 아닌 글자는 그대로 메모", () => {
    expect(dec("마트 생수", "1.5L 6개 묶음")).toMatchObject({ memo: "1.5L 6개 묶음", link: "" });
    expect(dec("마트 생수", "a@b.com 에게 물어보기")).toMatchObject({ link: "" });
    expect(dec("마트 생수", "v2.0 버전")).toMatchObject({ link: "" });
  });
  it("Notion 링크 'www.…' → 구글 → 다시 읽어도 그대로 (왕복)", () => {
    const f = { store: "쿠팡", item: "신발 얼룩 지우개", qty: "2", urgent: true, memo: "검정색", link: "www.coupang.com", due: "", done: false };
    expect(shoppingCodec.decode(shoppingCodec.encode(f, ctx) as GRaw, ctx)).toEqual(f);
  });
});

describe("장바구니 제목 만들기", () => {
  it("칸 → 구글 제목·세부정보", () => {
    expect(shoppingCodec.encode({ store: "다이소", item: "물티슈", qty: "3", urgent: true, memo: "두꺼운 거", link: "https://a.b/c", due: "", done: false }, ctx)).toEqual({
      title: "다이소 물티슈 3개 !",
      notes: "두꺼운 거\nhttps://a.b/c",
      due: "",
      done: false,
    });
    expect(shoppingCodec.encode({ store: "", item: "물티슈", qty: "", urgent: false, memo: "", link: "", due: "", done: false }, ctx).title).toBe("물티슈");
  });
  it("만들고 다시 읽으면 같은 값 (왕복)", () => {
    const f = { store: "네이버", item: "기저귀 대형", qty: "2", urgent: false, memo: "", link: "https://naver.me/abc", due: "2026-11-30", done: false };
    expect(shoppingCodec.decode(shoppingCodec.encode(f, ctx) as GRaw, ctx)).toEqual(f);
  });
});
