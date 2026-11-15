import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm";

// 探测优先级：pnpm 在前（本仓自身为 pnpm monorepo；两锁文件并存时取 pnpm）。
const LOCK_FILES: readonly (readonly [PackageManager, string])[] = [
  ["pnpm", "pnpm-lock.yaml"],
  ["npm", "package-lock.json"],
];

/** 探测包管理器：pnpm-lock.yaml → pnpm；package-lock.json → npm；都没有 → null。
 *  只探测提示、不阻塞、不安装（依赖安装治理移 P1-12，任务卡 P0-05）。 */
export function detectPackageManager(projectRoot: string): PackageManager | null {
  for (const [packageManager, lockFile] of LOCK_FILES) {
    if (existsSync(join(projectRoot, lockFile))) {
      return packageManager;
    }
  }
  return null;
}
