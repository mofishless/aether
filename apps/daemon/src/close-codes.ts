// WS 关闭码（应用区间 4000-4999）与优雅退出码（SYSTEM_DESIGN §5.1 握手 + 任务卡 P0-03）。
// 定案：握手失败一律 close-only（不发 JSON-RPC error 帧再 close）——
// hello 不是 JSON-RPC 帧（无 id），错误帧的 id 只能取 null、语义弱；
// close code + reason 已足够客户端精确判定分支，且避免握手阶段制造 JSON-RPC 假象。

export const CLOSE_CODES = {
  /** hello 帧解析失败（非 JSON / strict schema 拒绝：缺 token、空 token、未知字段、版本非正整数） */
  MALFORMED_HELLO: 4000,
  /** token 不符 */
  TOKEN_MISMATCH: 4001,
  /** protocolVersion 失配（客户端可据此提示升级） */
  VERSION_MISMATCH: 4002,
  /** 超时未收到合法 hello（默认 3s） */
  HELLO_TIMEOUT: 4003,
  /** hello 之前收到任何其他消息（一律断开，含 JSON-RPC 帧/welcome 回放） */
  NON_HELLO_BEFORE_HANDSHAKE: 4004,
  /** daemon 主动关闭（system.shutdown 优雅退出 / 1001 Going Away） */
  DAEMON_SHUTDOWN: 1001,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
