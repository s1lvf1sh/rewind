// Moving through a recorded run like a debugger: step, step over, step out and
// continue to a breakpoint, in either direction. Positions are step indexes, where
// position t shows the state just before step t runs. The last step marks the end.

export const lineAt = (trace, t) => trace.steps[t]?.span?.start.line ?? null;

export function move(trace, t, how, breakpoints = new Set()) {
  const steps = trace.steps;
  const last = steps.length - 1;
  const depth = steps[t]?.depth ?? 0;
  const find = (from, dir, ok) => {
    for (let i = from; i >= 0 && i <= last; i += dir) if (ok(steps[i], i)) return i;
    return dir > 0 ? last : 0;
  };
  // A resumption step continues a statement already shown, so breakpoints skip it.
  const hit = (s) => s.kind !== 'resume' && s.span && breakpoints.has(s.span.start.line);
  switch (how) {
    case 'start': return 0;
    case 'end': return last;
    case 'forward': return Math.min(last, t + 1);
    case 'back': return Math.max(0, t - 1);
    // Stepping over lands on the next statement, not on the moment a call returns.
    case 'over': return find(t + 1, 1, (s) => s.depth <= depth && s.kind !== 'resume');
    case 'over-back': return find(t - 1, -1, (s) => s.depth <= depth && s.kind !== 'resume');
    case 'out': return depth === 0 ? last : find(t + 1, 1, (s) => s.depth < depth);
    case 'out-back': return depth === 0 ? 0 : find(t - 1, -1, (s) => s.depth < depth);
    case 'continue': return find(t + 1, 1, (s, i) => hit(s) || i === last);
    case 'continue-back': return find(t - 1, -1, hit);
    default: throw new Error(`unknown move ${how}`);
  }
}

// The next (dir 1) or previous (dir -1) time a given line runs, or -1.
export function nextRun(trace, t, line, dir) {
  const steps = trace.steps;
  for (let i = t + dir; i >= 0 && i < steps.length; i += dir) {
    const s = steps[i];
    if (s.kind !== 'resume' && s.span && s.span.start.line === line && s.kind !== 'end') return i;
  }
  return -1;
}

// How many times each line ran.
export function lineCounts(trace) {
  const counts = new Map();
  for (const s of trace.steps) {
    if (!s.span || s.kind === 'resume' || s.kind === 'end' || s.kind === 'error') continue;
    const l = s.span.start.line;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  return counts;
}
