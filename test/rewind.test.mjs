// Headless checks for Rewind: the language, time travel, provenance and navigation.
// Run with `npm test`.

import { run, format } from '../src/interp.js';
import { Cursor, snapshot } from '../src/state.js';
import { origins, describe, history } from '../src/why.js';
import { move, nextRun, lineCounts } from '../src/nav.js';
import { EXAMPLES } from '../src/examples.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const t0 = Date.now();
const out = (src) => {
  const t = run(src);
  return t.error ? `ERROR line ${t.error.span?.start.line}: ${t.error.message}` : t.finalState.output.map((o) => o.text).join('\n');
};

// 1. The language does what it says.
{
  const cases = [
    ['print(1 + 2 * 3 - 4 / 2)', '5'],
    ['print((1 + 2) * 3, 7 % 3, -7 % 3)', '9 1 2'],
    ['print(0.1 + 0.2)', '0.3'],
    ['print("a" + 1 + 2, 1 + 2 + "a")', 'a12 3a'],
    ['print(1 < 2 and 2 < 3, not (1 == 1) or false)', 'true false'],
    ['let x = 5\nif x > 3 { print("big") } else if x > 1 { print("mid") } else { print("small") }', 'big'],
    ['let x = 2\nif x > 3 { print("big") } else if x > 1 { print("mid") } else { print("small") }', 'mid'],
    ['let s = 0\nfor i in range(10) {\n  if i == 7 { break }\n  if i % 2 == 0 { continue }\n  s += i\n}\nprint(s)', '9'],
    ['let n = 0\nwhile n < 5 { n += 1 }\nprint(n)', '5'],
    ['fn f(n) {\n  if n == 0 { return 1 }\n  return n * f(n - 1)\n}\nprint(f(10))', '3628800'],
    ['fn make() {\n  let box = [0]\n  fn inc() {\n    box[0] += 1\n    return box[0]\n  }\n  return inc\n}\nlet c = make()\nc()\nc()\nprint(c())', '3'],
    ['let a = [1, [2, 3], "x"]\npush(a, 4)\nprint(a)\nprint(len(a), pop(a), a[1][0], a)', '[1, [2, 3], "x", 4]\n4 4 2 [1, [2, 3], "x"]'],
    ['let s = "hello"\nprint(len(s), s[1], str(42) + "!")', '5 e 42!'],
    ['print(abs(-3), floor(2.7), sqrt(16), min(3, 9), max(3, 9))', '3 2 4 3 9'],
    ['let a = [3, 1, 2]\nlet b = a\nb[0] = 9\nprint(a)', '[9, 1, 2]'],
    ['print(range(2, 5), [] == [], nil)', '[2, 3, 4] false nil'],
    ['# comments\nlet x = 1 # trailing\nprint(x)', '1'],
    ['let f = 3; let g = 4; print(f * g)', '12'],
    ['fn add(a, b) { return a + b }\nprint(add(\n  1,\n  2\n))', '3'],
  ];
  const wrong = cases.filter(([src, want]) => out(src) !== want).map(([src, want]) => `${JSON.stringify(src)} gave ${JSON.stringify(out(src))}, want ${JSON.stringify(want)}`);
  check(`${cases.length} programs produce the right output`, wrong.length === 0, wrong.join('; '));
}

// 2. Mistakes are reported clearly, on the right line.
{
  const cases = [
    ['let x = (1 + 2\nprint(x)', 1, /Expected "\)" to close the "\(" opened on line 1/],
    ['print(max(1,\n  2)', 1, /close the "\(" opened on line 1/],
    ['fn f( {\n}', 1, /parameter name/],
    ['print("unterminated)', 1, /Unterminated string/],
    ['let a = 1\nwhile a < 3 {\n  a += 1\n', 2, /Missing "}"/],
    ['let x = 1 @ 2', 1, /Unexpected character "@"/],
    ['print(y)', 1, /"y" is not defined/],
    ['let a = [1]\nprint(a[3])', 2, /Index 3 is out of range: the list has 1 item/],
    ['let z = 0\nprint(10 / z)', 2, /Division by zero/],
    ['if 1 { print(1) }', 1, /must be true or false/],
    ['fn f(a) { return a }\nf(1, 2)', 2, /takes 1 argument, but was given 2/],
    ['fn f(n) { return f(n + 1) }\nf(0)', 1, /Too much recursion/],
    ['break', 1, /only be used inside a loop/],
    ['x = 3', 1, /declare it first with let/],
    ['print("a" - 1)', 1, /Cannot use "-" on a string and a number/],
  ];
  const wrong = [];
  for (const [src, line, re] of cases) {
    const t = run(src);
    if (!t.error || t.error.span?.start.line !== line || !re.test(t.error.message)) wrong.push(`${JSON.stringify(src)} → ${t.error ? `line ${t.error.span?.start.line}: ${t.error.message}` : 'no error'}`);
  }
  check(`${cases.length} mistakes are caught with a clear message on the right line`, wrong.length === 0, wrong.join('; '));
  const loop = run('let i = 0\nwhile true { i += 1 }', { maxSteps: 5000 });
  check('an infinite loop is stopped at the step limit, history intact', loop.status === 'limit' && loop.steps.length === 5001);
}

// 3. Time travel is exact. The oracle is independent of undo: re-running the program
//    cut off at step t must leave exactly the state that rewinding to t produces.
{
  let compared = 0;
  const bad = [];
  const programs = EXAMPLES.map((e) => [e.id, e.code]);
  programs.push(['closure', 'fn make() {\n  let box = [0]\n  fn inc() {\n    box[0] += 1\n    return box[0]\n  }\n  return inc\n}\nlet c = make()\nc()\nlet s = [c(), c()]\npush(s, pop(s) * 2)\nprint(s)']);
  for (const [name, src] of programs) {
    const trace = run(src, { maxSteps: 3000 });
    const cursor = new Cursor(trace);
    const n = trace.steps.length - 1;
    const stride = Math.max(1, Math.floor(n / 60));
    const positions = [];
    for (let t = 1; t <= n; t += stride) positions.push(t);
    positions.push(n);
    // Visit them in a scrambled order, so the cursor moves both ways by varying amounts.
    positions.sort((a, b) => ((a * 7919) % 1000) - ((b * 7919) % 1000));
    for (const t of positions) {
      cursor.seek(t);
      const oracle = run(src, { maxSteps: t }).finalState;
      compared++;
      if (snapshot(cursor.state) !== snapshot(oracle)) bad.push(`${name}@${t}`);
    }
    cursor.seek(0);
    cursor.seek(n);
  }
  check('rewinding to any step reproduces the state a fresh run reaches there', bad.length === 0, `${compared} positions in ${programs.length} programs; ${bad.length ? `mismatch at ${bad.slice(0, 5).join(', ')}` : 'all identical'}`);
}

// 4. Provenance: why does a value have the value it has?
{
  const avg = run(EXAMPLES.find((e) => e.id === 'average').code);
  const printed = avg.finalState.output[0].w;
  const leaves = origins(avg, printed).leaves.map((id) => describe(avg, id).text);
  check('the wrong average comes from only the first four scores', ['item 0 = 72', 'item 1 = 85', 'item 2 = 64', 'item 3 = 91'].every((s) => leaves.includes(s)) && !leaves.includes('item 4 = 78'), leaves.join(', '));

  const fib = run(EXAMPLES.find((e) => e.id === 'fib').code);
  const o = origins(fib, fib.finalState.output[0].w);
  check('fib(8) flows through every call back to the single 8', o.leaves.length === 1 && describe(fib, o.leaves[0]).text === 'n = 8', `${o.leaves.map((id) => describe(fib, id).text)}; ${o.reached} writes`);

  const cart = run(EXAMPLES.find((e) => e.id === 'cart').code);
  const totals = cart.writes.filter((w) => w.k === 'var' && w.name === 'total');
  const discounted = totals[totals.length - 1];
  const ctlNames = discounted.ctl.map((id) => cart.writes[id].name);
  check('the discount depends on the item count through the if condition', ctlNames.includes('items') && !discounted.deps.some((id) => cart.writes[id].name === 'items'), `control: ${ctlNames.join(', ')}`);

  const src = 'let a = [10, 20, 30]\nlet i = 2\nlet x = a[i]\nprint(x)';
  const t = run(src);
  const x = t.writes.find((w) => w.k === 'var' && w.name === 'x');
  check('reading a[i] depends on the item for its value, and on i for where', x.deps.length === 1 && describe(t, x.deps[0]).text === 'item 2 = 30' && x.idx.some((id) => t.writes[id].name === 'i'));

  const sw = run('let a = [5, 1]\nlet t = a[0]\na[0] = a[1]\na[1] = t\nprint(a[1])');
  const swapped = origins(sw, sw.finalState.output[0].w).leaves.map((id) => describe(sw, id).text);
  check('a swapped value is traced back through the swap to where it started', swapped.length === 1 && swapped[0] === 'item 0 = 5', swapped.join(', '));

  const fnRet = run('fn double(v) { return v * 2 }\nlet base = 21\nlet r = double(base)\nprint(r)');
  const rw = fnRet.writes.find((w) => w.k === 'var' && w.name === 'r');
  check('values flow through a function call and its return', describe(fnRet, rw.deps[0]).text === 'v = 21' && describe(fnRet, origins(fnRet, rw.id).leaves[0]).text === 'base = 21');

  const loop = run('let s = 0\nfor i in range(4) { s += i }\nprint(s)');
    const vals = history(loop, 0, 's').map((id) => loop.writes[id].new.v);
  check('the history of a variable lists every value it took', JSON.stringify(vals) === '[0,0,1,3,6]', JSON.stringify(vals));
}

// 5. Debugger moves.
{
  const fib = run(EXAMPLES.find((e) => e.id === 'fib').code);
  const printStep = fib.steps.findIndex((s) => s.span && s.span.start.line === 9);
  const over = move(fib, printStep, 'over');
  check('step over a recursive call goes straight to the next statement', fib.steps[over].kind === 'end', `from ${printStep} to ${over} of ${fib.steps.length - 1}`);
  const deep = fib.steps.reduce((best, s, i) => (s.depth > fib.steps[best].depth ? i : best), 0);
  const out1 = move(fib, deep, 'out');
  const back1 = move(fib, deep, 'out-back');
  check('step out and back out leave the current call in each direction', fib.steps[out1].depth < fib.steps[deep].depth && fib.steps[back1].depth < fib.steps[deep].depth && back1 < deep && out1 > deep);
  const avg = run(EXAMPLES.find((e) => e.id === 'average').code);
  const bp = new Set([7]);
  const hits = [];
  for (let t = move(avg, 0, 'continue', bp); avg.steps[t].kind !== 'end'; t = move(avg, t, 'continue', bp)) hits.push(t);
  check('continuing from breakpoint to breakpoint visits each run of the line', hits.length === 4 && hits.every((t) => avg.steps[t].span.start.line === 7), `${hits.length} hits`);
  const back = move(avg, hits[3], 'continue-back', bp);
  check('continuing backwards finds the previous hit', back === hits[2]);
  check('next and previous run of a line', nextRun(avg, hits[1], 7, 1) === hits[2] && nextRun(avg, hits[1], 7, -1) === hits[0]);
  check('line run counts', lineCounts(avg).get(7) === 4 && lineCounts(avg).get(6) === 5);
}

// 6. Speed.
{
  const s = Date.now();
  const t = run(EXAMPLES.find((e) => e.id === 'search').code);
  const ran = Date.now() - s;
  const c = new Cursor(t);
  const s2 = Date.now();
  c.seek(0);
  c.seek(t.steps.length - 1);
  c.seek(t.steps.length >> 1);
  const travelled = Date.now() - s2;
  check('100,000 steps record in well under two seconds, and the whole history replays fast', ran < 2000 && travelled < 1000, `run ${ran} ms, ${t.writes.length.toLocaleString('en')} writes; full rewind and replay ${travelled} ms`);
  check('numbers print cleanly', format(0.1 + 0.2, null) === '0.3' && format(1 / 3, null) === '0.333333333333' && format(-0, null) === '0');
}

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
