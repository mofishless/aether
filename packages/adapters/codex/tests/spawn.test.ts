import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DEFAULT_CODEX_SERVER_ARGS,
  envPathProber,
  parseCmdShimContent,
  prepareCodexHome,
  resolveCodexLaunch,
} from "../src/spawn.js";

// ===== 启动解析单测（协议定案 §2.1：Windows spawn 链 / CODEX_HOME 预创建）=====
// 平台分支经 platform 注入缝在全平台 CI 上跑 win32 语义（P0 教训：双平台都要想清楚）；
// 路径断言统一 toFwd 归一（\\ → /），win32/POSIX 同一断言面。

const toFwd = (path: string): string => path.replace(/\\/g, "/");

const NPM_STYLE_SHIM = [
  "@ECHO off",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%~dp0\\node.exe" (',
  '  SET "_prog=%~dp0\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  '"%_prog%"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "ENDLOCAL",
  "EXIT /b %errorlevel%",
].join("\n");

describe("parseCmdShimContent：npm 风格 .cmd shim 解析（纯函数全平台）", () => {
  it("标准 npm shim：%~dp0 展开为 shim 目录（含尾分隔符），bundled node 优先", () => {
    const resolution = parseCmdShimContent(NPM_STYLE_SHIM, "D:/Data/nodejs", "node-fallback");
    expect(resolution).not.toBeNull();
    expect(toFwd(resolution?.scriptPath ?? "")).toBe(
      "D:/Data/nodejs/node_modules/@openai/codex/bin/codex.js",
    );
    expect(toFwd(resolution?.nodePath ?? "")).toBe("D:/Data/nodejs/node.exe");
  });

  it("末尾分隔符目录不产生双分隔符", () => {
    const resolution = parseCmdShimContent(NPM_STYLE_SHIM, "D:/x/", "n");
    expect(toFwd(resolution?.scriptPath ?? "")).toBe(
      "D:/x/node_modules/@openai/codex/bin/codex.js",
    );
  });

  it("斜杠形态 %~dp0/ 与无 bundled node：回退注入 nodePath", () => {
    const resolution = parseCmdShimContent(
      'node "%~dp0/pkg/bin/codex.js" %*',
      "/usr/local/bin",
      "node-fallback",
    );
    expect(resolution).toEqual({
      nodePath: "node-fallback",
      scriptPath: resolution?.scriptPath ?? "",
    });
    expect(toFwd(resolution?.scriptPath ?? "")).toBe("/usr/local/bin/pkg/bin/codex.js");
  });

  it("绝对路径直入（无 %~dp0）：盘符与 POSIX 根均接受", () => {
    expect(toFwd(parseCmdShimContent('node "D:/x/codex.js"', "any", "n")?.scriptPath ?? "")).toBe(
      "D:/x/codex.js",
    );
    expect(toFwd(parseCmdShimContent('node "/opt/x/codex.js"', "any", "n")?.scriptPath ?? "")).toBe(
      "/opt/x/codex.js",
    );
  });

  it("相对路径或无 .js 引用 → null（走 cmd.exe 包装兜底）", () => {
    expect(parseCmdShimContent('node "relative/codex.js"', "d", "n")).toBeNull();
    expect(parseCmdShimContent("echo hello", "d", "n")).toBeNull();
  });
});

describe("resolveCodexLaunch：平台分支矩阵（platform 注入）", () => {
  it("win32 + .cmd：解析为一等 node 进程，默认附加 T3 参数与 app-server", () => {
    const spec = resolveCodexLaunch("C:/npm/codex.cmd", {
      platform: "win32",
      shimReader: () => NPM_STYLE_SHIM,
      nodePath: "node-x",
    });
    expect(toFwd(spec.command)).toBe("C:/npm/node.exe");
    expect(spec.args).toHaveLength(1 + DEFAULT_CODEX_SERVER_ARGS.length + 1);
    expect(toFwd(spec.args[0] ?? "")).toBe("C:/npm/node_modules/@openai/codex/bin/codex.js");
    expect(spec.args.slice(1)).toEqual([...DEFAULT_CODEX_SERVER_ARGS, "app-server"]);
  });

  it("win32 + .cmd 解析失败（读不到/无 .js）：兜底原样交 spawnCommand 包装", () => {
    const spec = resolveCodexLaunch("C:\\npm\\codex.cmd", {
      platform: "win32",
      shimReader: () => {
        throw new Error("ENOENT");
      },
    });
    expect(spec).toEqual({
      command: "C:\\npm\\codex.cmd",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
  });

  it("win32 + .exe / POSIX codex：原样 spawn", () => {
    expect(resolveCodexLaunch("codex", { platform: "linux" })).toEqual({
      command: "codex",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
    expect(resolveCodexLaunch("D:\\x\\codex.exe", { platform: "win32" })).toEqual({
      command: "D:\\x\\codex.exe",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
  });

  it(".mjs/.js 用 node 驱动（mock server 与自备入口共用此径）", () => {
    const spec = resolveCodexLaunch("/t/mock-server.mjs", {
      platform: "linux",
      nodePath: "/n/node",
    });
    expect(spec).toEqual({
      command: "/n/node",
      args: ["/t/mock-server.mjs", ...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
  });

  it("serverArgs 覆盖默认 T3 参数；subcommand 可换 --version（discover 径）", () => {
    const spec = resolveCodexLaunch("codex", {
      platform: "linux",
      extraArgs: ["-c", "x=1"],
      subcommand: ["--version"],
    });
    expect(spec).toEqual({ command: "codex", args: ["-c", "x=1", "--version"] });
    expect(DEFAULT_CODEX_SERVER_ARGS).toEqual(["-c", "thread_unload_delay_secs=0"]);
  });
});

describe("resolveCodexLaunch：win32 裸名 PATH 探测（P1-01 评审 F5，prober 注入）", () => {
  it("裸名探到 .cmd：等价显式 .cmd——走 shim 解析链（一等 node 进程）", () => {
    const spec = resolveCodexLaunch("codex", {
      platform: "win32",
      shimReader: () => NPM_STYLE_SHIM,
      nodePath: "node-x",
      pathProber: (name) => (name === "codex" ? "C:/npm/codex.cmd" : null),
    });
    expect(toFwd(spec.command)).toBe("C:/npm/node.exe");
    expect(toFwd(spec.args[0] ?? "")).toBe("C:/npm/node_modules/@openai/codex/bin/codex.js");
    expect(spec.args.slice(1)).toEqual([...DEFAULT_CODEX_SERVER_ARGS, "app-server"]);
  });

  it("裸名探到 .exe：原样直启（完整路径）", () => {
    const spec = resolveCodexLaunch("codex", {
      platform: "win32",
      pathProber: () => "C:/native/codex.exe",
    });
    expect(spec).toEqual({
      command: "C:/native/codex.exe",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
  });

  it("探不到：保持裸名原样（spawn 失败由 discover 兜底提示，不在此抛错）", () => {
    const spec = resolveCodexLaunch("codex", { platform: "win32", pathProber: () => null });
    expect(spec).toEqual({ command: "codex", args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"] });
  });

  it("POSIX 裸名不探测；win32 带分隔符/带扩展名的值不进探测", () => {
    const throwingProber = (): string => {
      throw new Error("不应触发探测");
    };
    expect(resolveCodexLaunch("codex", { platform: "linux", pathProber: throwingProber })).toEqual({
      command: "codex",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
    expect(
      resolveCodexLaunch(".\\tools\\codex", { platform: "win32", pathProber: throwingProber }),
    ).toEqual({
      command: ".\\tools\\codex",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
    expect(
      resolveCodexLaunch("codex.exe", { platform: "win32", pathProber: throwingProber }),
    ).toEqual({
      command: "codex.exe",
      args: [...DEFAULT_CODEX_SERVER_ARGS, "app-server"],
    });
  });

  it("envPathProber × 临时目录假 shim（真实文件系统，全平台跑 win32 语义）", () => {
    const dir = mkdtempSync(join(tmpdir(), "aether-codex-probe-"));
    dirs.push(dir);
    writeFileSync(join(dir, "codex.cmd"), NPM_STYLE_SHIM, "utf8");
    const previousPath = process.env["PATH"];
    process.env["PATH"] = [dir, previousPath ?? ""].join(delimiter);
    try {
      // 默认 prober：PATH 逐目录探测 → 命中临时目录的 codex.cmd
      expect(toFwd(envPathProber("codex") ?? "")).toBe(toFwd(join(dir, "codex.cmd")));
      expect(envPathProber("aether-not-exist")).toBeNull();
      // 端到端：裸名 + 默认 prober + 真 shim 内容 → node <codex.js>（bundled node.exe）
      const spec = resolveCodexLaunch("codex", { platform: "win32", nodePath: "node-fb" });
      expect(toFwd(spec.command)).toBe(toFwd(join(dir, "node.exe")));
      expect(toFwd(spec.args[0] ?? "")).toBe(
        toFwd(join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")),
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previousPath;
      }
    }
  });
});

/** 跨 describe 共享的临时目录（afterAll 统一清理） */
const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "aether-codex-home-"));
  dirs.push(dir);
  return dir;
};

describe("prepareCodexHome：~ 展开与预创建（§2.1/§9-10）", () => {
  it("~/x 展开（字面 ~ 服务端会拒，必须替换）并预创建", () => {
    const home = prepareCodexHome("~/aether-codex-home-test");
    expect(home).not.toBeNull();
    expect(home?.includes("~")).toBe(false);
    expect(existsSync(home as string)).toBe(true);
    rmSync(home as string, { recursive: true, force: true });
  });

  it("字面 ~ 整体展开为 homedir 子路径等价（不残留 ~）", () => {
    // ~ 单独成值：展开为 homedir 本体（存在性由系统保证，只验不残留 ~）
    const home = prepareCodexHome("~");
    expect(home).not.toBeNull();
    expect(home?.includes("~")).toBe(false);
  });

  it("已存在目录幂等；嵌套目录递归创建；空/未设返回 null", () => {
    const base = newDir();
    expect(prepareCodexHome(base)).toBe(base);
    expect(prepareCodexHome(undefined)).toBeNull();
    expect(prepareCodexHome("")).toBeNull();
    const nested = join(base, "sub", "inner");
    const made = prepareCodexHome(nested);
    expect(made).toBe(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

describe("真实 .cmd 文件端到端解析（win32 真盘防纸上转义）", () => {
  it.runIf(process.platform === "win32")("写真实 shim 文件 → 读回解析", () => {
    const dir = mkdtempSync(join(tmpdir(), "aether-codex-shim-"));
    dirs.push(dir);
    const shimPath = join(dir, "codex.cmd");
    writeFileSync(shimPath, NPM_STYLE_SHIM, "utf8");
    const resolution = parseCmdShimContent(readFileSync(shimPath, "utf8"), dir, "node-fb");
    expect(toFwd(resolution?.scriptPath ?? "")).toBe(
      toFwd(join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")),
    );
    mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"),
      "// stub",
      "utf8",
    );
  });
});

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
