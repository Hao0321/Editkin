import type { HaoExpressionSource } from "./types";

export interface HaoExpressionContext {
  frame: number;
  fps: number;
  time: number;
  inPoint: number;
  outPoint: number;
  duration: number;
  value: number;
  entrance?: number;
  exit?: number;
}

type Token = { kind: "number" | "identifier" | "symbol" | "eof"; value: string };
type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: keyof HaoExpressionContext }
  | { kind: "unary"; operator: "+" | "-"; value: Node }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "%"; left: Node; right: Node }
  | { kind: "call"; name: FunctionName; args: Node[] };

type FunctionName = "abs" | "clamp" | "cos" | "easeIn" | "easeInOut" | "easeOut" | "lerp" | "max" | "min" | "sin" | "smoothstep";

const PREFIX = "hao.expression/v1:";
const MAX_SOURCE_LENGTH = 512;
const MAX_TOKENS = 256;
const MAX_DEPTH = 24;
const VARIABLES = new Set<keyof HaoExpressionContext>(["frame", "fps", "time", "inPoint", "outPoint", "duration", "value", "entrance", "exit"]);
const ARITY: Record<FunctionName, readonly [number, number]> = {
  abs: [1, 1], clamp: [3, 3], cos: [1, 1], easeIn: [1, 1], easeInOut: [1, 1], easeOut: [1, 1],
  lerp: [3, 3], max: [2, 8], min: [2, 8], sin: [1, 1], smoothstep: [1, 1],
};

export class HaoExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaoExpressionError";
  }
}

function bodyOf(source: string): string {
  if (!source.startsWith(PREFIX)) throw new HaoExpressionError("表達式必須使用 hao.expression/v1 schema");
  if (source.length > MAX_SOURCE_LENGTH) throw new HaoExpressionError(`表達式不可超過 ${MAX_SOURCE_LENGTH} 字元`);
  const body = source.slice(PREFIX.length).trim();
  if (!body) throw new HaoExpressionError("表達式不可空白");
  return body;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (/[0-9.]/u.test(char)) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iu);
      if (!match) throw new HaoExpressionError(`無效數字：${source.slice(index, index + 12)}`);
      tokens.push({ kind: "number", value: match[0] });
      index += match[0].length;
    } else if (/[A-Za-z_]/u.test(char)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u)!;
      tokens.push({ kind: "identifier", value: match[0] });
      index += match[0].length;
    } else if ("+-*/%(),".includes(char)) {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
    } else {
      throw new HaoExpressionError(`不允許的表達式字元：${char}`);
    }
    if (tokens.length > MAX_TOKENS) throw new HaoExpressionError(`表達式 token 不可超過 ${MAX_TOKENS}`);
  }
  return [...tokens, { kind: "eof", value: "" }];
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expression(0, 0);
    if (this.peek().kind !== "eof") throw new HaoExpressionError(`無法解析：${this.peek().value}`);
    return node;
  }

  private expression(minimumPrecedence: number, depth: number): Node {
    this.checkDepth(depth);
    let left = this.prefix(depth + 1);
    const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };
    while (this.peek().kind === "symbol" && (precedence[this.peek().value] ?? -1) >= minimumPrecedence) {
      const operator = this.take().value as "+" | "-" | "*" | "/" | "%";
      left = { kind: "binary", operator, left, right: this.expression(precedence[operator] + 1, depth + 1) };
    }
    return left;
  }

  private prefix(depth: number): Node {
    this.checkDepth(depth);
    const token = this.take();
    if (token.kind === "number") {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new HaoExpressionError("表達式數字必須是有限值");
      return { kind: "number", value };
    }
    if (token.kind === "symbol" && (token.value === "+" || token.value === "-")) {
      return { kind: "unary", operator: token.value, value: this.prefix(depth + 1) };
    }
    if (token.kind === "symbol" && token.value === "(") {
      const node = this.expression(0, depth + 1);
      this.expect(")");
      return node;
    }
    if (token.kind !== "identifier") throw new HaoExpressionError(`預期數字、變數或函式，收到：${token.value || "結尾"}`);
    if (this.peek().value !== "(") {
      if (!VARIABLES.has(token.value as keyof HaoExpressionContext)) throw new HaoExpressionError(`不允許的變數：${token.value}`);
      return { kind: "variable", name: token.value as keyof HaoExpressionContext };
    }
    const name = token.value as FunctionName;
    if (!(name in ARITY)) throw new HaoExpressionError(`不允許的函式：${token.value}`);
    this.take();
    const args: Node[] = [];
    if (this.peek().value !== ")") {
      do {
        args.push(this.expression(0, depth + 1));
        if (this.peek().value !== ",") break;
        this.take();
      } while (true);
    }
    this.expect(")");
    const [minimum, maximum] = ARITY[name];
    if (args.length < minimum || args.length > maximum) throw new HaoExpressionError(`${name} 需要 ${minimum}${minimum === maximum ? "" : `..${maximum}`} 個參數`);
    return { kind: "call", name, args };
  }

  private checkDepth(depth: number) { if (depth > MAX_DEPTH) throw new HaoExpressionError(`表達式深度不可超過 ${MAX_DEPTH}`); }
  private peek() { return this.tokens[this.index]; }
  private take() { return this.tokens[this.index++]; }
  private expect(value: string) { const token = this.take(); if (token.value !== value) throw new HaoExpressionError(`預期 ${value}，收到 ${token.value || "結尾"}`); }
}

function parse(source: string): Node {
  return new Parser(tokenize(bodyOf(source))).parse();
}

function evaluateNode(node: Node, context: HaoExpressionContext): number {
  if (node.kind === "number") return node.value;
  if (node.kind === "variable") return node.name === "entrance" || node.name === "exit" ? context[node.name] ?? 1 : context[node.name];
  if (node.kind === "unary") return node.operator === "-" ? -evaluateNode(node.value, context) : evaluateNode(node.value, context);
  if (node.kind === "binary") {
    const left = evaluateNode(node.left, context);
    const right = evaluateNode(node.right, context);
    if ((node.operator === "/" || node.operator === "%") && Math.abs(right) < Number.EPSILON) throw new HaoExpressionError("表達式不可除以零");
    return node.operator === "+" ? left + right : node.operator === "-" ? left - right : node.operator === "*" ? left * right : node.operator === "/" ? left / right : left % right;
  }
  const values = node.args.map((item) => evaluateNode(item, context));
  const unit = (value: number) => Math.max(0, Math.min(1, value));
  const functions: Record<FunctionName, (args: number[]) => number> = {
    abs: ([value]) => Math.abs(value),
    clamp: ([value, minimum, maximum]) => Math.max(Math.min(value, Math.max(minimum, maximum)), Math.min(minimum, maximum)),
    cos: ([value]) => Math.cos(value),
    easeIn: ([value]) => unit(value) ** 2,
    easeInOut: ([value]) => { const x = unit(value); return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2; },
    easeOut: ([value]) => 1 - (1 - unit(value)) ** 2,
    lerp: ([start, end, amount]) => start + (end - start) * amount,
    max: (items) => Math.max(...items), min: (items) => Math.min(...items),
    sin: ([value]) => Math.sin(value),
    smoothstep: ([value]) => { const x = unit(value); return x * x * (3 - 2 * x); },
  };
  return functions[node.name](values);
}

export function assertHaoExpression(source: string): asserts source is HaoExpressionSource {
  parse(source);
}

export function evaluateHaoExpression(source: string, context: HaoExpressionContext): number {
  const value = evaluateNode(parse(source), context);
  if (!Number.isFinite(value)) throw new HaoExpressionError("表達式結果必須是有限值");
  return value;
}

function ffmpegNode(node: Node, variables: Record<keyof HaoExpressionContext, string>): string {
  if (node.kind === "number") return String(node.value);
  if (node.kind === "variable") return variables[node.name];
  if (node.kind === "unary") return `${node.operator}(${ffmpegNode(node.value, variables)})`;
  if (node.kind === "binary") return `((${ffmpegNode(node.left, variables)})${node.operator}(${ffmpegNode(node.right, variables)}))`;
  const args = node.args.map((item) => ffmpegNode(item, variables));
  if (node.name === "abs" || node.name === "cos" || node.name === "max" || node.name === "min" || node.name === "sin") return `${node.name}(${args.join(",")})`;
  if (node.name === "clamp") return `min(max(${args[0]},min(${args[1]},${args[2]})),max(${args[1]},${args[2]}))`;
  if (node.name === "lerp") return `((${args[0]})+((${args[1]})-(${args[0]}))*(${args[2]}))`;
  const x = `min(1,max(0,${args[0]}))`;
  if (node.name === "easeIn") return `((${x})*(${x}))`;
  if (node.name === "easeOut") return `(1-(1-(${x}))*(1-(${x})))`;
  if (node.name === "easeInOut") return `if(lt(${x},0.5),2*(${x})*(${x}),1-pow(-2*(${x})+2,2)/2)`;
  return `((${x})*(${x})*(3-2*(${x})))`;
}

export function haoExpressionToFfmpeg(source: string, variables: Record<keyof HaoExpressionContext, string>): string {
  return ffmpegNode(parse(source), variables);
}
