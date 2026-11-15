import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "@aether/process-host";
import type { ProcessHandle } from "@aether/process-host";
import {
  createJsonlRpcClient,
  RpcError,
  RpcTimeoutError,
  RpcTransportError,
} from "../src/client.js";
import type { JsonlRpcClient, ServerRequestOutcome } from "../src/client.js";
import type { ServerNotificationFrame, ServerRequestFrame } from "../src/frame-router.js";

// ===== JSONL RPC 客户端 × mock codex app-server 集成（传输语义，协议定案 §1/§2/§4/§7）=====
// mock 经 node 直驱（.mjs → resolveCodexLaunch 的 node 径），场景选择/wire 落盘走 env。

const MOCK_SERVER = fileURLToPath(new URL("./helpers/mock-codex-server.mjs", import.meta.url));
const SCENARIO_MINIMAL = JSON.stringify({ threadId: "t-client", turnScripts: [] });

const workdirs: string[] = [];
const handles: ProcessHandle[] = [];

afterAll(async () => {
  for (const handle of handles) {
    try {
      handle.kill();
    } catch {
      // 已退出：无害
    }
  }
  await Promise.all(
    workdirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

interface ClientFixture {
  readonly client: JsonlRpcClient;
  readonly handle: ProcessHandle;
  readonly wireLog: string;
  readonly notifications: ServerNotificationFrame[];
  readonly serverRequests: ServerRequestFrame[];
}

async function launchClient(options?: {
  serverRequestMethods?: ReadonlySet<string>;
  scenario?: unknown;
}): Promise<ClientFixture> {
  const dir = await mkdtemp(join(tmpdir(), "aether-codex-client-"));
  workdirs.push(dir);
  const wireLog = join(dir, "wire.log");
  await writeFile(
    join(dir, "scenario.json"),
    JSON.stringify(options?.scenario ?? JSON.parse(SCENARIO_MINIMAL)),
    "utf8",
  );
  const handle = spawnCommand(process.execPath, [MOCK_SERVER], {
    env: {
      ...process.env,
      AETHER_CODEX_SCENARIO: join(dir, "scenario.json"),
      AETHER_CODEX_WIRE_LOG: wireLog,
    },
    detached: process.platform !== "win32",
  });
  handles.push(handle);
  const notifications: ServerNotificationFrame[] = [];
  const serverRequests: ServerRequestFrame[] = [];
  const client = createJsonlRpcClient({
    handle,
    onNotification: (note) => notifications.push(note),
    onServerRequest: (request) => {
      serverRequests.push(request);
      return { handled: true, result: "accept" } satisfies ServerRequestOutcome;
    },
    ...(options?.serverRequestMethods !== undefined
      ? { serverRequestMethods: options.serverRequestMethods }
      : {}),
  });
  return { client, handle, wireLog, notifications, serverRequests };
}

const readWire = (path: string): Array<{ dir: string; frame: Record<string, unknown> }> =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });

describe("initialize 握手（§2.2：experimentalApi 必须声明）", () => {
  it(
    "握手成功且 wire 上带 capabilities.experimentalApi=true + initialized 通知",
    { timeout: 30_000 },
    async () => {
      const fixture = await launchClient();
      await fixture.client.initialize({ name: "aether", title: "Aether", version: "0.1.0" });
      const wire = readWire(fixture.wireLog);
      const initializeFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "initialize",
      );
      expect(initializeFrame).toBeDefined();
      const params = initializeFrame?.frame["params"] as Record<string, unknown>;
      const capabilities = params["capabilities"] as Record<string, unknown>;
      expect(capabilities["experimentalApi"]).toBe(true);
      expect(params["clientInfo"]).toMatchObject({ name: "aether" });
      // initialized 通知是 initialize 应答之后写出（礼貌发送，§2.2）——wire 落盘有毫秒级竞态，waitFor
      await vi.waitFor(() => {
        const settled = readWire(fixture.wireLog);
        expect(
          settled.some((entry) => entry.dir === "in" && entry.frame["method"] === "initialized"),
        ).toBe(true);
      });
      await fixture.client.close();
    },
  );

  it("握手超时（10s 默认可缩短）→ RpcTimeoutError", { timeout: 30_000 }, async () => {
    // 起一个"读而不答"的最小 echo：场景缺 threadScripts 也不影响——initialize 会被
    // mock 正常应答，改用注入超时：直接创建指向已死管道的客户端不可行，
    // 这里以 initializeTimeoutMs=1 + 阻塞 mock（先灌满 stdin 再说）简化：
    // 用 mock/rpcError 场景之外的手段——launch 一个不回复的裸 node 进程。
    const dir = await mkdtemp(join(tmpdir(), "aether-codex-silent-"));
    workdirs.push(dir);
    const handle = spawnCommand(process.execPath, ["-e", "process.stdin.resume();"], {
      detached: process.platform !== "win32",
    });
    handles.push(handle);
    const client = createJsonlRpcClient({
      handle,
      onNotification: () => undefined,
      onServerRequest: () => ({ handled: false }) satisfies ServerRequestOutcome,
      initializeTimeoutMs: 200,
    });
    await expect(client.initialize({ name: "t" })).rejects.toBeInstanceOf(RpcTimeoutError);
    client.close();
  });
});

describe("请求/响应与错误分支（§1 四分支落 client）", () => {
  it("请求关联 pending 成功；错误响应 → RpcError(code,message)", { timeout: 30_000 }, async () => {
    const fixture = await launchClient();
    await fixture.client.initialize({ name: "t" });
    const thread = (await fixture.client.request("thread/start", { cwd: "/w" })) as Record<
      string,
      unknown
    >;
    expect((thread["thread"] as Record<string, unknown>)["id"]).toBe("t-client");
    await expect(fixture.client.request("mock/rpcError")).rejects.toMatchObject({
      name: "RpcError",
      code: -32602,
    });
    await expect(fixture.client.request("mock/rpcError")).rejects.toBeInstanceOf(RpcError);
    fixture.client.close();
  });

  it("请求超时 → RpcTimeoutError；迟到响应计 orphan 不崩", { timeout: 30_000 }, async () => {
    const fixture = await launchClient();
    const client = fixture.client;
    await client.initialize({ name: "t" });
    // mock/slow 延迟 1500ms 应答：200ms 超时先到 → RpcTimeoutError；
    // 迟到的响应因 pending 已清除 → orphanResponses 计数（不崩、不误配对）
    await expect(client.request("mock/slow", { delayMs: 1500 }, 200)).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(client.stats().orphanResponses).toBe(1);
    expect(client.stats().pendingCount).toBe(0);
    client.close();
  });
});

describe("服务端请求（审批）并发应答（§4/§9-4：原样回传 id）", () => {
  it(
    "白名单外服务端请求 → 客户端 -32601 兜底应答（wire 可证）并计数",
    { timeout: 30_000 },
    async () => {
      const fixture = await launchClient({
        serverRequestMethods: new Set(["item/commandExecution/requestApproval"]),
        scenario: {
          threadId: "t-client",
          unloadAfterTurn: false,
          turnScripts: [
            { steps: [{ do: "unknownServerRequest", method: "item/unknown/requestApproval" }] },
          ],
        },
      });
      const client = fixture.client;
      await client.initialize({ name: "t" });
      await client.request("thread/start", { cwd: "/w" });
      await client.request("turn/start", {
        threadId: "t-client",
        input: [{ type: "text", text: "hi" }],
      });
      await vi.waitFor(() => {
        expect(client.stats().autoAnsweredServerRequests).toBe(1);
      });
      // wire 上可证：客户端应答原样回传 id 且为错误响应 -32601
      await vi.waitFor(() => {
        const wire = readWire(fixture.wireLog);
        const answer = wire.find(
          (entry) =>
            entry.dir === "in" &&
            (entry.frame["error"] as Record<string, unknown> | undefined)?.["code"] === -32601,
        );
        expect(answer).toBeDefined();
        expect(typeof answer?.frame["id"]).toBe("string");
      });
      expect(fixture.serverRequests).toHaveLength(0); // 白名单外不进审批处理器
      client.close();
    },
  );
});

describe("进程死亡与宽限（§7：EOF 250ms 宽限 + stderr tail 8KB）", () => {
  it(
    "进程非零退出 → pending 以 RpcTransportError 清算（宽限后）",
    { timeout: 30_000 },
    async () => {
      const fixture = await launchClient();
      const client = fixture.client;
      await client.initialize({ name: "t" });
      // 慢请求挂 pending → mock/exit(3) 杀进程 → 宽限后 RpcTransportError 清算
      const pending = client.request("mock/slow", { delayMs: 60_000 }, 60_000);
      await client.request("mock/exit", { code: 3 });
      await expect(pending).rejects.toBeInstanceOf(RpcTransportError);
      const proof = await fixture.handle.exited;
      expect(proof.code).toBe(3);
      expect(client.isDead()).toBe(true);
    },
  );

  it("stderr tail 截取最近内容（8KB 上限语义）", { timeout: 30_000 }, async () => {
    const fixture = await launchClient();
    const client = fixture.client;
    await client.initialize({ name: "t" });
    await client.request("mock/stderr", { text: "STDERR-MARKER-XYZ\n" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.stderrTail()).toContain("STDERR-MARKER-XYZ");
    client.close();
  });

  it("close()（stdin EOF）→ mock 退出 → 退出证明 code 0", { timeout: 30_000 }, async () => {
    const fixture = await launchClient();
    const client = fixture.client;
    await client.initialize({ name: "t" });
    client.close();
    const proof = await fixture.handle.exited;
    expect(proof.code).toBe(0);
  });
});
