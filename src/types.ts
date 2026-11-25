// 구글과 Notion 항목을 같은 모양으로 다루기 위한 공통 타입.

export interface Item {
  id: string;
  title: string;
  notes: string;
  due: string; // "YYYY-MM-DD" 또는 ""
  done: boolean;
  parentRaw: string; // 같은 쪽 안에서의 부모 ID
  updated: number; // ms
  created?: number; // ms (Notion)
  doneAt?: number; // ms (구글 완료 시각)
  gone?: boolean; // 구글: 삭제됨
  dueRaw?: string | null; // Notion 원래 날짜 값(시간 포함 가능)
  repeat?: boolean; // Notion: 반복 항목
  nextDue?: string; // Notion: 다음 마감일
}

export interface Vals {
  title?: string;
  notes?: string;
  due?: string;
  done?: boolean;
}

export interface Props {
  title: string;
  done: string;
  notes: string;
  due: string;
  parent: string;
  frequency?: string;
  nextDue?: string;
}

export interface ListConfig {
  key: string;
  googleListTitle: string;
  notionDsEnv: string;
  props: Props;
}

export interface GoogleApi {
  findList(title: string): Promise<string>;
  listTasks(listId: string, completedMin: number): Promise<Map<string, Item>>;
  getTask(listId: string, id: string): Promise<Item | null>;
  create(listId: string, vals: Vals): Promise<string>;
  update(listId: string, id: string, vals: Vals): Promise<void>;
  move(listId: string, id: string, parent: string): Promise<void>;
  remove(listId: string, id: string): Promise<void>;
}

export interface NotionApi {
  listPages(dsId: string, p: Props, editedSince: number): Promise<Map<string, Item>>;
  getPage(id: string, p: Props): Promise<Item | null>;
  create(dsId: string, p: Props, vals: Vals): Promise<string>;
  update(p: Props, page: Item, vals: Vals): Promise<void>;
  setParent(p: Props, id: string, parentId: string): Promise<void>;
  trash(id: string): Promise<void>;
}
