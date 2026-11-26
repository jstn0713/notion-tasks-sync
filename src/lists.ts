// 연결할 목록들. 새 목록은 여기에 추가한다.
import { ideaCodec, plainCodec, shoppingCodec } from "./codecs";
import type { ListConfig } from "./types";

export const LISTS: ListConfig[] = [
  {
    key: "todo",
    googleListTitle: "할 일",
    notionDsEnv: "NOTION_TODO_DS_ID",
    titleField: "title",
    codec: plainCodec,
    fields: [
      { name: "title", notion: "할 일", type: "title" },
      { name: "notes", notion: "메모", type: "rich_text" },
      { name: "due", notion: "마감일", type: "date" },
      { name: "done", notion: "완료", type: "checkbox" },
    ],
    parentProp: "Parent Task",
    repeat: { frequencyProp: "Frequency", nextDueProp: "Next Due", field: "due" },
  },
  {
    key: "shopping",
    googleListTitle: "살 것들",
    notionDsEnv: "NOTION_SHOPPING_DS_ID",
    titleField: "item",
    codec: shoppingCodec,
    storeProp: "구매처",
    fields: [
      { name: "item", notion: "품목", type: "title" },
      { name: "store", notion: "구매처", type: "select" },
      { name: "qty", notion: "수량", type: "number" },
      { name: "urgent", notion: "급함", type: "checkbox" },
      { name: "memo", notion: "메모", type: "rich_text" },
      { name: "link", notion: "링크", type: "url" },
      { name: "due", notion: "살 날짜", type: "date" },
      { name: "done", notion: "구매완료", type: "checkbox" },
    ],
  },
  {
    // AI 공방: 구글에는 '💡 아이디어' 단계만 보인다. 구글 완료 = '🛠 개발 중' 시작.
    key: "ai",
    googleListTitle: "AI로 만들 것들",
    notionDsEnv: "NOTION_AI_DS_ID",
    titleField: "title",
    codec: ideaCodec,
    fields: [
      { name: "title", notion: "이름", type: "title" },
      { name: "notes", notion: "메모", type: "rich_text" },
      { name: "done", notion: "단계", type: "stage", idea: "💡 아이디어", started: "🛠 개발 중" },
    ],
  },
];
