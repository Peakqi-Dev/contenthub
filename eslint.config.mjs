import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  // ── 租戶隔離邊界（規格追加 §2）──
  // PrismaClient 只准在 src/lib/db/ 內建立
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["src/lib/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              importNames: ["PrismaClient"],
              message: "PrismaClient 只能在 src/lib/db/ 內建立，其他地方請用 @/lib/db 的 prisma 或 getScopedDb()。",
            },
          ],
        },
      ],
    },
  },
  // route handler / 頁面層禁止直接拿 raw prisma，一律走 getScopedDb(userId)
  {
    files: ["src/app/**/*.ts", "src/app/**/*.tsx", "src/middleware.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              importNames: ["PrismaClient"],
              message: "PrismaClient 只能在 src/lib/db/ 內建立。",
            },
            {
              name: "@/lib/db",
              message: "route / 頁面層禁止直接用 prisma，請改用 getScopedDb(userId)（@/lib/db/scoped）。",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
