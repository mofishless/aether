// killTree：跨平台进程树强杀。平台分支集中在本文件一处（spawn/其余模块不感知平台差异）。
//
// ===== 决策定案（写给 spec-review）：Windows 树杀选 taskkill /T /F，而非 Job 对象 =====
// 1) 零依赖：taskkill 为系统自带工具；Job 对象（kill-on-close，宿主崩溃连带杀全树）需要
//    原生 N-API 模块 → node-gyp 编译 + Electron ABI 重编 + win/linux 双平台构建矩阵，
//    违反 P0"零原生模块"硬性纪律。
// 2) 验收对齐：P0-06 验收 = "树杀后 Windows 与 POSIX 均无孤儿存活 + PID 级退出证明"；
//    taskkill /T（按父子关系递归终止整树）/F（强杀）满足验收（tests/kill-tree.test.ts
//    三层 fixture + 双哨兵在双平台 CI 矩阵上跑绿）。
// 3) 平替位：killTree 接口已按"树杀"抽象（handle|pid 入参、alreadyGone 收敛语义），
//    P1+ 如需"宿主崩溃连带杀全树"语义，可在本文件单点替换为 Job 对象实现，调用方不动。
// 已知局限（taskkill /T 机制固有）：树按存活进程的父子链遍历；若中间层已退出、其子进程
// 已被系统重挂父级（孤儿改挂），从根 pid 出发追不到它们——该场景正是 Job 对象的增量价值，
// 列为 P1+ 强化项。
//
// POSIX：process.kill(-pgid, "SIGKILL") 整组击杀。前提 = spawnTracked 的 detached 模式
// （子进程即组长 pgid=pid，后代默认同组）。局限：非 detached 句柄 / 裸 pid 在 POSIX 上
// 无法可靠得知 pgid，退化为"先试 -pid（若恰为组长则整组）、ESRCH 再单杀 pid"的尽力而为
// ——存在 PID 复用误杀无关进程组的固有风险（详见 killTreePosix 内注释）；
// 树杀请用 detached 模式的句柄（TASK_LIST P0-06 验收口径）。
import { markKilledByUs } from "./kill-marker.js";
import { spawnTracked } from "./spawn-tracked.js";
import type { KillTreeResult, ProcessHandle } from "./types.js";

const IS_WINDOWS = process.platform === "win32";

/** Windows taskkill 对"目标不存在"的退出码（其余非 0 视为失败） */
const TASKKILL_NOT_FOUND = 128;

export async function killTree(target: ProcessHandle | number): Promise<KillTreeResult> {
  if (typeof target === "number") {
    return IS_WINDOWS ? await killTreeWindowsPid(target) : killTreePosix(target, null);
  }
  const pid = target.pid;
  if (pid === null) {
    // 进程从未创建（spawn error）：无可杀者
    return Object.freeze({
      pid: null,
      method: IS_WINDOWS ? ("taskkill" as const) : ("process-group" as const),
      alreadyGone: true,
    });
  }
  markKilledByUs(target);
  return IS_WINDOWS ? await killTreeWindowsPid(pid) : killTreePosix(pid, target.pgid);
}

/** Windows：taskkill /PID <pid> /T /F——递归终止整棵进程树（决策注释见文件头） */
async function killTreeWindowsPid(pid: number): Promise<KillTreeResult> {
  // stdout 只打每进程一行 SUCCESS（无诊断价值）且我们从不消费——pipe 会在大树
  // （~80+ 进程 × 4KB 管道缓冲）时写满阻塞 taskkill 导致树杀永久挂起，故 ignore；
  // stderr 保留 pipe 供失败路径的尾部诊断。
  const handle = spawnTracked("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  const stderr = handle.stderr;
  if (stderr !== null) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-500);
    });
  }
  const proof = await handle.exited;
  if (proof.code === 0) {
    return Object.freeze({ pid, method: "taskkill", alreadyGone: false });
  }
  if (proof.code === TASKKILL_NOT_FOUND) {
    // 目标进程不存在：语义上等价于已杀完（竞态：树在动手前已自行消失）
    return Object.freeze({ pid, method: "taskkill", alreadyGone: true });
  }
  // 其余非 0（实测 255"拒绝访问"）：目标多半已处于终止路径——taskkill 快照仍见其
  // 条目，而 TerminateProcess 对已终止对象恒返 ACCESS_DENIED（并行测试高并发 spawn
  // 下 PID 复用命中他人正在退出的进程时即触发）。用 tasklist 复核 PID 当下是否仍
  // 在系统进程列表：已不在 → 目标已死，收敛 alreadyGone；仍在 → 真失败，照抛。
  const listed = await isWindowsPidListed(pid);
  if (listed === false) {
    return Object.freeze({ pid, method: "taskkill", alreadyGone: true });
  }
  throw new Error(`taskkill /T /F 失败（pid=${pid}，code=${proof.code}）：${stderrTail.trim()}`);
}

/**
 * tasklist 复核 PID 是否仍在系统进程列表（taskkill 失败路径专用）。
 * 三态：true=仍存活（真失败）；false=已不在（目标已死，收敛 alreadyGone）；
 * null=tasklist 自身失败（无法判定，按真失败处理）。
 * 判定依据 CSV 第二列（PID 字段）精确匹配——无匹配时 tasklist 打印的是本地化
 * "INFO: 无匹配" 提示行（非引号 CSV），不依赖其文案即可区分。
 */
async function isWindowsPidListed(pid: number): Promise<boolean | null> {
  const handle = spawnTracked("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutTail = "";
  const stdout = handle.stdout;
  if (stdout !== null) {
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-1000);
    });
  }
  try {
    const proof = await handle.exited;
    if (proof.code !== 0) return null;
  } catch {
    return null; // tasklist 从未创建（理论上不会：系统自带）
  }
  return stdoutTail.split("\n").some((line) => {
    const fields = line.trim().split(",");
    return fields.length >= 2 && fields[1] === `"${pid}"`;
  });
}

/** POSIX：进程组整杀 kill(-pgid, SIGKILL)；ESRCH 收敛（见文件头局限注释） */
function killTreePosix(pid: number, pgid: number | null): KillTreeResult {
  const group = pgid ?? pid;
  try {
    process.kill(-group, "SIGKILL");
    return Object.freeze({ pid, method: "process-group", alreadyGone: false });
  } catch (error) {
    if (!isEsrch(error)) throw error;
  }
  if (pgid !== null) {
    // 已知 pgid（detached 句柄）：组不存在即整树已亡。此时单 pid 回退只可能命中
    // 被 PID 复用的无辜进程（原树成员必在同一组内随组消亡），故直接收敛不回退。
    return Object.freeze({ pid, method: "process-group", alreadyGone: true });
  }
  // 裸 pid / 非 detached 句柄：尽力而为路径——若该 pid 恰为某存活进程组的组长 id
  // （如已死 setsid 领头者的幸存同组后代、其后该 id 又被用作 kill 目标），上面
  // process.kill(-pid) 会误杀那个无关进程组。PID 复用的这一固有误杀方向无法在
  // 无 /proc 支持下完全消除；正式树杀请一律使用 detached 模式句柄（契约路径）。
  try {
    process.kill(pid, "SIGKILL");
    return Object.freeze({ pid, method: "process-group", alreadyGone: false });
  } catch (error) {
    if (isEsrch(error)) {
      return Object.freeze({ pid, method: "process-group", alreadyGone: true });
    }
    throw error;
  }
}

function isEsrch(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}
