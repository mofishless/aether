import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../errors.js";

/** .env 拷贝：项目根存在 .env 才拷；拷贝失败不致命——返回 warning 由调用方记录（任务卡 P0-05）。 */
export interface EnvCopyOutcome {
  copied: boolean;
  warning?: string;
}

export function copyEnvFile(projectRoot: string, worktreePath: string): EnvCopyOutcome {
  const source = join(projectRoot, ".env");
  if (!existsSync(source)) {
    return { copied: false };
  }
  try {
    copyFileSync(source, join(worktreePath, ".env"));
    return { copied: true };
  } catch (error) {
    return {
      copied: false,
      warning: `.env 拷贝失败（${source} → ${worktreePath}）：${errorMessage(error)}`,
    };
  }
}
