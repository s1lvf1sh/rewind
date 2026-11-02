// The machine state, and the only two ways it ever changes: apply(write) and undo(write).
//
// The interpreter never touches state directly. It emits writes, which are applied as it
// runs and recorded in order. Afterwards a Cursor can move to any step in the program's
// history by applying writes forward or undoing them backward, using the same two
// functions, so travelling in time cannot disagree with what actually ran.
//
// A binding is { v, w }: a value and the id of the write that produced it.
// Values are numbers, strings, booleans, null, { ref } for a list in the heap,
// or { fn, env, name } for a function closing over an environment.

export function emptyState() {
  return { envs: new Map(), heap: new Map(), frames: [], output: [] };
}

export function apply(s, w) {
  switch (w.k) {
    case 'env':
      s.envs.set(w.env, { parent: w.parent, vars: new Map(), label: w.label });
      break;
    case 'var':
      s.envs.get(w.env).vars.set(w.name, w.new);
      break;
    case 'alloc':
      s.heap.set(w.list, w.items.slice());
      break;
    case 'elem': {
      const list = s.heap.get(w.list);
      if (w.new === undefined) list.length = w.i; // pop
      else list[w.i] = w.new;
      break;
    }
    case 'call':
      s.frames.push(w.frame);
      break;
    case 'ret':
      s.frames.pop();
      break;
    case 'out':
      s.output.push({ text: w.text, w: w.id });
      break;
    default:
      throw new Error(`unknown write ${w.k}`);
  }
}

export function undo(s, w) {
  switch (w.k) {
    case 'env':
      s.envs.delete(w.env);
      break;
    case 'var':
      if (w.old === undefined) s.envs.get(w.env).vars.delete(w.name);
      else s.envs.get(w.env).vars.set(w.name, w.old);
      break;
    case 'alloc':
      s.heap.delete(w.list);
      break;
    case 'elem': {
      const list = s.heap.get(w.list);
      if (w.old === undefined) list.length = w.i; // undo a push
      else list[w.i] = w.old;
      break;
    }
    case 'call':
      s.frames.pop();
      break;
    case 'ret':
      s.frames.push(w.frame);
      break;
    case 'out':
      s.output.pop();
      break;
    default:
      throw new Error(`unknown write ${w.k}`);
  }
}

// A cursor into a recorded run. Position t means "about to execute step t";
// position steps.length is the end of the program.
export class Cursor {
  constructor(trace) {
    this.trace = trace;
    this.state = trace.finalState;
    this.pos = trace.steps.length;
  }

  seek(t) {
    const { steps, writes } = this.trace;
    t = Math.max(0, Math.min(steps.length, t));
    while (this.pos < t) {
      const st = steps[this.pos++];
      for (let i = st.from; i < st.to; i++) apply(this.state, writes[i]);
    }
    while (this.pos > t) {
      const st = steps[--this.pos];
      for (let i = st.to - 1; i >= st.from; i--) undo(this.state, writes[i]);
    }
    return this;
  }
}

// A deep, comparable copy of the state, used by tests to check that travelling back
// reproduces exactly what was there.
export function snapshot(s) {
  const envs = [...s.envs].map(([id, e]) => [id, e.parent, e.label, [...e.vars].map(([n, b]) => [n, JSON.stringify(b)])]);
  const heap = [...s.heap].map(([id, l]) => [id, l.map((b) => JSON.stringify(b))]);
  return JSON.stringify({ envs, heap, frames: s.frames.map((f) => [f.name, f.env, f.callStep]), output: s.output });
}
