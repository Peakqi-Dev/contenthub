import { Platform } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { registeredPlatforms } from "@/lib/adapters";
import { getScopedDb, type ScopedDb } from "@/lib/db/scoped";

// Sprint 0 暫時的狀態首頁：顯示系統健康、adapter 進度、帳號與最近任務。
// Sprint 2 會被正式編輯器 UI（/compose 等）取代。

export const dynamic = "force-dynamic";

// 實作順序（規格 v1.1，2026-08-14 二次修訂）
const ADAPTER_ORDER: { platform: Platform; label: string; note: string }[] = [
  { platform: Platform.FAKE, label: "Fake", note: "架構驗證：狀態機 / 重試 / 冪等" },
  { platform: Platform.THREADS, label: "Threads", note: "Meta 家族最小樣本" },
  { platform: Platform.FACEBOOK_PAGE, label: "FB 粉專", note: "容器模式 + token 刷新" },
  { platform: Platform.INSTAGRAM, label: "Instagram", note: "FEED / STORY / REEL" },
  { platform: Platform.X, label: "X", note: "linkInComment 成本開關" },
  { platform: Platform.MEDIUM, label: "Medium", note: "ASSISTED" },
  { platform: Platform.LINE_OA, label: "LINE OA", note: "推播計費，最後實作" },
];

const JOB_BADGE: Record<string, string> = {
  PUBLISHED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  PROCESSING: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
};

function fmt(d: Date) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

async function loadData(db: ScopedDb) {
  try {
    const [accounts, jobs] = await Promise.all([
      db.socialAccount.findMany(),
      db.publishJob.findMany({ take: 10 }),
    ]);
    return { ok: true as const, accounts, jobs };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }
}

export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login"); // middleware 已擋，這裡是保險
  const db = getScopedDb(session.user.id);

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  const registered = new Set<Platform>(registeredPlatforms());
  const data = await loadData(db);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="mx-auto max-w-3xl px-6 py-12 flex flex-col gap-8">
        <header>
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-bold">contenthub</h1>
            <form action={logout} className="flex items-center gap-3 text-xs text-zinc-500">
              <span>{session.user.email}</span>
              <button
                type="submit"
                className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                登出
              </button>
            </form>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            多平台社群內容發布系統 — 一次撰寫 → 各平台變體 → 預檢 → 排程 → 分發
          </p>
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            Sprint 0 完成（schema / adapter 框架 / 合約測試）・此頁為暫時狀態頁，Sprint 2 由編輯器 UI 取代
          </p>
        </header>

        {!data.ok && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
            <p className="font-semibold">資料庫連不上</p>
            <p className="mt-1">
              請確認 <code className="font-mono">DATABASE_URL</code> 環境變數（Vercel 上需指向雲端
              Postgres，並跑過 <code className="font-mono">prisma migrate deploy</code>）。
            </p>
            <p className="mt-2 font-mono text-xs opacity-70">{data.error}</p>
          </div>
        )}

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Adapter 進度（v1.1 實作順序）
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {ADAPTER_ORDER.map((a, i) => {
              const done = registered.has(a.platform);
              const isNext = !done && ADAPTER_ORDER.findIndex((x) => !registered.has(x.platform)) === i;
              return (
                <li
                  key={a.platform}
                  className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span className="text-lg">{done ? "✅" : isNext ? "🔜" : "⬜"}</span>
                  <div>
                    <p className="text-sm font-medium">
                      {i + 1}. {a.label}
                      {isNext && (
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 dark:bg-blue-900/50 dark:text-blue-300">
                          下一個
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{a.note}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              已連結帳號
            </h2>
            {/* OAuth 起點必須整頁導航（不能 Link prefetch API 路由） */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/api/accounts/connect/threads"
              className="text-xs text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            >
              連結 Threads →
            </a>
          </div>
          {data.ok && data.accounts.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {data.accounts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span>
                    <span className="font-medium">{a.displayName}</span>
                    <span className="ml-2 text-xs text-zinc-500">{a.platform}</span>
                  </span>
                  <span className="text-xs text-zinc-500">
                    {a.isActive ? (a.healthStatus ?? "—") : "已停用"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              尚無帳號。填好 .env 的 THREADS_APP_ID / THREADS_APP_SECRET 後，點右上「連結
              Threads」完成授權。
            </p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            最近發布任務
          </h2>
          {data.ok && data.jobs.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {data.jobs.map((j) => (
                <li
                  key={j.id}
                  className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {j.variant.account.displayName}
                      <span className="ml-2 text-xs text-zinc-500">
                        {j.variant.account.platform}・{j.variant.surface}
                      </span>
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${JOB_BADGE[j.status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}
                    >
                      {j.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">
                    {j.variant.body}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                    {fmt(j.createdAt)}
                    {j.externalUrl && (
                      <>
                        {" ・ "}
                        <a
                          href={j.externalUrl}
                          className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看貼文
                        </a>
                      </>
                    )}
                    {j.errorCode && (
                      <span className="text-red-500"> ・ {j.errorCode}</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">尚無任務。</p>
          )}
        </section>

        <footer className="border-t border-zinc-200 pt-4 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          API：<code className="font-mono">POST /api/publish</code>・
          <code className="font-mono">GET /api/jobs</code>・
          <code className="font-mono">GET /api/accounts</code>・
          <code className="font-mono">GET /api/capabilities</code>
        </footer>
      </main>
    </div>
  );
}
