/**
 * Arithmetic over named variables, evaluated by a small parser. It accepts numbers, names, + - * / and parentheses and the
 * functions min, max, abs and log; nothing else, so a definition can never run code.
 */
type Token = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string };
const FUNCTIONS: Record<string, (...args: number[]) => number> = { min: Math.min, max: Math.max, abs: Math.abs, log: Math.log };

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []; let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) { index += 1; continue; }
    const number = /^\d+(?:\.\d+)?/u.exec(source.slice(index));
    if (number) { tokens.push({ t: "num", v: Number(number[0]) }); index += number[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
    if (name) { tokens.push({ t: "name", v: name[0] }); index += name[0].length; continue; }
    if ("+-*/(),".includes(char)) { tokens.push({ t: "op", v: char }); index += 1; continue; }
    throw new Error(`The character “${char}” is not allowed in a formula.`);
  }
  return tokens;
};

type Node = { n: "num"; v: number } | { n: "var"; v: string } | { n: "neg"; a: Node } | { n: "bin"; op: string; a: Node; b: Node } | { n: "call"; f: string; args: Node[] };

export const parseFormula = (source: string): { tree: Node; names: string[] } => {
  const tokens = tokenize(source); let position = 0; const names = new Set<string>();
  const peek = (): Token | undefined => tokens[position];
  const take = (op?: string): Token => { const token = tokens[position++]; if (!token || (op && !(token.t === "op" && token.v === op))) throw new Error(op ? `Expected “${op}” in the formula.` : "The formula ends too early."); return token; };
  const primary = (): Node => {
    const token = take();
    if (token.t === "num") return { n: "num", v: token.v };
    if (token.t === "name") {
      if (peek()?.t === "op" && peek()!.v === "(") {
        if (!FUNCTIONS[token.v]) throw new Error(`The function “${token.v}” is not allowed; use min, max, abs or log.`);
        take("("); const args: Node[] = [expression()]; while (peek()?.t === "op" && peek()!.v === ",") { take(","); args.push(expression()); } take(")");
        return { n: "call", f: token.v, args };
      }
      names.add(token.v); return { n: "var", v: token.v };
    }
    if (token.v === "(") { const inner = expression(); take(")"); return inner; }
    if (token.v === "-") return { n: "neg", a: primary() };
    throw new Error(`Unexpected “${token.v}” in the formula.`);
  };
  const product = (): Node => { let left = primary(); while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) { const op = take().v as string; left = { n: "bin", op, a: left, b: primary() }; } return left; };
  const expression = (): Node => { let left = product(); while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) { const op = take().v as string; left = { n: "bin", op, a: left, b: product() }; } return left; };
  const tree = expression();
  if (position < tokens.length) throw new Error("The formula has extra text after its end.");
  return { tree, names: [...names] };
};

/** NaN when a name is missing or a division by zero occurs, so such a patient has no value rather than a wrong one. */
export const evaluateFormula = (tree: Node, values: Record<string, number | undefined>): number => {
  const run = (node: Node): number => {
    if (node.n === "num") return node.v;
    if (node.n === "var") return values[node.v] ?? Number.NaN;
    if (node.n === "neg") return -run(node.a);
    if (node.n === "call") return FUNCTIONS[node.f]!(...node.args.map(run));
    const a = run(node.a), b = run(node.b);
    return node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : b === 0 ? Number.NaN : a / b;
  };
  const result = run(tree);
  return Number.isFinite(result) ? result : Number.NaN;
};
