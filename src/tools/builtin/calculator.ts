/**
 * 数学计算工具：自研表达式解析器。
 *
 * 为什么不用 `eval` / `new Function`：Agent 的输入来自模型输出，
 * 属于不可信输入。这里用递归下降解析器把语法限制在纯数学子集内，
 * 从根上杜绝代码注入（这是很多 Agent 框架的真实漏洞来源）。
 */

import { defineTool } from "../tool.js";

const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  pow: (x, y) => x ** y,
  log: (x) => Math.log(x),
  log10: (x) => Math.log10(x),
  exp: (x) => Math.exp(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  asin: (x) => Math.asin(x),
  acos: (x) => Math.acos(x),
  atan: (x) => Math.atan(x),
  atan2: (x, y) => Math.atan2(x, y),
};

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "op"; readonly value: string }
  | { readonly kind: "lparen" }
  | { readonly kind: "rparen" }
  | { readonly kind: "comma" };

class ParseError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      while (j < input.length && /[0-9.eE]/.test(input[j]!)) {
        // 支持科学计数法中的 e/E，但需紧随数字或符号
        if (/[eE]/.test(input[j]!) && /[+-]/.test(input[j + 1] ?? "")) j++;
        j++;
      }
      const literal = input.slice(i, j);
      const value = Number(literal);
      if (Number.isNaN(value)) throw new ParseError(`Invalid number: ${literal}`);
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j]!)) j++;
      tokens.push({ kind: "ident", value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i++;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (char === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    throw new ParseError(`Unexpected character: ${char}`);
  }
  return tokens;
}

/** 递归下降解析：expr → term → factor → unary → primary。 */
function parse(tokens: readonly Token[]): number {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const consume = (): Token | undefined => tokens[position++];

  const parseExpr = (): number => {
    let left = parseTerm();
    while (true) {
      const token = peek();
      if (token?.kind === "op" && (token.value === "+" || token.value === "-")) {
        consume();
        const right = parseTerm();
        left = token.value === "+" ? left + right : left - right;
      } else {
        return left;
      }
    }
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    while (true) {
      const token = peek();
      if (
        token?.kind === "op" &&
        (token.value === "*" || token.value === "/" || token.value === "%")
      ) {
        consume();
        const right = parseFactor();
        if ((token.value === "/" || token.value === "%") && right === 0) {
          throw new ParseError("Division by zero");
        }
        left = token.value === "*" ? left * right : token.value === "/" ? left / right : left % right;
      } else {
        return left;
      }
    }
  };

  const parseFactor = (): number => {
    const base = parseUnary();
    const token = peek();
    if (token?.kind === "op" && token.value === "^") {
      consume();
      const exponent = parseFactor(); // 右结合
      return base ** exponent;
    }
    return base;
  };

  const parseUnary = (): number => {
    const token = peek();
    if (token?.kind === "op" && (token.value === "-" || token.value === "+")) {
      consume();
      const value = parseUnary();
      return token.value === "-" ? -value : value;
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const token = consume();
    if (!token) throw new ParseError("Unexpected end of expression");
    if (token.kind === "number") return token.value;
    if (token.kind === "lparen") {
      const value = parseExpr();
      const closing = consume();
      if (closing?.kind !== "rparen") throw new ParseError("Missing closing parenthesis");
      return value;
    }
    if (token.kind === "ident") {
      const name = token.value;
      const next = peek();
      if (next?.kind === "lparen") {
        consume();
        const args: number[] = [];
        if (peek()?.kind !== "rparen") {
          args.push(parseExpr());
          while (peek()?.kind === "comma") {
            consume();
            args.push(parseExpr());
          }
        }
        if (consume()?.kind !== "rparen") throw new ParseError(`Missing closing paren for ${name}()`);
        const fn = FUNCTIONS[name];
        if (!fn) throw new ParseError(`Unknown function: ${name}`);
        return fn(...args);
      }
      const constant = CONSTANTS[name];
      if (constant !== undefined) return constant;
      throw new ParseError(`Unknown identifier: ${name}`);
    }
    throw new ParseError(`Unexpected token in expression`);
  };

  const result = parseExpr();
  if (position < tokens.length) throw new ParseError("Trailing input after expression");
  return result;
}

export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new ParseError("Empty expression");
  const value = parse(tokens);
  if (!Number.isFinite(value)) throw new ParseError("Result is not a finite number");
  return value;
}

export const calculatorTool = defineTool({
  name: "calculator",
  description:
    "Evaluate a mathematical expression. Supports + - * / % ^, parentheses, and functions " +
    "(sqrt, abs, round, floor, ceil, min, max, pow, log, log10, exp, sin, cos, tan, asin, acos, atan, atan2) " +
    "and constants (pi, e, tau). Use this instead of doing arithmetic by hand.",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "The mathematical expression to evaluate" },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  execute: ({ expression }: { expression: string }) => {
    const value = evaluateExpression(expression);
    // 消除浮点噪声：1.0000000000000002 → 1
    const rounded = Number(value.toFixed(12));
    return { expression, result: rounded };
  },
});
