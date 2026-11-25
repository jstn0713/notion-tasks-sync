// 구글 제목·세부정보 ↔ Notion 칸 변환 규칙.
import type { Codec, Ctx, Fields, GRaw } from "./types";

/** TO-DO: 그대로 옮김 */
export const plainCodec: Codec = {
  decode: (t) => ({ title: t.title, notes: t.notes, due: t.due, done: t.done }),
  encode: (f) => ({ title: String(f.title ?? ""), notes: String(f.notes ?? ""), due: String(f.due ?? ""), done: Boolean(f.done) }),
};

// ──────────────────────────────────────────────────────────────
// 장바구니
//   구글 제목:   "[구매처] 품목 [N개] [!]"     예) "다이소 물티슈 3개 !"
//   구글 세부정보: 메모 + 상품 주소(첫 번째 주소는 Notion '링크' 칸으로)
// ──────────────────────────────────────────────────────────────

/** 구매처 다른 이름 → Notion 선택지 이름. 선택지가 실제로 있을 때만 쓴다. */
export const STORE_ALIASES: Record<string, string[]> = {
  네이버: ["n+", "엔플", "네플", "네이버쇼핑"],
  마트: ["이마트", "홈플러스", "롯데마트", "코스트코", "트레이더스"],
};

export function findStore(word: string, stores: string[]): string {
  const w = word.toLowerCase();
  const exact = stores.find((s) => s.toLowerCase() === w);
  if (exact) return exact;
  for (const [target, aliases] of Object.entries(STORE_ALIASES)) {
    if (aliases.includes(w) && stores.includes(target)) return target;
  }
  return "";
}

const URL_RE = /https?:\/\/[^\s<>"']+/;

export const shoppingCodec: Codec = {
  decode(t: GRaw, ctx: Ctx): Fields {
    let title = t.title.trim();
    let urgent = false;
    const bang = title.match(/\s*[!！]+$/);
    if (bang) {
      urgent = true;
      title = title.slice(0, bang.index).trim();
    }
    let qty = "";
    const q = title.match(/\s+(\d+)\s*개$/);
    if (q) {
      qty = String(Number(q[1]));
      title = title.slice(0, q.index).trim();
    }
    let store = "";
    const sp = title.indexOf(" ");
    if (sp > 0) {
      const s = findStore(title.slice(0, sp), ctx.stores);
      const rest = title.slice(sp + 1).trim();
      if (s && rest) {
        store = s;
        title = rest;
      }
    }
    let link = "";
    let memo = t.notes;
    const u = memo.match(URL_RE);
    if (u) {
      link = u[0];
      memo = (memo.slice(0, u.index) + memo.slice((u.index ?? 0) + u[0].length))
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return { item: title, store, qty, urgent, memo, link, due: t.due, done: t.done };
  },

  encode(f: Fields): GRaw {
    const parts = [String(f.store ?? ""), String(f.item ?? ""), f.qty ? `${f.qty}개` : "", f.urgent ? "!" : ""].filter(Boolean);
    const notes = [String(f.memo ?? ""), String(f.link ?? "")].filter(Boolean).join("\n");
    return { title: parts.join(" "), notes, due: String(f.due ?? ""), done: Boolean(f.done) };
  },
};
