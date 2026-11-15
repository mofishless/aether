// ===== 回放引擎共用原语（纯 Node，零依赖）=====
// 行解析 / 背压安全写行 / 毫秒睡眠 / token 替换（不可变：重建对象而非原地改）。

/** 解析一行 JSON；非 JSON 或非对象返回 null（宽容：未知行静默丢弃） */
export function parseJsonObject(line) {
  const text = line.trim();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** 写一行 JSONL；stdout 缓冲满时等 drain（背压安全） */
export async function writeLine(stdout, value) {
  const ok = stdout.write(`${JSON.stringify(value)}\n`);
  if (!ok) {
    await new Promise((resolve) => {
      stdout.once("drain", resolve);
    });
  }
}

/** 睡眠指定毫秒（回放节奏控制，测试用 0-5ms） */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * token 替换：递归重建输入值，把字符串内出现的 token 全部替换（不可变）。
 * 深度只遍历普通对象与数组，其余原样保留。
 */
export function substitute(value, tokens) {
  if (typeof value === "string") {
    let result = value;
    for (const [token, replacement] of Object.entries(tokens)) {
      if (result.includes(token)) {
        result = result.split(token).join(replacement);
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, tokens));
  }
  if (typeof value === "object" && value !== null) {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = substitute(item, tokens);
    }
    return next;
  }
  return value;
}

/** 读环境变量整数（缺省/非法回退默认值） */
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
