import { copyEnvFile } from "./env-copy.js";
import { detectPackageManager, type PackageManager } from "./package-manager.js";

/** worktree 落盘后的非致命收尾步骤（创建与崩溃恢复共用）：
 *  ③ .env 拷贝（存在才拷、失败只 warning）④ 包管理器探测（只探测不安装）。 */
export interface ProvisionExtras {
  packageManager: PackageManager | null;
  envCopied: boolean;
  warnings: readonly string[];
}

export function finishProvision(projectRoot: string, worktreePath: string): ProvisionExtras {
  const warnings: string[] = [];
  const envOutcome = copyEnvFile(projectRoot, worktreePath);
  if (envOutcome.warning !== undefined) {
    warnings.push(envOutcome.warning);
  }
  const packageManager = detectPackageManager(projectRoot);
  return { packageManager, envCopied: envOutcome.copied, warnings: [...warnings] };
}
