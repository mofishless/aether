// hello 握手校验（纯函数，SYSTEM_DESIGN §5.1：连接先 hello 校验 token 与协议版本）。
// 校验顺序定案：token 先于 protocolVersion——未通过认证的对端不获得服务端协议期待，
// 版本失配（4002）只在 token 正确后才可能泄露，供客户端提示升级（contracts hello.ts 注释）。
import { createHash, timingSafeEqual } from "node:crypto";
import { ClientHelloSchema, type ServerWelcome } from "@aether/contracts";
import { CLOSE_CODES } from "./close-codes.js";

export interface DaemonVersions {
  readonly protocolVersion: number;
  readonly daemonVersion: string;
}

export type HelloOutcome =
  | { kind: "welcome"; welcome: ServerWelcome }
  | { kind: "close"; code: CloseCodeOf; reason: string };

// CLOSE_CODES 的子集（排除 DAEMON_SHUTDOWN，握手阶段用不到）
type CloseCodeOf =
  | typeof CLOSE_CODES.MALFORMED_HELLO
  | typeof CLOSE_CODES.TOKEN_MISMATCH
  | typeof CLOSE_CODES.VERSION_MISMATCH
  | typeof CLOSE_CODES.NON_HELLO_BEFORE_HANDSHAKE;

function closeOutcome(code: CloseCodeOf, reason: string): HelloOutcome {
  return { kind: "close", code, reason };
}

/** 常数时间 token 比较：先 sha256 定长再 timingSafeEqual，避免长度泄露/时序侧信道 */
function tokensMatch(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function buildWelcome(versions: DaemonVersions): ServerWelcome {
  return {
    type: "welcome",
    protocolVersion: versions.protocolVersion,
    daemonVersion: versions.daemonVersion,
  };
}

/**
 * 校验握手首帧：
 * - 非 JSON / type==="hello" 但 strict schema 拒绝 → 4000（解析失败）
 * - 合法 hello 但 token 不符 → 4001（先于版本校验）
 * - token 正确但 protocolVersion 失配 → 4002
 * - 合法 JSON 但不是 hello（含 RPC 帧、welcome 回放、标量/数组）→ 4004
 * - 全部通过 → welcome 帧（protocolVersion/daemonVersion）
 */
export function validateHello(
  raw: string,
  expectedToken: string,
  versions: DaemonVersions,
): HelloOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return closeOutcome(CLOSE_CODES.MALFORMED_HELLO, "malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return closeOutcome(CLOSE_CODES.NON_HELLO_BEFORE_HANDSHAKE, "expected hello");
  }
  const parsedRecord = parsed as Record<string, unknown>;
  if (parsedRecord["type"] !== "hello") {
    return closeOutcome(
      CLOSE_CODES.NON_HELLO_BEFORE_HANDSHAKE,
      "expected hello before any other message",
    );
  }

  const hello = ClientHelloSchema.safeParse(parsed);
  if (!hello.success) {
    return closeOutcome(CLOSE_CODES.MALFORMED_HELLO, "invalid hello");
  }
  if (!tokensMatch(hello.data.token, expectedToken)) {
    return closeOutcome(CLOSE_CODES.TOKEN_MISMATCH, "token mismatch");
  }
  if (hello.data.protocolVersion !== versions.protocolVersion) {
    return closeOutcome(CLOSE_CODES.VERSION_MISMATCH, "protocol version mismatch");
  }
  return { kind: "welcome", welcome: buildWelcome(versions) };
}
