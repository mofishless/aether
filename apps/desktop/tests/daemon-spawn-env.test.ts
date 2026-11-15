import { describe, expect, it } from "vitest";
import { buildDaemonEnv } from "../src/main/daemon/spawn.js";

// P0-11 launcher env 组装（纯函数）：继承透传 → extraEnv 覆盖 → 协议保留键不可被覆盖。
// 假令牌拼接构造（防 push protection 误杀的历史纪律）。
describe("buildDaemonEnv", () => {
  it("继承父进程 env（AETHER_AGENT_CLI_PATH 等 E2E 注入经此透传给 daemon）", () => {
    const env = buildDaemonEnv(
      {
        AETHER_AGENT_CLI_PATH: "D:\\fixtures\\cli.cmd",
        AETHER_MOCK_SCRIPT: "D:\\fixtures\\x.json",
        PATH: "C:\\windows",
      },
      ["tok", "-a"].join(""),
      {},
    );
    expect(env["AETHER_AGENT_CLI_PATH"]).toBe("D:\\fixtures\\cli.cmd");
    expect(env["AETHER_MOCK_SCRIPT"]).toBe("D:\\fixtures\\x.json");
    expect(env["PATH"]).toBe("C:\\windows");
  });

  it("extraEnv 覆盖继承值（userData 数据库路径注入缝）", () => {
    const env = buildDaemonEnv({ AETHER_DAEMON_DB_PATH: ":memory:" }, ["tok", "-b"].join(""), {
      AETHER_DAEMON_DB_PATH: "C:\\userData\\aether.db",
    });
    expect(env["AETHER_DAEMON_DB_PATH"]).toBe("C:\\userData\\aether.db");
  });

  it("协议保留键最后落座：extraEnv 不得覆盖 token 与 ELECTRON_RUN_AS_NODE", () => {
    const token = ["tok", "-c"].join("");
    const env = buildDaemonEnv({}, token, {
      AETHER_DAEMON_TOKEN: ["fake", "-token"].join(""),
      ELECTRON_RUN_AS_NODE: "0",
    });
    expect(env["AETHER_DAEMON_TOKEN"]).toBe(token);
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });
});
