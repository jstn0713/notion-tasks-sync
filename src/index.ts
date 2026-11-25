// Cloudflare Worker 시작점.
// - 5분마다 cron  : 구글 Tasks ↔ Notion 동기화
// - POST /run     : 배포 직후 확인용·수동 실행용 (x-run-secret 이 맞아야 함). ?dry=1 이면 시험 실행
// 로그에는 할 일 내용 없이 개수만 남긴다.

import { Budget, ApiError } from "./http";
import { Google } from "./google";
import { Notion } from "./notion";
import { SafetyStop, summary, syncList, type Counts, type ListState } from "./engine";
import { LISTS } from "./lists";
import type { Ctx } from "./types";
import { reportFailure, reportSuccess, welcomeOnce } from "./alert";

export { LISTS };

export interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  NOTION_TOKEN?: string;
  NOTION_STATE_PAGE_ID?: string;
  NOTION_TODO_DS_ID?: string;
  NOTION_SHOPPING_DS_ID?: string;
  RUN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERTS?: KVNamespace;
  [k: string]: unknown;
}

const REQUEST_LIMIT = 48; // 무료 플랜: 실행 한 번에 외부 요청 50개 (여유 2개)

export interface RunResult {
  ok: boolean;
  dry: boolean;
  lists: Record<string, string>;
  error?: string;
  requests: number;
  telegram?: string;
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/**
 * allowInit: 처음 연결(짝짓기)을 해도 되는지. 5분 자동 실행은 false 라서,
 * 새 목록은 사용자가 Actions 에서 '지금 바로 동기화'를 눌러야 처음 연결된다.
 */
export async function runSync(env: Env, dry: boolean, now = Date.now(), fetcher: typeof fetch = fetch, allowInit = true): Promise<RunResult> {
  const budget = new Budget(REQUEST_LIMIT);
  const result: RunResult = { ok: false, dry, lists: {}, requests: 0 };
  try {
    const need = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NOTION_TOKEN", "NOTION_STATE_PAGE_ID"];
    const missing = need.filter((k) => !clean(env[k]));
    if (missing.length) throw new ApiError(`설정값(Secrets)이 없어요: ${missing.join(", ")}`);

    const g = await Google.connect(fetcher, budget, clean(env.GOOGLE_CLIENT_ID), clean(env.GOOGLE_CLIENT_SECRET), clean(env.GOOGLE_REFRESH_TOKEN), now);
    const n = new Notion(fetcher, budget, clean(env.NOTION_TOKEN));
    const statePage = clean(env.NOTION_STATE_PAGE_ID);
    const { state, blockId } = await n.loadState(statePage);
    state.version ??= 1;
    state.lists ??= {};

    for (const cfg of LISTS) {
      const dsId = clean(env[cfg.notionDsEnv]);
      if (!dsId) {
        result.lists[cfg.key] = "Notion ID 가 없어 건너뜀";
        continue;
      }
      if (!dry && !allowInit && !state.lists[cfg.key]?.initialized) {
        result.lists[cfg.key] = "처음 연결 대기 중 (Actions → deploy → '지금 바로 동기화'를 누르면 시작)";
        continue;
      }
      const gList = await g.findList(cfg.googleListTitle);
      const ctx: Ctx = { stores: cfg.storeProp ? await n.selectOptions(dsId, cfg.storeProp) : [] };
      const st: ListState = (state.lists[cfg.key] ??= {});
      const counts: Counts = await syncList({ cfg, g, n, budget, gList, dsId, st, now, dryRun: dry, ctx });
      result.lists[cfg.key] = summary(counts);
    }

    state.last_run = new Date(now).toISOString();
    if (!dry) await n.saveState(statePage, blockId, state);
    result.ok = true;
  } catch (e) {
    if (e instanceof SafetyStop) result.error = `⛔ 안전장치로 멈춤: ${e.message}`;
    else if (e instanceof ApiError) result.error = `❌ ${e.message}`;
    else result.error = `❌ 예상 못 한 오류: ${e instanceof Error ? e.name : "unknown"}`;
  }
  result.requests = budget.used;
  return result;
}

function logResult(r: RunResult) {
  const head = `${r.dry ? "[시험 실행] " : ""}${r.ok ? "동기화 완료" : "동기화 실패"} (요청 ${r.requests}개)`;
  const lines = [head, ...Object.entries(r.lists).map(([k, v]) => `- ${k}: ${v}`)];
  if (r.error) lines.push(r.error);
  (r.ok ? console.log : console.error)(lines.join("\n"));
}

export default {
  async scheduled(_c: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const r = await runSync(env, false, now, fetch, false);
    logResult(r);
    try {
      if (r.ok) await reportSuccess(env, now);
      else await reportFailure(env, r.error ?? "동기화 실패", now);
      await welcomeOnce(env); // 배포 직후 못 보냈으면 여기서 (한 번만)
    } catch (e) {
      console.error(`텔레그램 알림 처리 중 오류: ${e instanceof Error ? e.name : "unknown"}`);
    }
    if (!r.ok) throw new Error(r.error ?? "동기화 실패"); // Cloudflare 대시보드에 '실패'로 표시
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/run") {
      const secret = clean(env.RUN_SECRET);
      if (!secret || req.headers.get("x-run-secret") !== secret) return new Response("forbidden", { status: 403 });
      const r = await runSync(env, url.searchParams.get("dry") === "1");
      logResult(r);
      try {
        r.telegram = await welcomeOnce(env);
      } catch {
        r.telegram = "failed";
      }
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("notion-tasks-sync: 동작 중", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
