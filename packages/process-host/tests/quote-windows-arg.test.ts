// quoteWindowsArg 纯函数表驱动单测（全平台运行）。
// 算法契约（src/windows-quote.ts 定案）：
//   1) argvW 转义：反斜杠串遇 " 加倍且 " → \"；结尾反斜杠串加倍；
//   2) 整体包 "…"；
//   3) cmd 元字符（^ & | < > ( ) % ! "，含包引号本身）逐个加 ^ 前缀。
// 期望值经真实 cmd.exe /d /s /c + node argv 往返实验逐例验证（2026-11-15，Windows 11）。
import { describe, expect, it } from "vitest";
import { quoteWindowsArg } from "../src/index.js";

const CASES: ReadonlyArray<readonly [input: string, expected: string]> = [
  // 空串 → 空引号对（各自被 ^ 保护）
  ["", '^"^"'],
  // 无特殊字符：仅包引号
  ["hello", '^"hello^"'],
  // 空格：引号包裹后 cmd 参数区原样透传
  ["hello world", '^"hello world^"'],
  [" ", '^" ^"'],
  // 内嵌引号：argvW 层 \" 转义，cmd 层全部 "（含包引号）加 ^
  ['say "hi"', '^"say \\^"hi\\^"^"'],
  ['back"slash', '^"back\\^"slash^"'],
  ['b""2', '^"b\\^"\\^"2^"'],
  // cmd 操作符：加 ^ 冻结语义
  ["a&b", '^"a^&b^"'],
  ["x&&y", '^"x^&^&y^"'],
  ["a|b", '^"a^|b^"'],
  ["a<b>c", '^"a^<b^>c^"'],
  ["paren(x)", '^"paren^(x^)^"'],
  ["caret^hat", '^"caret^^hat^"'],
  // %：cmd /c 命令行上下文中 ^% 可防 %VAR% 展开（实验验证）
  ["p%PATH%q", '^"p^%PATH^%q^"'],
  // 反斜杠边界：结尾反斜杠加倍（argvW 规则）
  ["trailing\\", '^"trailing\\\\^"'],
  ["backslash\\\\double", '^"backslash\\\\double^"'],
  // 非 cmd 元字符：不转义（实验验证 , ; * ? 均安全透传）
  ["semi;colon", '^"semi;colon^"'],
  ["comma,x", '^"comma,x^"'],
  ["star*x", '^"star*x^"'],
];

describe("quoteWindowsArg（Windows .cmd/.bat 参数转义，纯函数）", () => {
  for (const [input, expected] of CASES) {
    it(`转义 ${JSON.stringify(input)} → ${expected}`, () => {
      expect(quoteWindowsArg(input)).toBe(expected);
    });
  }

  it("已转义串仍按普通参数处理（不二次反转义）", () => {
    // 输入 ^"a^&b^" → argvW 后 ^\"a^&b^\" → 包引号 → caret 转义（机器可核对）
    expect(quoteWindowsArg('^"a^&b^"')).toBe('^"^^\\^"a^^^&b^^\\^"^"');
  });
});
