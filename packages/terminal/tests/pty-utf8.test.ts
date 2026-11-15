// UTF-8 中文输出往返：Windows ConPTY 冒烟（验收项：含中文输出）。
// win32 用 PowerShell（Unicode 干净，避开 cmd 的 OEM 代码页）；POSIX 用 bash/sh。
import { describe, expect, it } from "vitest";
import { createPtySession } from "../src/index.js";
import {
  probeSession,
  requireShell,
  resolveUtf8TestShell,
  toBase64,
  waitForText,
} from "./helpers/terminal-utils.js";

const shell = resolveUtf8TestShell();
const MARKER = "中文标记aether_utf8_回环";

describe.skipIf(shell === null)("pty-session：UTF-8 中文输出往返（Windows ConPTY 冒烟）", () => {
  it("echo 中文标记经 PTY 回传不损坏", async () => {
    const sh = requireShell(shell);
    const session = createPtySession({
      terminalId: "t-utf8",
      file: sh.file,
      args: sh.args,
      cols: 120,
      rows: 30,
    });
    const probe = probeSession(session);
    session.write(toBase64(`echo ${MARKER}\r`));
    const text = await waitForText(probe.text, MARKER, 20_000);
    expect(text).toContain(MARKER);

    const proof = await session.dispose();
    expect(proof.exitCode).toBeDefined();
    probe.stop();
  }, 40_000);
});
