/** Small, safe arithmetic evaluator (no eval): numbers, + - * / % ^, parentheses, Math functions. */
export function calculate(expression: string): number {
  const tokens = expression.replace(/\s+/g, "").match(/\d+\.?\d*(e[+-]?\d+)?|\.\d+|[a-zA-Z_]+|\*\*|[-+*/%^(),]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) throw new Error("Unsupported characters in expression.");
  let i = 0;
  const fns: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    log: Math.log10, ln: Math.log, log2: Math.log2, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow,
  };
  const consts: Record<string, number> = { PI: Math.PI, pi: Math.PI, E: Math.E, e: Math.E };
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const power = (): number => {
    const base = unary();
    if (peek() === "^" || peek() === "**") {
      next();
      return base ** power();
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") {
      next();
      return -unary();
    }
    if (peek() === "+") {
      next();
      return unary();
    }
    return atom();
  };
  const atom = (): number => {
    const t = next();
    if (t === undefined) throw new Error("Incomplete expression.");
    if (t === "(") {
      const v = expr();
      if (next() !== ")") throw new Error("Missing ).");
      return v;
    }
    if (/^[\d.]/.test(t)) return Number(t);
    if (t in consts) return consts[t];
    if (t in fns) {
      if (next() !== "(") throw new Error(`${t} needs parentheses.`);
      const params = [expr()];
      while (peek() === ",") {
        next();
        params.push(expr());
      }
      if (next() !== ")") throw new Error("Missing ).");
      return fns[t](...params);
    }
    throw new Error(`Unknown name: ${t}`);
  };
  const value = expr();
  if (i !== tokens.length) throw new Error("Unexpected input after the expression.");
  return value;
}
