// The tracing interpreter. It runs a program once and records:
//   steps:  every statement, test and resumption executed, with its source span
//   writes: every change to the machine state, in order, each with its provenance:
//     deps - writes whose values flowed into this value (data dependence)
//     idx  - writes that chose *where* a value was read from (list indexes)
//     ctl  - writes behind the conditions that let this code run (control dependence)
// From these, the debugger can rebuild any moment and explain any value.

import { parse, RewindError } from './parser.js';
import { emptyState, apply } from './state.js';

class Signal {
  constructor(kind, value = null, deps = []) {
    this.kind = kind;
    this.value = value;
    this.deps = deps;
  }
}

const NONE = [];
const union = (...lists) => {
  let n = 0;
  for (const l of lists) n += l.length;
  if (n === 0) return NONE;
  return [...new Set(lists.flat())];
};

export function format(v, state, quote = true, seen = new Set()) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
  if (typeof v === 'string') return quote ? JSON.stringify(v) : v;
  if (typeof v === 'boolean') return String(v);
  if (v.fn !== undefined) return `<fn ${v.name}>`;
  if (v.ref !== undefined) {
    if (seen.has(v.ref)) return '[…]';
    const list = state.heap.get(v.ref);
    if (!list) return '[?]';
    seen.add(v.ref);
    const s = `[${list.map((b) => format(b.v, state, true, seen)).join(', ')}]`;
    seen.delete(v.ref);
    return s;
  }
  return String(v);
}

const typeName = (v) => (v === null ? 'nil' : typeof v === 'object' ? (v.ref !== undefined ? 'a list' : 'a function') : typeof v === 'string' ? 'a string' : typeof v === 'number' ? 'a number' : 'a boolean');

export function run(src, { maxSteps = 100000, maxDepth = 200 } = {}) {
  const trace = { src, steps: [], writes: [], fns: [], status: 'done', error: null, ast: null };
  const state = emptyState();
  trace.finalState = state;
  let ast;
  try {
    ast = parse(src);
  } catch (e) {
    if (!(e instanceof RewindError)) throw e;
    trace.status = 'syntax';
    trace.error = { message: e.message, span: e.span, kind: 'syntax' };
    return trace;
  }
  trace.ast = ast;
  const { steps, writes } = trace;
  let ctl = NONE; // control dependence of the code now running
  let envIds = 0;
  let listIds = 0;
  const stmtSpans = []; // spans of the statements in progress, innermost last
  const stmtEnvs = []; // and the scopes they run in

  const emit = (w) => {
    w.id = writes.length;
    w.step = steps.length - 1;
    w.ctl = ctl;
    writes.push(w);
    apply(state, w);
    steps[steps.length - 1].to = writes.length;
    return w.id;
  };
  let curEnv = null; // the scope the running statement sees
  const step = (span, kind) => {
    if (steps.length >= maxSteps) throw new Signal('limit');
    steps.push({ span, kind, env: curEnv, from: writes.length, to: writes.length, depth: state.frames.length });
  };
  const newEnv = (parent, label) => {
    const id = envIds++;
    emit({ k: 'env', env: id, parent, label });
    return id;
  };
  const find = (env, name) => {
    for (let e = env; e !== null && e !== undefined; e = state.envs.get(e).parent) {
      if (state.envs.get(e).vars.has(name)) return e;
    }
    return null;
  };
  const setVar = (env, name, v, deps, idx, label) => {
    const old = state.envs.get(env).vars.get(name);
    const id = writes.length;
    emit({ k: 'var', env, name, old, new: { v, w: id }, deps, idx, label });
    return id;
  };
  const listOf = (v, span, what) => {
    if (v === null || typeof v !== 'object' || v.ref === undefined) throw new RewindError(`${what} needs a list, but got ${typeName(v)}`, span);
    return state.heap.get(v.ref);
  };
  const checkIndex = (list, i, span) => {
    if (typeof i !== 'number' || !Number.isInteger(i)) throw new RewindError(`List index must be a whole number, but got ${format(i, state)}`, span);
    if (i < 0 || i >= list.length) throw new RewindError(`Index ${i} is out of range: the list has ${list.length} item${list.length === 1 ? '' : 's'} (0 to ${list.length - 1})`, span);
  };
  const truth = (v, span) => {
    if (typeof v !== 'boolean') throw new RewindError(`A condition must be true or false, but this is ${format(v, state)}`, span);
    return v;
  };

  // --- expressions: return { v, d, x } (value, data deps, index deps) ---

  function evaluate(e, env) {
    switch (e.type) {
      case 'Literal':
        return { v: e.value, d: NONE, x: NONE };
      case 'Var': {
        const owner = find(env, e.name);
        if (owner === null) {
          if (BUILTINS[e.name]) return { v: { builtin: e.name }, d: NONE, x: NONE };
          throw new RewindError(`"${e.name}" is not defined`, e.span);
        }
        const b = state.envs.get(owner).vars.get(e.name);
        return { v: b.v, d: [b.w], x: NONE };
      }
      case 'List': {
        const id = listIds++;
        emit({ k: 'alloc', list: id, items: [], deps: NONE, idx: NONE });
        for (const item of e.items) {
          const r = evaluate(item, env);
          const list = state.heap.get(id);
          const w = writes.length;
          emit({ k: 'elem', list: id, i: list.length, old: undefined, new: { v: r.v, w }, deps: r.d, idx: r.x, label: `item ${list.length}` });
        }
        return { v: { ref: id }, d: NONE, x: NONE };
      }
      case 'Index': {
        const o = evaluate(e.object, env);
        const i = evaluate(e.index, env);
        if (typeof o.v === 'string') {
          if (typeof i.v !== 'number' || i.v < 0 || i.v >= o.v.length || !Number.isInteger(i.v)) throw new RewindError(`Index ${format(i.v, state)} is out of range for a string of length ${o.v.length}`, e.span);
          return { v: o.v[i.v], d: o.d, x: union(o.x, i.d, i.x) };
        }
        const list = listOf(o.v, e.object.span, 'Indexing');
        checkIndex(list, i.v, e.index.span);
        const b = list[i.v];
        return { v: b.v, d: [b.w], x: union(o.d, o.x, i.d, i.x) };
      }
      case 'Unary': {
        const a = evaluate(e.arg, env);
        if (e.op === '-') {
          if (typeof a.v !== 'number') throw new RewindError(`Cannot negate ${typeName(a.v)}`, e.span);
          return { v: -a.v, d: a.d, x: a.x };
        }
        return { v: !truth(a.v, e.arg.span), d: a.d, x: a.x };
      }
      case 'Binary': {
        if (e.op === 'and' || e.op === 'or') {
          const l = evaluate(e.left, env);
          const lv = truth(l.v, e.left.span);
          if (e.op === 'and' ? !lv : lv) return l;
          const r = evaluate(e.right, env);
          truth(r.v, e.right.span);
          return { v: r.v, d: union(l.d, r.d), x: union(l.x, r.x) };
        }
        const l = evaluate(e.left, env);
        const r = evaluate(e.right, env);
        return { v: binary(e, l.v, r.v), d: union(l.d, r.d), x: union(l.x, r.x) };
      }
      case 'Call':
        return call(e, env);
      default:
        throw new RewindError(`Cannot evaluate ${e.type}`, e.span);
    }
  }

  function binary(e, a, b) {
    const op = e.op;
    if (op === '==' || op === '!=') {
      const eq = a === b || (a && b && typeof a === 'object' && typeof b === 'object' && a.ref !== undefined && a.ref === b.ref);
      return op === '==' ? !!eq : !eq;
    }
    if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return format(a, state, false) + format(b, state, false);
    const bothNumbers = typeof a === 'number' && typeof b === 'number';
    const bothStrings = typeof a === 'string' && typeof b === 'string';
    if ((op === '<' || op === '<=' || op === '>' || op === '>=') && (bothNumbers || bothStrings)) {
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
    if (!bothNumbers) throw new RewindError(`Cannot use "${op}" on ${typeName(a)} and ${typeName(b)}`, e.span);
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        if (b === 0) throw new RewindError('Division by zero', e.right.span);
        return a / b;
      case '%':
        if (b === 0) throw new RewindError('Division by zero', e.right.span);
        return ((a % b) + b) % b;
      default:
        throw new RewindError(`Unknown operator ${op}`, e.span);
    }
  }

  function call(e, env) {
    const f = evaluate(e.callee, env);
    const args = e.args.map((a) => evaluate(a, env));
    if (f.v && f.v.builtin) return BUILTINS[f.v.builtin](args, e);
    if (!f.v || f.v.fn === undefined) throw new RewindError(`${format(f.v, state)} is not a function`, e.callee.span);
    const decl = trace.fns[f.v.fn];
    if (args.length !== decl.params.length) {
      throw new RewindError(`${decl.name} takes ${decl.params.length} argument${decl.params.length === 1 ? '' : 's'}, but was given ${args.length}`, e.span);
    }
    if (state.frames.length >= maxDepth) throw new RewindError(`Too much recursion: more than ${maxDepth} calls deep`, e.span);
    const callerStep = steps.length - 1;
    const local = envIds; // the id newEnv is about to use
    emit({ k: 'call', frame: { name: decl.name, env: local, callStep: callerStep, span: e.span }, deps: NONE, idx: NONE });
    newEnv(f.v.env, decl.name);
    decl.params.forEach((p, i) => setVar(local, p, args[i].v, args[i].d, args[i].x, `argument of ${decl.name}`));
    const savedCtl = ctl;
    ctl = NONE; // a function's own control flow starts fresh
    let result = { v: null, d: NONE, x: NONE };
    try {
      execBody(decl.body.body, local);
    } catch (s) {
      if (!(s instanceof Signal) || s.kind !== 'return') throw s;
      result = { v: s.value, d: s.deps, x: s.x || NONE };
    } finally {
      ctl = savedCtl;
    }
    emit({ k: 'ret', frame: state.frames[state.frames.length - 1], deps: NONE, idx: NONE, value: result.v });
    // Back in the caller: a new step, so later writes of this statement belong to it.
    curEnv = stmtEnvs[stmtEnvs.length - 1];
    step(stmtSpans[stmtSpans.length - 1], 'resume');
    return result;
  }

  const BUILTINS = {
    print(args) {
      const text = args.map((a) => format(a.v, state, false)).join(' ');
      emit({ k: 'out', text, deps: union(...args.map((a) => a.d)), idx: union(...args.map((a) => a.x)) });
      return { v: null, d: NONE, x: NONE };
    },
    len(args, e) {
      need(args, 1, 'len', e);
      const v = args[0].v;
      if (typeof v === 'string') return { v: v.length, d: args[0].d, x: NONE };
      return { v: listOf(v, e.args[0].span, 'len').length, d: args[0].d, x: NONE };
    },
    push(args, e) {
      need(args, 2, 'push', e);
      const list = listOf(args[0].v, e.args[0].span, 'push');
      const w = writes.length;
      emit({ k: 'elem', list: args[0].v.ref, i: list.length, old: undefined, new: { v: args[1].v, w }, deps: args[1].d, idx: args[1].x, label: 'pushed' });
      return { v: null, d: NONE, x: NONE };
    },
    pop(args, e) {
      need(args, 1, 'pop', e);
      const list = listOf(args[0].v, e.args[0].span, 'pop');
      if (!list.length) throw new RewindError('Cannot pop from an empty list', e.span);
      const old = list[list.length - 1];
      emit({ k: 'elem', list: args[0].v.ref, i: list.length - 1, old, new: undefined, deps: NONE, idx: NONE, label: 'popped' });
      return { v: old.v, d: [old.w], x: NONE };
    },
    range(args, e) {
      if (args.length < 1 || args.length > 2) throw new RewindError('range takes 1 or 2 numbers', e.span);
      const [lo, hi] = args.length === 1 ? [0, args[0].v] : [args[0].v, args[1].v];
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new RewindError('range needs whole numbers', e.span);
      if (hi - lo > 10000) throw new RewindError('range is limited to 10,000 numbers', e.span);
      const id = listIds++;
      const w = writes.length;
      const items = [];
      for (let i = lo; i < hi; i++) items.push({ v: i, w });
      emit({ k: 'alloc', list: id, items, deps: union(...args.map((a) => a.d)), idx: NONE, label: 'range' });
      return { v: { ref: id }, d: NONE, x: NONE };
    },
    str(args, e) {
      need(args, 1, 'str', e);
      return { v: format(args[0].v, state, false), d: args[0].d, x: args[0].x };
    },
    abs: math('abs', Math.abs),
    floor: math('floor', Math.floor),
    sqrt: math('sqrt', Math.sqrt),
    min: math2('min', Math.min),
    max: math2('max', Math.max),
  };
  function need(args, n, name, e) {
    if (args.length !== n) throw new RewindError(`${name} takes ${n} argument${n === 1 ? '' : 's'}, but was given ${args.length}`, e.span);
  }
  function math(name, f) {
    return (args, e) => {
      need(args, 1, name, e);
      if (typeof args[0].v !== 'number') throw new RewindError(`${name} needs a number, but got ${typeName(args[0].v)}`, e.span);
      return { v: f(args[0].v), d: args[0].d, x: args[0].x };
    };
  }
  function math2(name, f) {
    return (args, e) => {
      need(args, 2, name, e);
      if (typeof args[0].v !== 'number' || typeof args[1].v !== 'number') throw new RewindError(`${name} needs two numbers`, e.span);
      return { v: f(args[0].v, args[1].v), d: union(args[0].d, args[1].d), x: union(args[0].x, args[1].x) };
    };
  }

  // --- statements ---

  function execBody(body, env) {
    for (const s of body) exec(s, env);
  }

  function block(b, env, label = 'block') {
    execBody(b.body, newEnv(env, label));
  }

  function withControl(deps, f) {
    const saved = ctl;
    ctl = union(ctl, deps);
    try {
      f();
    } finally {
      ctl = saved;
    }
  }

  function exec(s, env) {
    stmtSpans.push(s.span ?? stmtSpans[stmtSpans.length - 1]);
    stmtEnvs.push(env);
    const saved = curEnv;
    curEnv = env;
    try {
      execInner(s, env);
    } catch (e) {
      // Remember the innermost scope at the moment of an error, for the final step.
      if ((e instanceof RewindError || (e instanceof Signal && e.kind === 'limit')) && e.env === undefined) e.env = env;
      throw e;
    } finally {
      stmtSpans.pop();
      stmtEnvs.pop();
      curEnv = saved;
    }
  }

  function execInner(s, env) {
    switch (s.type) {
      case 'Let': {
        step(s.span, 'stmt');
        const r = evaluate(s.value, env);
        setVar(env, s.name, r.v, r.d, r.x);
        return;
      }
      case 'Fn': {
        step(s.span, 'stmt');
        const id = trace.fns.length;
        trace.fns.push(s);
        setVar(env, s.name, { fn: id, env, name: s.name }, NONE, NONE, 'function');
        return;
      }
      case 'Assign': {
        step(s.span, 'stmt');
        const t = s.target;
        if (t.type === 'Var') {
          const owner = find(env, t.name);
          if (owner === null) throw new RewindError(`"${t.name}" is not defined; declare it first with let`, t.span);
          let r = evaluate(s.value, env);
          if (s.op !== '=') {
            const cur = state.envs.get(owner).vars.get(t.name);
            const v = binary({ op: s.op[0], span: s.span, right: s.value }, cur.v, r.v);
            r = { v, d: union([cur.w], r.d), x: r.x };
          }
          setVar(owner, t.name, r.v, r.d, r.x);
        } else {
          const o = evaluate(t.object, env);
          const i = evaluate(t.index, env);
          const list = listOf(o.v, t.object.span, 'Assigning to an element');
          checkIndex(list, i.v, t.index.span);
          let r = evaluate(s.value, env);
          const old = list[i.v];
          if (s.op !== '=') r = { v: binary({ op: s.op[0], span: s.span, right: s.value }, old.v, r.v), d: union([old.w], r.d), x: r.x };
          const w = writes.length;
          emit({ k: 'elem', list: o.v.ref, i: i.v, old, new: { v: r.v, w }, deps: r.d, idx: union(o.d, o.x, i.d, i.x, r.x), target: src.slice(t.object.span.start.offset, t.object.span.end.offset) });
        }
        return;
      }
      case 'ExprStmt':
        step(s.span, 'stmt');
        evaluate(s.expr, env);
        return;
      case 'If': {
        step(s.test.span, 'test');
        const t = evaluate(s.test, env);
        const branch = truth(t.v, s.test.span) ? s.then : s.otherwise;
        if (branch) withControl(union(t.d, t.x), () => block(branch, env));
        return;
      }
      case 'While': {
        for (;;) {
          step(s.test.span, 'test');
          const t = evaluate(s.test, env);
          if (!truth(t.v, s.test.span)) return;
          try {
            withControl(union(t.d, t.x), () => block(s.body, env));
          } catch (sig) {
            if (sig instanceof Signal && sig.kind === 'break') return;
            if (!(sig instanceof Signal && sig.kind === 'continue')) throw sig;
          }
        }
      }
      case 'For': {
        // Like while, the loop line takes one step per check: here the first check
        // also evaluates what to loop over.
        step(s.span, 'test');
        const it = evaluate(s.iter, env);
        const listRef = it.v;
        listOf(listRef, s.iter.span, 'for … in');
        const loopEnv = newEnv(env, 'for');
        curEnv = loopEnv;
        for (let i = 0; ; i++) {
          if (i > 0) step(s.span, 'test');
          const list = state.heap.get(listRef.ref);
          if (i >= list.length) return;
          const b = list[i];
          setVar(loopEnv, s.name, b.v, [b.w], union(it.d, it.x), 'loop variable');
          try {
            withControl(union(it.d, it.x), () => block(s.body, loopEnv));
          } catch (sig) {
            if (sig instanceof Signal && sig.kind === 'break') return;
            if (!(sig instanceof Signal && sig.kind === 'continue')) throw sig;
          }
        }
      }
      case 'Return': {
        step(s.span, 'stmt');
        if (state.frames.length === 0) throw new RewindError('return can only be used inside a function', s.span);
        const r = s.value ? evaluate(s.value, env) : { v: null, d: NONE, x: NONE };
        const sig = new Signal('return', r.v, r.d);
        sig.x = r.x;
        throw sig;
      }
      case 'Break':
      case 'Continue':
        step(s.span, 'stmt');
        throw new Signal(s.type === 'Break' ? 'break' : 'continue');
      default:
        throw new RewindError(`Cannot run ${s.type}`, s.span);
    }
  }

  let errorEnv = null;
  try {
    stmtSpans.push(null);
    steps.push({ span: null, kind: 'start', from: 0, to: 0, depth: 0 });
    const global = newEnv(null, 'global');
    curEnv = global;
    execBody(ast.body, global);
  } catch (e) {
    errorEnv = e.env ?? null;
    if (e instanceof Signal && e.kind === 'limit') {
      trace.status = 'limit';
      trace.error = { message: `Stopped after ${maxSteps.toLocaleString('en')} steps. Is there an infinite loop?`, span: steps[steps.length - 1].span, kind: 'limit' };
    } else if (e instanceof Signal) {
      trace.status = 'error';
      const what = e.kind === 'break' || e.kind === 'continue' ? `${e.kind} can only be used inside a loop` : `Unexpected ${e.kind}`;
      trace.error = { message: what, span: steps[steps.length - 1].span, kind: 'runtime' };
    } else if (e instanceof RewindError) {
      trace.status = 'error';
      trace.error = { message: e.message, span: e.span, kind: 'runtime' };
    } else throw e;
  }
  // A final step marks the end, or the moment of the error.
  steps.push({ span: trace.error ? trace.error.span : null, kind: trace.error ? 'error' : 'end', env: errorEnv ?? 0, from: writes.length, to: writes.length, depth: state.frames.length });
  return trace;
}
