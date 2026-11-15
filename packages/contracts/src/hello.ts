import { z } from "zod";

// ===== WS 握手（SYSTEM_DESIGN §5.1：连接先 hello 校验 token 与协议版本）=====

/** 当前契约协议版本（client/server 握手时互相校验） */
export const PROTOCOL_VERSION = 1 as const;

// protocolVersion 用正整数而非 z.literal(PROTOCOL_VERSION)：失配时应由 daemon
// 给出明确的版本错误（而非笼统的解析失败），便于客户端提示升级。

export const ClientHelloSchema = z
  .object({
    type: z.literal("hello"),
    /** 主进程 spawn daemon 时注入的一次性 token（argv/env），每连接握手校验：hello 通过后同连接后续帧不再重复校验 */
    token: z.string().min(1),
    protocolVersion: z.number().int().positive(),
  })
  .strict();
export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const ServerWelcomeSchema = z
  .object({
    type: z.literal("welcome"),
    protocolVersion: z.number().int().positive(),
    /** daemon 包版本（package.json version） */
    daemonVersion: z.string().min(1),
  })
  .strict();
export type ServerWelcome = z.infer<typeof ServerWelcomeSchema>;
