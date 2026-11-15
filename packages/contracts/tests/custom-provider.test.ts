import { describe, it } from "vitest";
import { CustomProviderConfigSchema } from "../src/index.js";
import type { CustomProviderConfig } from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

// §6.3 示例原文（JSON 字段一一对应）。
const docSample: CustomProviderConfig = {
  kind: "custom",
  displayName: "GLM（OpenAI 兼容）",
  protocol: "openai-chat",
  baseUrl: "https://api.example.com/v1",
  apiKeyEnv: "GLM_API_KEY",
  model: "glm-5.3",
  requestTimeoutMs: 120000,
  extraHeaders: {},
  agentLoop: { mode: "builtin", tools: ["bash", "read", "write", "edit", "grep"] },
};

describe("CustomProviderConfigSchema round-trip", () => {
  it("§6.3 示例原文", () => {
    expectRoundTrip(CustomProviderConfigSchema, docSample);
  });

  it("可选字段（requestTimeoutMs / extraHeaders）可省略", () => {
    const { requestTimeoutMs: _omitTimeout, extraHeaders: _omitHeaders, ...minimal } = docSample;
    expectRoundTrip(CustomProviderConfigSchema, minimal);
  });

  it("三种协议均可通过", () => {
    const protocols = ["anthropic", "openai-chat", "openai-responses"] as const;
    for (const protocol of protocols) {
      expectRoundTrip(CustomProviderConfigSchema, { ...docSample, protocol });
    }
  });
});

describe("CustomProviderConfigSchema 反例", () => {
  it("protocol 非三选一", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, protocol: "openai" });
  });
  it("baseUrl 非合法 URL", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, baseUrl: "api.example.com/v1" });
  });
  it("apiKeyEnv 不是环境变量名", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, apiKeyEnv: "GLM API KEY" });
    expectRejected(CustomProviderConfigSchema, { ...docSample, apiKeyEnv: "" });
  });
  it("kind 字面量必须为 custom", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, kind: "claude-sdk" });
  });
  it("缺必填字段 agentLoop", () => {
    const { agentLoop: _omit, ...withoutLoop } = docSample;
    expectRejected(CustomProviderConfigSchema, withoutLoop);
  });
  it("agentLoop.mode 仅 builtin", () => {
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      agentLoop: { mode: "external", tools: [] },
    });
  });
  it("requestTimeoutMs 非正整数", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, requestTimeoutMs: 0 });
    expectRejected(CustomProviderConfigSchema, { ...docSample, requestTimeoutMs: 500.5 });
  });
});

describe("CustomProviderConfigSchema 安全规则：密钥本体永不入库（§6.3）", () => {
  it("夹带 apiKey 值字段即被拒绝（strict 拒绝一切未知字段）", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, apiKey: "sk-abcdef123456" });
  });
  it("夹带 token 值字段即被拒绝", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, token: "ghp_abcdef" });
  });
  it("夹带 secret 值字段即被拒绝", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, secret: "hunter2" });
  });
  it("apiKeyEnv 传入密钥值（而非环境变量名）被拒绝", () => {
    expectRejected(CustomProviderConfigSchema, { ...docSample, apiKeyEnv: "sk-abcdef123456" });
  });
  it("extraHeaders 的 key 为合法 HTTP 头名时不误伤（如 anthropic 协议的 x-api-key）", () => {
    expectRoundTrip(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "x-api-key": "${GLM_API_KEY}" },
    });
  });
  it("extraHeaders 的值为裸 sk- 密钥被拒绝", () => {
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "x-api-key": "sk-abcdef123456" },
    });
  });
  it("extraHeaders 的值为已知令牌前缀（ghp_ / xoxb- / AIza）被拒绝", () => {
    // 令牌形态用拼接构造：运行时值完整（防线测试有效），源码文本不呈现完整令牌
    // （避免 GitHub push protection 把负例用的假令牌当真实密钥拦截推送）。
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "private-token": "gh" + "p_16C7e42F292c6912E7710c838347Ae178B4a" },
    });
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "x-slack-token": "xo" + "xb-123456789012-abcdefghijklmnop" },
    });
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "x-google-key": "AI" + "zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q" },
    });
  });
  it("extraHeaders 的值为 Bearer 凭据被拒绝（含混合形态 Bearer ${X}）", () => {
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc" },
    });
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { Authorization: "bearer sk-abcdef123456" },
    });
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { Authorization: "Bearer ${GLM_API_KEY}" },
    });
  });
  it("extraHeaders 的值为长随机令牌串（≥20、无空白、字母数字混排）被拒绝", () => {
    expectRejected(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { "x-api-key": "a8fJk2mNp9qR4sT7uV1w" },
    });
  });
  it("extraHeaders 的值为 ${ENV_NAME} 模板通过（§6.3 推荐方式）", () => {
    expectRoundTrip(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: { authorization: "${GLM_API_KEY}", "x-custom-trace": "${TRACE_TOKEN}" },
    });
  });
  it("extraHeaders 的普通静态值通过（版本号 / content-type 等非密钥值不误伤）", () => {
    expectRoundTrip(CustomProviderConfigSchema, {
      ...docSample,
      extraHeaders: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json; charset=utf-8",
        accept: "application/vnd.api+json",
      },
    });
  });
});
