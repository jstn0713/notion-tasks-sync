// 목록마다 칸 구성이 달라서, 칸 이름과 변환 규칙을 목록 설정(ListConfig)으로 받는다.

/** 칸 하나의 값. 날짜는 "YYYY-MM-DD", 숫자는 "3" 같은 글자, 없으면 "" */
export type Value = string | boolean;
export type Fields = Record<string, Value>;

/** 구글 Tasks 항목 그대로의 모양 (구글에는 제목·세부정보·날짜·완료뿐) */
export interface GRaw {
  title: string;
  notes: string;
  due: string;
  done: boolean;
}

export interface GTask extends GRaw {
  id: string;
  parentRaw: string;
  updated: number;
  doneAt?: number;
  gone?: boolean;
  position?: string; // 목록 안 순서 (작을수록 위)
}

export interface NPage {
  id: string;
  f: Fields;
  parentRaw: string;
  updated: number;
  created: number;
  dateRaw: Record<string, string | null>; // 날짜 칸의 원래 값(시간 포함 가능)
  repeat?: boolean;
  nextDue?: string;
  stageRaw?: string; // 단계(stage) 칸의 지금 선택지 이름
}

export type NotionType = "title" | "rich_text" | "checkbox" | "date" | "select" | "number" | "url" | "stage" | "stageDev";

export interface FieldSpec {
  name: string; // 프로그램 안에서 쓰는 칸 이름 (장부 호환을 위해 TO-DO 는 title/notes/due/done)
  notion: string; // Notion 속성 이름
  type: NotionType;
  // 단계(select) 칸 하나를 두 칸으로 나눠 본다 (AI 공방).
  //   type "stage"    → 'done': idea·dev 단계(또는 비어 있음)가 아니면 완료
  //   type "stageDev" → 'dev' : dev 단계인지
  //   구글에서 완료하면 later 로, 완료를 풀면 idea 또는 dev 로 바꾼다.
  idea?: string;
  dev?: string;
  later?: string;
}

/** 구글 제목·세부정보 ↔ 칸들 변환 */
export interface Ctx {
  stores: string[]; // Notion 구매처 선택지 (실행할 때마다 Notion 에서 읽음)
}
export interface Codec {
  decode(t: GRaw, ctx: Ctx): Fields;
  /** 값이 undefined 인 구글 칸(예: 날짜를 연동하지 않는 목록의 due)은 건드리지 않는다 */
  encode(f: Fields, ctx: Ctx): GRawOut;
}
export type GRawOut = { title: string; notes: string; done: boolean; due?: string };

export interface ListConfig {
  key: string;
  googleListTitle: string;
  notionDsEnv: string;
  fields: FieldSpec[]; // 'done'(checkbox 또는 stage) 칸은 꼭 있어야 함
  titleField: string; // 짝짓기·빈 줄 판단에 쓰는 칸
  codec: Codec;
  parentProp?: string; // 하위 할 일 연동 (Notion relation)
  repeat?: { frequencyProp: string; nextDueProp: string; field: string }; // 반복 항목
  storeProp?: string; // 이 select 속성의 선택지를 ctx.stores 로 읽음
  /**
   * 완료 아닌 동안에만 뜻이 있는 칸 (AI 공방의 'dev').
   * 완료된 동안에는 구글 쪽 값(제목 앞 '(개발중)')이 '완료 전 단계'를 기억하고 있다가,
   * 완료를 풀면 그 단계로 돌아간다. 이 칸이 켜지면 구글에서 목록 맨 아래로 옮긴다.
   */
  openOnlyField?: string;
}

export interface GoogleApi {
  findList(title: string): Promise<string>;
  listTasks(listId: string, completedMin: number): Promise<Map<string, GTask>>;
  getTask(listId: string, id: string): Promise<GTask | null>;
  create(listId: string, raw: Partial<GRaw>): Promise<string>; // 값이 undefined 인 칸은 보내지 않음
  update(listId: string, id: string, raw: Partial<GRaw>): Promise<void>;
  move(listId: string, id: string, parent: string, previous?: string): Promise<void>; // previous 바로 뒤로 (없으면 맨 위)
  remove(listId: string, id: string): Promise<void>;
}

export interface NotionApi {
  selectOptions(dsId: string, prop: string): Promise<string[]>;
  listPages(dsId: string, cfg: ListConfig, editedSince: number): Promise<Map<string, NPage>>;
  getPage(id: string, cfg: ListConfig): Promise<NPage | null>;
  create(dsId: string, cfg: ListConfig, f: Fields): Promise<string>;
  update(cfg: ListConfig, page: NPage, f: Fields): Promise<void>;
  setParent(cfg: ListConfig, id: string, parentId: string): Promise<void>;
  trash(id: string): Promise<void>;
}
