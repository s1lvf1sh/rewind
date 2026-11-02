// Lexer and parser for Rewind's language: a small, dynamically typed language with
// numbers, strings, booleans, nil, lists, functions (with closures), if/else, while,
// for-in, break, continue and return. Every AST node carries its source span, so the
// debugger can point at exactly what ran.

export class RewindError extends Error {
  constructor(message, span, kind = 'error') {
    super(message);
    this.span = span;
    this.kind = kind;
  }
}

const KEYWORDS = new Set(['let', 'fn', 'if', 'else', 'while', 'for', 'in', 'return', 'break', 'continue', 'true', 'false', 'nil', 'and', 'or', 'not']);
const PUNCT = ['==', '!=', '<=', '>=', '+=', '-=', '*=', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ';'];

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let depth = 0; // inside ( or [ newlines do not end statements
  const at = () => ({ line, col, offset: i });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    if (c === '\n') {
      const start = at();
      advance();
      if (depth === 0) tokens.push({ type: 'nl', start, end: at() });
      continue;
    }
    if (/\s/.test(c)) {
      advance();
      continue;
    }
    const start = at();
    if (/[0-9]/.test(c)) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i])) {
        s += src[i];
        advance();
      }
      if ((s.match(/\./g) || []).length > 1) throw new RewindError(`Malformed number "${s}"`, { start, end: at() }, 'syntax');
      tokens.push({ type: 'num', value: Number(s), start, end: at() });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        s += src[i];
        advance();
      }
      tokens.push({ type: KEYWORDS.has(s) ? s : 'ident', value: s, start, end: at() });
      continue;
    }
    if (c === '"') {
      advance();
      let s = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') throw new RewindError('Unterminated string', { start, end: at() }, 'syntax');
        if (src[i] === '\\') {
          advance();
          s += { n: '\n', t: '\t', '"': '"', '\\': '\\' }[src[i]] ?? src[i];
        } else s += src[i];
        advance();
      }
      if (i >= src.length) throw new RewindError('Unterminated string', { start, end: at() }, 'syntax');
      advance();
      tokens.push({ type: 'str', value: s, start, end: at() });
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new RewindError(`Unexpected character "${c}"`, { start, end: { ...start, col: start.col + 1, offset: start.offset + 1 } }, 'syntax');
    if (p === '(' || p === '[') depth++;
    if ((p === ')' || p === ']') && depth > 0) depth--;
    advance(p.length);
    tokens.push({ type: p, start, end: at() });
  }
  tokens.push({ type: 'eof', start: at(), end: at() });
  return tokens;
}

export function parse(src) {
  const tokens = lex(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const check = (type) => tokens[p].type === type;
  const span = (start, end) => ({ start: start.start, end: end.end });
  const describe = (t) => (t.type === 'nl' ? 'end of line' : t.type === 'eof' ? 'end of program' : t.type === 'ident' || t.type === 'num' ? `"${t.value}"` : t.type === 'str' ? 'a string' : `"${t.type}"`);
  const expect = (type, what) => {
    if (!check(type)) throw new RewindError(`Expected ${what ?? `"${type}"`} but found ${describe(peek())}`, span(peek(), peek()), 'syntax');
    return next();
  };
  // A closing bracket, reported against the line that opened it if it is missing.
  const close = (type, open) => {
    if (check(type)) return next();
    const where = open.start.line === peek().start.line ? '' : ` opened on line ${open.start.line}`;
    throw new RewindError(`Expected "${type}" to close the "${open.type}"${where}, but found ${describe(peek())}`, span(open, open), 'syntax');
  };
  const skipNewlines = () => {
    while (check('nl') || check(';')) next();
  };
  const endStatement = () => {
    if (check('nl') || check(';')) return skipNewlines();
    if (check('}') || check('eof')) return;
    throw new RewindError(`Expected end of line but found ${describe(peek())}`, span(peek(), peek()), 'syntax');
  };

  function program() {
    const body = [];
    skipNewlines();
    while (!check('eof')) {
      body.push(statement());
      endStatement();
    }
    return { type: 'Program', body };
  }

  function block() {
    const open = expect('{');
    const body = [];
    skipNewlines();
    while (!check('}')) {
      if (check('eof')) throw new RewindError('Missing "}" to close this block', span(open, open), 'syntax');
      body.push(statement());
      endStatement();
    }
    const close = next();
    return { type: 'Block', body, span: span(open, close) };
  }

  function statement() {
    const t = peek();
    switch (t.type) {
      case 'let': {
        next();
        const name = expect('ident', 'a variable name');
        expect('=');
        const value = expression();
        return { type: 'Let', name: name.value, value, span: span(t, tokens[p - 1]) };
      }
      case 'fn': {
        next();
        const name = expect('ident', 'a function name');
        expect('(');
        const params = [];
        while (!check(')')) {
          params.push(expect('ident', 'a parameter name').value);
          if (!check(')')) expect(',');
        }
        const close = next();
        const body = block();
        return { type: 'Fn', name: name.value, params, body, span: span(t, close) };
      }
      case 'if':
        return ifStatement();
      case 'while': {
        next();
        const test = expression();
        const body = block();
        return { type: 'While', test, body, span: test.span };
      }
      case 'for': {
        next();
        const name = expect('ident', 'a loop variable');
        expect('in');
        const iter = expression();
        const body = block();
        return { type: 'For', name: name.value, iter, body, span: { start: t.start, end: iter.span.end } };
      }
      case 'return': {
        next();
        const value = check('nl') || check(';') || check('}') || check('eof') ? null : expression();
        return { type: 'Return', value, span: span(t, tokens[p - 1]) };
      }
      case 'break':
      case 'continue':
        next();
        return { type: t.type === 'break' ? 'Break' : 'Continue', span: span(t, t) };
      default: {
        const target = expression();
        const op = peek().type;
        if (op === '=' || op === '+=' || op === '-=' || op === '*=') {
          if (target.type !== 'Var' && target.type !== 'Index') throw new RewindError('Only a variable or a list element can be assigned to', target.span, 'syntax');
          next();
          const value = expression();
          return { type: 'Assign', target, op, value, span: { start: target.span.start, end: value.span.end } };
        }
        return { type: 'ExprStmt', expr: target, span: target.span };
      }
    }
  }

  function ifStatement() {
    const t = expect('if');
    const test = expression();
    const then = block();
    let otherwise = null;
    const save = p;
    skipNewlines();
    if (check('else')) {
      next();
      otherwise = check('if') ? { type: 'Block', body: [ifStatement()], span: null } : block();
    } else p = save;
    return { type: 'If', test, then, otherwise, span: { start: t.start, end: test.span.end } };
  }

  // Precedence climbing, loosest first.
  function expression() {
    return or();
  }
  function binaryLevel(ops, sub) {
    return () => {
      let left = sub();
      while (ops.includes(peek().type)) {
        const op = next().type;
        const right = sub();
        left = { type: 'Binary', op, left, right, span: { start: left.span.start, end: right.span.end } };
      }
      return left;
    };
  }
  function unary() {
    if (check('-') || check('not')) {
      const t = next();
      const arg = unary();
      return { type: 'Unary', op: t.type, arg, span: { start: t.start, end: arg.span.end } };
    }
    return postfix();
  }
  const mul = binaryLevel(['*', '/', '%'], unary);
  const add = binaryLevel(['+', '-'], mul);
  const cmp = binaryLevel(['==', '!=', '<', '<=', '>', '>='], add);
  const and = binaryLevel(['and'], cmp);
  const or = binaryLevel(['or'], and);

  function postfix() {
    let e = primary();
    for (;;) {
      if (check('(')) {
        const open = next();
        const args = [];
        while (!check(')')) {
          args.push(expression());
          if (!check(')')) {
            if (!check(',')) close(')', open);
            next();
          }
        }
        const end = next();
        e = { type: 'Call', callee: e, args, span: { start: e.span.start, end: end.end } };
      } else if (check('[')) {
        next();
        const open = tokens[p - 1];
        const index = expression();
        const end = close(']', open);
        e = { type: 'Index', object: e, index, span: { start: e.span.start, end: end.end } };
      } else return e;
    }
  }

  function primary() {
    const t = next();
    const s = span(t, t);
    switch (t.type) {
      case 'num':
      case 'str':
        return { type: 'Literal', value: t.value, span: s };
      case 'true':
      case 'false':
        return { type: 'Literal', value: t.type === 'true', span: s };
      case 'nil':
        return { type: 'Literal', value: null, span: s };
      case 'ident':
        return { type: 'Var', name: t.value, span: s };
      case '(': {
        const e = expression();
        const end = close(')', t);
        return { ...e, span: { start: t.start, end: end.end }, paren: true };
      }
      case '[': {
        const items = [];
        while (!check(']')) {
          items.push(expression());
          if (!check(']')) {
            if (!check(',')) close(']', t);
            next();
          }
        }
        const end = next();
        return { type: 'List', items, span: { start: t.start, end: end.end } };
      }
      default:
        throw new RewindError(`Expected a value but found ${describe(t)}`, s, 'syntax');
    }
  }

  return program();
}
