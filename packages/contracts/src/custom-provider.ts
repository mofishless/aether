import { z } from "zod";

// ===== 自定义 provider 配置（SYSTEM_DESIGN §6.3，存 provider_config.config_json）=====

/** happy-providers 同款三分法（调研 05.D） */
export const CustomProviderProtocolSchema = z.enum([
  "anthropic",
  "openai-chat",
  "openai-responses",
]);
export type CustomProviderProtocol = z.infer<typeof CustomProviderProtocolSchema>;

/** 内置 agent loop：调端点 → 解析 tool_call → worktree 内执行 → 回喂（最小工具集边界 TBD-4） */
export const BuiltinAgentLoopSchema = z.object({
  mode: z.literal("builtin"),
  tools: z.array(z.string().min(1)),
});
export type BuiltinAgentLoop = z.infer<typeof BuiltinAgentLoopSchema>;

/** 环境变量名（不是密钥值）：字母/下划线开头，仅字母数字下划线 */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 安全规则（§6.3）：密钥本体永不入库（BYOK、不做代理）。两道防线：
// 防线一：schema 层面只接受 apiKeyEnv（环境变量名）；.strict() 拒绝一切未知字段，
//   因此任何夹带的 apiKey / token / secret 值字段都无法通过校验。
// 防线二：extraHeaders 的 key 是 HTTP 头名（如 anthropic 协议合法的 x-api-key），
//   不做密钥词过滤以避免误伤；但其**值**经 ExtraHeaderValueSchema 校验——
//   只放行 ${ENV_NAME} 插值模板与普通静态值，拒绝形似裸密钥的值。

/** 整值 ${ENV_NAME} 插值模板（推荐方式）：运行期从 env 解析，密钥本体不落配置（内层为 ENV_VAR_NAME_PATTERN 同款命名规则） */
const ENV_TEMPLATE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** 已知密钥令牌前缀：Anthropic/OpenAI sk-、GitHub ghp_/gho_/ghu_、Slack xox*、Google AIza */
const BARE_SECRET_PREFIXES = [
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "xoxa-",
  "xoxb-",
  "xoxp-",
  "xoxr-",
  "xoxs-",
  "AIza",
] as const;

/** Authorization 凭据前缀（RFC 7235 scheme 大小写不敏感）；混合形态 "Bearer ${X}" 同样拒绝——Authorization 由运行期从 apiKeyEnv 组装 */
const BEARER_PREFIX_PATTERN = /^bearer\s/i;

/** 疑似随机令牌串：≥20 字符、无空白、全部为令牌字符集、字母与数字混排（生成式密钥的典型签名；启发式宁可误拒，错误消息引导改用 ${ENV_NAME} 模板） */
const RANDOM_TOKEN_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_.~+/=-]{20,}$/;

/** extraHeaders 的值是否为允许形态：${ENV_NAME} 模板，或不含密钥特征的普通静态值 */
function isAllowedHeaderValue(value: string): boolean {
  if (ENV_TEMPLATE_PATTERN.test(value)) {
    return true;
  }
  const hasSecretPrefix = BARE_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
  if (hasSecretPrefix) {
    return false;
  }
  if (BEARER_PREFIX_PATTERN.test(value)) {
    return false;
  }
  return !RANDOM_TOKEN_PATTERN.test(value);
}

const EXTRA_HEADER_VALUE_ERROR_MESSAGE =
  "extraHeaders 的值疑似密钥本体（令牌前缀 / Bearer 凭据 / 长随机串被拒绝）：" +
  "密钥请改用 ${ENV_NAME} 插值模板引用环境变量（§6.3：密钥本体永不入库）；" +
  "仅允许普通静态值（如 anthropic-version 的版本号）。";

const ExtraHeaderValueSchema = z.string().refine(isAllowedHeaderValue, {
  message: EXTRA_HEADER_VALUE_ERROR_MESSAGE,
});
export const CustomProviderConfigSchema = z
  .object({
    kind: z.literal("custom"),
    displayName: z.string().min(1),
    protocol: CustomProviderProtocolSchema,
    baseUrl: z.url(),
    /** 密钥所在的环境变量名，密钥值永不入库 */
    apiKeyEnv: z.string().regex(ENV_VAR_NAME_PATTERN),
    model: z.string().min(1),
    requestTimeoutMs: z.number().int().positive().optional(),
    /** 附加 HTTP 头：key 为头名不做过滤；value 只放行 ${ENV_NAME} 模板与非密钥静态值（见上方防线二） */
    extraHeaders: z.record(z.string(), ExtraHeaderValueSchema).optional(),
    agentLoop: BuiltinAgentLoopSchema,
  })
  .strict();
export type CustomProviderConfig = z.infer<typeof CustomProviderConfigSchema>;
