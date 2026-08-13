import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

// 登入頁（middleware 唯一放行的頁面）。dev 環境的 magic link 會輸出在
// `npm run dev` 的 console，點該連結完成登入。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { callbackUrl } = await searchParams;

  async function login(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    if (!email) return;
    await signIn("email", { email, redirectTo: callbackUrl || "/" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-bold">contenthub</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          輸入 email 取得登入連結
        </p>
        <form action={login} className="mt-6 flex flex-col gap-3">
          <input
            type="email"
            name="email"
            required
            placeholder="you@example.com"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
          />
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            寄送登入連結
          </button>
        </form>
        <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">
          開發模式未接郵件服務：登入連結會輸出在 <code className="font-mono">npm run dev</code> 的
          console。
        </p>
      </main>
    </div>
  );
}
