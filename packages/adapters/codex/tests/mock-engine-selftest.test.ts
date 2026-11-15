// fixtures codex 引擎自测接线（P1-01 组装收口）：fixtures/aether-mock-cli/tests/
// codex-server.test.mjs 是 node:test 零依赖自测（fixtures 目录不进根 vitest include，
// README 遗留注记"接入 CI 由 P1-01 迁移"）——以子进程 `node --test` 拉起并断言全绿，
// 使 pnpm test 覆盖双线对账的 mock 引擎侧（信封/握手门控/审批三分支/resume/EOF）。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELFTEST = fileURLToPath(
  new URL("../../../../fixtures/aether-mock-cli/tests/codex-server.test.mjs", import.meta.url),
);

describe("fixtures codex 引擎自测（node:test 子进程）", () => {
  it(
    "node --test 全绿（12 用例：信封/握手门控/审批三分支/interrupt/resume/EOF/校验负例/包装器冒烟）",
    { timeout: 120_000 },
    () => {
      const stdout = execFileSync(
        process.execPath,
        // flag 必须在文件参数前（node 24 实测：后置会被 spec 报告器覆盖）
        ["--test", "--test-reporter=tap", SELFTEST],
        { encoding: "utf8", windowsHide: true },
      );
      // TAP 口径断言（node --test 失败时退出码非 0 已先行拦截）：
      // # pass 12 / # fail 0 —— 用例数变化时此处同步更新
      expect(stdout).toContain("# pass 12");
      expect(stdout).toContain("# fail 0");
    },
  );
});
