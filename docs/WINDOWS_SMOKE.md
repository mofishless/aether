# Windows 专项冒烟清单（P0-12）

> 验收口径：**Windows 真机执行 `pnpm verify:p0` 全绿即本清单四项全覆盖**。脚本串联
> lint（oxlint + oxfmt --check）→ typecheck（pnpm -r）→ 单测 + 覆盖率门禁
> （`vitest run --coverage`，五核心包 lines/statements/functions ≥80%，glob 分组见
> `vitest.config.ts` coverage.thresholds）→ build → Playwright E2E 全旅程
> （`apps/desktop/e2e/cockpit.spec.ts`，aether-mock-cli 驱动，无网络无真实 CLI）。
> CI（`.github/workflows/ci.yml` ubuntu + windows 双矩阵）同口径复验，Unit tests 步骤
> 已带 `--coverage`，门禁未达即步骤红。

## 1. ConPTY（终端子系统：预热 / 真 PTY 会话）

- 对应测试：`packages/terminal/tests/conpty-warmup.test.ts`（warmup 置位与尽力而为语义）、
  `packages/terminal/tests/pty-session.test.ts` 与 `pty-utf8.test.ts`（真 PTY 端到端：
  create/write/读输出/resize 后 shell 内实测新尺寸/dispose 后 PID 确认退出/UTF-8 中文）。
- 冒烟口径：verify:p0 单测段在 Windows 上真实拉起 ConPTY（node-pty 1.1.0 精确锁定，
  自带 conpty.dll，prebuild 免编译）；E2E 段驾驶舱六视图渲染含终端连接的 daemon 全链。
- 已知残留：ConPTY 冷启动首次拉起时偶现控制台句柄继承类 stderr 噪声（node-pty /
  ConPTY 上游 wart，非失败判定——测试断言只认退出码与输出内容，噪声不影响绿）。

## 2. 进程树强杀（taskkill /T /F）

- 对应测试：`packages/process-host/tests/kill-tree.test.ts`（三层树 + 双哨兵真进程验收：
  killTree 后轮询断言 5 个 PID 全消失无孤儿 + ExitProof 字段正确 + 已退出/ENOENT 句柄幂等收敛）、
  `kill-tree-converge.test.ts`（taskkill 255"拒绝访问" → tasklist 复核收敛，win32 注入回归）、
  `kill-tree-platform.test.ts`（平台矩阵：覆写 platform 双向驱动 POSIX killTreePosix 全矩阵与
  Windows taskkill 路径，vi.spyOn(process,"kill") + spawn 注入零真实子进程——保证两 OS
  的 kill-tree.ts 覆盖率一致，门禁在 CI 双矩阵同标生效）。
- 冒烟口径：verify:p0 单测段即真树杀（真 taskkill /T /F 三层进程树）。
- 已知残留：taskkill /T 按存活进程父子链遍历——中间层已退出、孙进程被系统改挂父级后
  从根 pid 追不到（Job 对象语义的增量价值），列为 P1+ 强化项（决策注见
  `packages/process-host/src/kill-tree.ts` 文件头）。

## 3. .cmd 包装器（CVE-2024-27980 后安全执行）

- 对应测试：`packages/process-host/tests/quote-windows-arg.test.ts`（argvW + cmd 双层
  转义表驱动，期望值经真实 cmd.exe 往返实验核定）、`spawn-command.test.ts`（真
  .cmd/.bat 执行、含空格参数送达、.exe/无扩展名不包装）、`spawn-mock-cli-spaced-path.test.ts`
  （见第 4 项）；集成与 E2E 真用 `fixtures/aether-mock-cli/cli.cmd`：
  `apps/daemon/tests/agents-mock-cli.integration.test.ts`、`apps/desktop/e2e/cockpit.spec.ts`。
- 冒烟口径：verify:p0 单测段跑 cmd.exe /d /s /c 包装全链；E2E 段 agent 由 cli.cmd 驱动
  跑完全旅程（含权限批准与跟问）。

## 4. 含空格路径

- 对应测试：
  - `packages/core/tests/worktree-spaced-path.test.ts`：项目根 / `.aether-worktrees/` /
    fallback 目录全落含空格目录，worktree 建 → 分支 → 删除全链不炸（双平台跑，不 skipIf）。
  - `packages/process-host/tests/spawn-mock-cli-spaced-path.test.ts`：mock CLI 整目录复制进
    含空格目录，win32 驱动 cli.cmd（cmd.exe 包装 + 脚本路径引号 + `%~dp0` 展开含空格目录 +
    `%*` 透传含空格参数三层转义全链）/ POSIX 驱动 cli.sh（`dirname "$0"` 含空格展开），
    断言回放帧送达 + 退出码 0。
  - `spawn-command.test.ts` 既有四条 win32 用例的临时目录名本身含空格（`aether cmd lab `）。
- 摸底结论（P0-12 收口时）：参数转义已有表驱动覆盖（quote-windows-arg.test.ts），
  "路径本身含空格"此前仅有自建 echo 脚本级覆盖，mock CLI 真身（`%~dp0` 展开一步）与
  worktree 全链级为此卡补齐。
- 冒烟口径：verify:p0 单测段（双平台各自跑本平台腿，两腿都有真实价值）。

## 附：覆盖率门禁口径（P0-12 定案）

- 分组与阈值：`vitest.config.ts` `coverage.thresholds` 按包 glob——
  `packages/contracts/src/**`、`packages/core/src/**`、`packages/adapters/*/src/**`、
  `packages/storage/src/**`、`packages/process-host/src/**` 各 lines/statements/functions ≥80
  （terminal 与 desktop UI 不设线，TECH_STACK §4.3）。
- 收口实测（Windows 真机，全仓 641 测试）：contracts 100/100（四指标全满，报表隐行）、
  core 90/90/100、adapters 91.37/91.71/92.3、storage 82.75/82.55/94.73、
  process-host 97.14/100/100（kill-tree.ts 由 69.09% 补至四指标全 100：55/55 语句、
  8/8 函数、32/32 分支，JSON 报告核定）。
- branches 未设线（如实记录）：adapters 83.46 / process-host 89.47 / contracts 100 过线，
  core 75 / storage 70.45 未达——不硬调阈值放水，P1 补齐分支覆盖后纳入门禁。
