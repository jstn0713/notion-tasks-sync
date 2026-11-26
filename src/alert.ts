// 텔레그램 실패 알림.
// - 같은 오류는 하루 한 번만, 다른 오류는 바로, 다시 정상이 되면 '복구' 알림 한 번.
// - 잠깐 끊기는 오류(429·5xx·연결 끊김)는 연속 TRANSIENT_AFTER(3)번(약 15분) 실패했을 때만 알린다.
//   비밀번호·설정 문제, 안전장치 멈춤은 바로 알린다. (사용자 결정 2026-11-26)
// - 무엇을 보냈는지는 Cloudflare KV(ALERTS)에 기억한다. 텔레그램 설정이 없으면 아무것도 안 한다.
// - 알림에는 할 일 내용이 들어가지 않는다 (오류 메시지에는 개수·상태 코드만 있음).

export interface AlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERTS?: KVNamespace;
}

interface AlertRecord {
  kind: string;
  since: number;
  sentAt: number;
}

const KEY = "alert";
const STREAK_KEY = "streak";
export const TRANSIENT_AFTER = 3;

interface Streak {
  count: number;
  since: number;
}

/** 잠깐 생기는 오류인지 (다음 실행 때 저절로 풀릴 가능성이 큰지) */
export function isTransient(msg: string): boolean {
  return /HTTP (429|5\d\d)\b/.test(msg) || /연결 실패/.test(msg);
}
const WELCOME_KEY = "welcomed";
const DAY = 86400_000;

/** "123456789:AAH..." 모양만 골라낸다 (앞뒤에 같이 복사된 글자가 있어도) */
export function cleanToken(s?: string): string {
  return (s ?? "").match(/\d+:[A-Za-z0-9_-]+/)?.[0] ?? "";
}
export function cleanChat(s?: string): string {
  return (s ?? "").match(/-?\d+/)?.[0] ?? "";
}

/** 숫자를 지운 오류 종류 (같은 종류인지 비교용) */
export function errorKind(msg: string): string {
  return msg.replace(/\d+/g, "#").trim();
}

const kst = (ms: number) =>
  new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ").replace("-", "/");

export async function sendTelegram(env: AlertEnv, text: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const token = cleanToken(env.TELEGRAM_BOT_TOKEN);
  const chat = cleanChat(env.TELEGRAM_CHAT_ID);
  if (!token || !chat) return false;
  try {
    const r = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const enabled = (env: AlertEnv) => Boolean(env.ALERTS && cleanToken(env.TELEGRAM_BOT_TOKEN) && cleanChat(env.TELEGRAM_CHAT_ID));

export async function reportFailure(env: AlertEnv, error: string, now: number, fetcher: typeof fetch = fetch): Promise<void> {
  if (!enabled(env)) return;
  const kv = env.ALERTS!;
  const kind = errorKind(error);
  const prev = (await kv.get<AlertRecord>(KEY, "json")) ?? null;
  // 연속 실패 횟수 (오류 종류와 상관없이 '실패가 이어진' 횟수)
  const st = (await kv.get<Streak>(STREAK_KEY, "json")) ?? { count: 0, since: now };
  const streak: Streak = { count: st.count + 1, since: st.since };
  await kv.put(STREAK_KEY, JSON.stringify(streak));
  if (!prev && isTransient(error) && streak.count < TRANSIENT_AFTER) return;
  const isNew = !prev || prev.kind !== kind;
  if (!isNew && now - prev!.sentAt < DAY) return;
  const since = isNew ? (prev ? now : streak.since) : prev!.since;
  const text =
    (isNew ? "⚠️ 구글 Tasks ↔ Notion 동기화가 실패했어요\n\n" : `⚠️ 동기화가 아직 실패 중이에요 (${kst(since)}부터)\n\n`) +
    `이유: ${error}\n\n` +
    "같은 오류는 하루 한 번만 알려드려요. 다시 정상이 되면 알려드릴게요.\n" +
    "자세한 기록: Cloudflare → Workers & Pages → notion-tasks-sync → Logs";
  if (await sendTelegram(env, text, fetcher)) {
    await kv.put(KEY, JSON.stringify({ kind, since, sentAt: now } satisfies AlertRecord));
  }
}

export async function reportSuccess(env: AlertEnv, now: number, fetcher: typeof fetch = fetch): Promise<void> {
  if (!enabled(env)) return;
  const kv = env.ALERTS!;
  if (await kv.get(STREAK_KEY)) await kv.delete(STREAK_KEY);
  const prev = await kv.get<AlertRecord>(KEY, "json");
  if (!prev) return;
  await sendTelegram(env, `✅ 구글 Tasks ↔ Notion 동기화가 다시 정상이에요 (${kst(prev.since)}부터 실패했었어요)`, fetcher);
  await kv.delete(KEY);
}

/** 처음 연결됐을 때 한 번만 '연결됐어요' 메시지를 보낸다. 보냈으면 true */
export async function welcomeOnce(env: AlertEnv, fetcher: typeof fetch = fetch): Promise<"sent" | "already" | "off" | "failed"> {
  if (!enabled(env)) return "off";
  const kv = env.ALERTS!;
  if (await kv.get(WELCOME_KEY)) return "already";
  const ok = await sendTelegram(
    env,
    "🔔 구글 Tasks ↔ Notion 동기화 실패 알림이 연결됐어요.\n동기화가 실패하면 여기로 알려드릴게요. (같은 오류는 하루 한 번)",
    fetcher,
  );
  if (!ok) return "failed";
  await kv.put(WELCOME_KEY, "1");
  return "sent";
}
