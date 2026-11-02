// Provenance: where did a value come from?
//
// Every write records the writes whose values flowed into it (deps), the writes that
// decided where it was read from (idx), and the writes behind the conditions that let
// its code run (ctl). Following deps backwards from any value gives its full history.

import { format } from './interp.js';

const short = (v) => {
  if (v !== null && typeof v === 'object') return v.ref !== undefined ? 'a list' : `<fn ${v.name}>`;
  return format(v, null);
};

export function lineOf(trace, w) {
  const st = trace.steps[w.step];
  return st && st.span ? st.span.start.line : null;
}

export function sourceLine(trace, line) {
  return line ? trace.src.split('\n')[line - 1].trim() : '';
}

// A one-line description of a write, for the "why" tree.
export function describe(trace, id) {
  const w = trace.writes[id];
  const line = lineOf(trace, w);
  let text;
  switch (w.k) {
    case 'var':
      text = `${w.name} = ${short(w.new.v)}`;
      break;
    case 'elem':
      if (w.new === undefined) text = `item ${w.i} removed`;
      else text = `${w.target ? `${w.target}[${w.i}]` : w.label === 'pushed' ? `pushed item ${w.i}` : `item ${w.i}`} = ${short(w.new.v)}`;
      break;
    case 'out':
      text = `printed "${w.text}"`;
      break;
    case 'alloc':
      text = w.label === 'range' ? 'range of numbers' : 'new list';
      break;
    default:
      text = w.k;
  }
  const note = w.k === 'var' && w.label ? w.label : '';
  return { id, k: w.k, text, note, line, step: w.step, code: sourceLine(trace, line), deps: w.deps || [], idx: w.idx || [], ctl: w.ctl || [], origin: !(w.deps && w.deps.length) };
}

// Every write a value ultimately depends on through data flow, and the subset with no
// further data inputs: where the value's ingredients were first written.
export function origins(trace, id, limit = 20000) {
  const seen = new Set([id]);
  const stack = [id];
  const leaves = [];
  while (stack.length && seen.size < limit) {
    const w = trace.writes[stack.pop()];
    const deps = w.deps || [];
    if (deps.length === 0 && w.id !== id) leaves.push(w.id);
    for (const d of deps) {
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  leaves.sort((a, b) => a - b);
  return { leaves, reached: seen.size - 1, truncated: stack.length > 0 };
}

// All writes that ever produced the variable `name` in scope `env`, in order.
export function history(trace, env, name, upTo = Infinity) {
  const out = [];
  for (const w of trace.writes) {
    if (w.step >= upTo) break;
    if (w.k === 'var' && w.env === env && w.name === name) out.push(w.id);
  }
  return out;
}
