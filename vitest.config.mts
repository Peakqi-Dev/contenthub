import path from "node:path";
import { defineConfig } from "vitest/config";

// 隔離測試需要 DATABASE_URL（本地 prisma dev）；vitest 不會自動載 .env
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, ".env"));
} catch {
  // 沒有 .env（如 CI）時由外部環境變數提供
}

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
