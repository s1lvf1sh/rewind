import { run, format } from './interp.js';
import { Cursor } from './state.js';
import { describe, origins, history } from './why.js';
import { move, nextRun, lineCounts, lineAt } from './nav.js';
import { EXAMPLES } from './examples.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const ui = {
  src: '',
  example: null,
  trace: null,
  cursor: null,
  t: 0,
  sel: null, // selected write id
  trail: [],
  breakpoints: new Set(),
  editing: false,
  counts: new Map(),
};

// --- running ---

function load(src, exampleId = null) {
  ui.src = src;
  ui.example = exampleId;
  ui.breakpoints.clear();
  const ex = EXAMPLES.find((e) => e.id === exampleId);
  $('hint').textContent = ex ? ex.hint : '';
  $('example').value = exampleId ?? '';
  execute();
}

function execute() {
  ui.trace = run(ui.src);
  ui.cursor = ui.trace.ast ? new Cursor(ui.trace) : null;
  ui.counts = lineCounts(ui.trace);
  ui.sel = null;
  ui.trail = [];
  ui.t = Math.max(0, ui.trace.steps.length - 1);
  setEditing(false);
  writeHash();
  render();
}

function writeHash() {
  if (ui.example) history_replace(`#ex=${ui.example}`);
  else history_replace(`#code=${encode(ui.src)}`);
}
function history_replace(h) {
  try {
    window.history.replaceState(null, '', h);
  } catch {}
}
const encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function setEditing(on) {
  ui.editing = on;
  $('editor-wrap').hidden = !on;
  $('code-view').hidden = on;
  $('edit').disabled = on;
  document.querySelector('.timeline').style.opacity = on ? 0.45 : 1;
  if (on) {
    $('editor').value = ui.src;
    syncGutter();
    $('editor').focus();
  }
}

function syncGutter() {
  const n = $('editor').value.split('\n').length;
  $('editor-gutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  $('editor-gutter').scrollTop = $('editor').scrollTop;
}

function seek(t) {
  if (!ui.cursor) return;
  ui.t = Math.max(0, Math.min(ui.trace.steps.length - 1, t));
  ui.cursor.seek(ui.t);
  render();
}

function select(id, { push = true } = {}) {
  if (id === null || id === undefined) return;
  if (push && ui.sel !== null && ui.sel !== id) ui.trail.push(ui.sel);
  ui.sel = id;
  render();
}

// --- rendering ---

function render() {
  renderError();
  renderCode();
  renderTimeline();
  renderVars();
  renderOutput();
  renderWhy();
}

function renderError() {
  const e = ui.trace.error;
  const el = $('error');
  el.hidden = !e;
  if (!e) return;
  el.className = `error ${e.kind}`;
  const where = e.span ? ` (line ${e.span.start.line})` : '';
  const label = e.kind === 'syntax' ? 'Syntax error' : e.kind === 'limit' ? 'Stopped' : 'Runtime error';
  el.innerHTML = `<b>${label}${where}:</b> ${esc(e.message)}${e.kind === 'syntax' ? ' <button id="fix">Edit</button>' : ''}`;
  $('fix')?.addEventListener('click', () => setEditing(true));
}

const KEYWORDS = /^(let|fn|if|else|while|for|in|return|break|continue|true|false|nil|and|or|not)\b/;
function highlight(text) {
  let out = '';
  let rest = text;
  let afterFn = false;
  while (rest.length) {
    let m;
    if ((m = rest.match(/^#.*/))) out += `<span class="com">${esc(m[0])}</span>`;
    else if ((m = rest.match(/^"(?:[^"\\]|\\.)*"?/))) out += `<span class="str">${esc(m[0])}</span>`;
    else if ((m = rest.match(/^\d+(\.\d+)?/))) out += `<span class="num">${m[0]}</span>`;
    else if ((m = rest.match(KEYWORDS))) {
      out += `<span class="kw">${m[0]}</span>`;
      afterFn = m[0] === 'fn';
      rest = rest.slice(m[0].length);
      continue;
    } else if ((m = rest.match(/^[A-Za-z_]\w*/))) out += afterFn ? `<span class="fnname">${m[0]}</span>` : esc(m[0]);
    else m = [rest[0]], (out += esc(rest[0]));
    if (!/^\s+$/.test(m[0])) afterFn = false;
    rest = rest.slice(m[0].length);
  }
  return out;
}

function depLines() {
  if (ui.sel === null) return new Set();
  const lines = new Set();
  const d = describe(ui.trace, ui.sel);
  if (d.line) lines.add(d.line);
  for (const id of d.deps) {
    const l = describe(ui.trace, id).line;
    if (l) lines.add(l);
  }
  return lines;
}

function renderCode() {
  if (ui.editing) return;
  const trace = ui.trace;
  const lines = ui.src.split('\n');
  const step = trace.steps[ui.t];
  const nowLine = step?.span?.start.line ?? (trace.error?.span?.start.line ?? null);
  const isError = step?.kind === 'error' || (!ui.cursor && trace.error);
  const span = step?.span ?? trace.error?.span;
  const deps = depLines();
  // What the step just taken wrote, shown beside its line.
  const notes = new Map();
  const prev = trace.steps[ui.t - 1];
  if (prev && prev.span) {
    const parts = [];
    for (let i = prev.from; i < prev.to; i++) {
      const w = trace.writes[i];
      if (w.k === 'var' && w.label !== 'function') parts.push(`${w.name} = ${shortValue(w.new.v)}`);
      else if (w.k === 'elem' && w.new !== undefined && w.target) parts.push(`${w.target}[${w.i}] = ${shortValue(w.new.v)}`);
      else if (w.k === 'out') parts.push(`printed`);
      else if (w.k === 'ret') parts.push(`${w.frame.name} returned ${shortValue(w.value)}`);
    }
    if (parts.length) notes.set(prev.span.start.line, parts.slice(-4).join(', '));
  }
  let html = '';
  lines.forEach((text, i) => {
    const n = i + 1;
    const cls = ['line'];
    if (n === nowLine) cls.push(isError ? 'error-line' : 'now');
    if (ui.breakpoints.has(n)) cls.push('breakpoint');
    if (deps.has(n) && n !== nowLine) cls.push('dep');
    let body;
    if (n === nowLine && span && span.start.line === n) {
      const a = span.start.col - 1;
      const b = span.end.line === n ? span.end.col - 1 : text.length;
      body = `${highlight(text.slice(0, a))}<mark>${highlight(text.slice(a, b))}</mark>${highlight(text.slice(b))}`;
    } else body = highlight(text);
    const count = ui.counts.get(n);
    const note = notes.get(n) ? `<span class="note">← ${esc(notes.get(n))}</span>` : '';
    const jumps = count ? `<span class="jumps"><button data-jump="-1" data-line="${n}" title="Previous time this line ran">◀ prev</button><button data-jump="1" data-line="${n}" title="Next time this line ran">next ▶</button></span>` : '';
    html += `<div class="${cls.join(' ')}" data-line="${n}"><span class="bp" title="Toggle breakpoint">●</span><span class="no">${n}</span><span class="count" title="Times this line ran: ${count ?? 0}">${count ? `${count >= 10000 ? `${Math.round(count / 1000)}k` : count}×` : ''}</span><span class="src">${body || ' '}${note}</span>${jumps}</div>`;
  });
  $('code-view').innerHTML = html;
  $('code-view').querySelector('.line.now, .line.error-line')?.scrollIntoView({ block: 'nearest' });
}

function shortValue(v) {
  if (v !== null && typeof v === 'object') return v.ref !== undefined ? format(v, ui.cursor.state) : `<fn ${v.name}>`;
  return format(v, null);
}

function renderTimeline() {
  const n = ui.trace.steps.length;
  const slider = $('slider');
  slider.max = Math.max(0, n - 1);
  slider.value = ui.t;
  slider.disabled = !ui.cursor;
  for (const b of document.querySelectorAll('[data-move]')) b.disabled = !ui.cursor;
  drawStrip();
  if (!ui.cursor) {
    $('where').innerHTML = 'The program did not run.';
    return;
  }
  const step = ui.trace.steps[ui.t];
  const frames = ui.cursor.state.frames;
  const fn = frames.length ? `in <b>${esc(frames[frames.length - 1].name)}</b>, ${frames.length} call${frames.length === 1 ? '' : 's'} deep` : 'at top level';
  const what = step.kind === 'end' ? 'the program has finished' : step.kind === 'error' ? 'the moment of the error' : step.kind === 'resume' ? `back in line ${lineAt(ui.trace, ui.t)} after a call returned` : `about to run line ${lineAt(ui.trace, ui.t)}`;
  $('where').innerHTML = `Step <b>${ui.t.toLocaleString('en')}</b> of ${(n - 1).toLocaleString('en')} · ${what} · ${fn}`;
}

function drawStrip() {
  const c = $('strip');
  const w = (c.width = c.clientWidth * devicePixelRatio || 600);
  const h = (c.height = 44 * devicePixelRatio);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const steps = ui.trace.steps;
  if (steps.length < 2) return;
  const maxDepth = Math.max(1, ...steps.map((s) => s.depth));
  const x = (i) => (i / (steps.length - 1)) * w;
  // Call depth over time, as a skyline: each column shows the deepest point it covers.
  g.fillStyle = '#2f4d73';
  const cols = Math.min(w, steps.length);
  for (let col = 0; col < cols; col++) {
    const a = Math.floor((col / cols) * steps.length);
    const b = Math.max(a + 1, Math.floor(((col + 1) / cols) * steps.length));
    let d = 0;
    for (let i = a; i < b; i++) d = Math.max(d, steps[i].depth);
    const bh = ((d + 1) / (maxDepth + 1)) * (h - 10);
    g.fillRect((col / cols) * w, h - bh, Math.ceil(w / cols), bh);
  }
  // Breakpoint hits.
  g.fillStyle = '#ff7a7a';
  if (ui.breakpoints.size) steps.forEach((s, i) => s.kind !== 'resume' && s.span && ui.breakpoints.has(s.span.start.line) && g.fillRect(x(i), 0, Math.max(1, devicePixelRatio), 7 * devicePixelRatio));
  if (ui.trace.error) g.fillRect(w - 3 * devicePixelRatio, 0, 3 * devicePixelRatio, h);
  // The selected value's write, and now.
  if (ui.sel !== null) {
    g.fillStyle = '#8fd18b';
    g.fillRect(x(ui.trace.writes[ui.sel].step) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
  }
  g.fillStyle = '#ffffff';
  g.fillRect(x(ui.t) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
}

function changedNow() {
  const set = new Set();
  const prev = ui.trace.steps[ui.t - 1];
  if (prev) for (let i = prev.from; i < prev.to; i++) set.add(i);
  return set;
}

function valueHtml(b, changed) {
  const v = b.v;
  if (v !== null && typeof v === 'object' && v.ref !== undefined) {
    const list = ui.cursor.state.heap.get(v.ref) || [];
    const items = list.map((ib, i) => {
      const cls = ['item'];
      if (changed.has(ib.w)) cls.push('changed');
      if (ib.w === ui.sel) cls.push('selected');
      const text = ib.v !== null && typeof ib.v === 'object' && ib.v.ref !== undefined ? format(ib.v, ui.cursor.state) : format(ib.v, null);
      return `<span class="${cls.join(' ')}" data-w="${ib.w}" title="Item ${i}">${esc(text)}</span>`;
    });
    return `[${items.join(',')}]`;
  }
  if (v !== null && typeof v === 'object') return `<span class="muted">fn ${esc(v.name)}</span>`;
  return esc(format(v, null));
}

function scopeRows(fromEnv, stopEnv, changed, shown) {
  const state = ui.cursor.state;
  let html = '';
  for (let e = fromEnv; e !== null && e !== undefined; e = state.envs.get(e)?.parent) {
    const env = state.envs.get(e);
    if (!env) break;
    for (const [name, b] of env.vars) {
      if (shown.has(name)) continue;
      shown.add(name);
      if (b.v !== null && typeof b.v === 'object' && b.v.fn !== undefined) continue;
      const cls = ['var'];
      if (changed.has(b.w)) cls.push('changed');
      if (b.w === ui.sel) cls.push('selected');
      html += `<div class="${cls.join(' ')}" data-w="${b.w}"><span class="name">${esc(name)}</span><span class="val">${valueHtml(b, changed)}</span></div>`;
    }
    if (e === stopEnv) break;
  }
  return html;
}

function renderVars() {
  const el = $('vars');
  if (!ui.cursor) {
    el.innerHTML = '<p class="muted">Nothing ran.</p>';
    return;
  }
  const { frames } = ui.cursor.state;
  const steps = ui.trace.steps;
  const changed = changedNow();
  let html = '';
  let envNow = steps[ui.t].env ?? 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const params = ui.trace.fns.find((d) => d.name === f.name)?.params ?? [];
    const args = params.map((p) => {
      const b = ui.cursor.state.envs.get(f.env)?.vars.get(p);
      return b ? `${p} = ${b.v !== null && typeof b.v === 'object' ? (b.v.ref !== undefined ? '[…]' : 'fn') : format(b.v, null)}` : p;
    });
    const rows = scopeRows(envNow, f.env, changed, new Set());
    html += `<div class="frame"><div class="frame-head">${esc(f.name)}(${esc(args.join(', '))}) <span class="scope">· line ${f.span.start.line}</span></div>${rows || '<div class="muted var">no variables yet</div>'}</div>`;
    envNow = steps[f.callStep]?.env ?? 0;
  }
  const rows = scopeRows(envNow, null, changed, new Set());
  html += `<div class="frame"><div class="frame-head">global</div>${rows || '<div class="muted var">no variables yet</div>'}</div>`;
  el.innerHTML = html;
}

function renderOutput() {
  const el = $('output');
  if (!ui.cursor) {
    el.innerHTML = '';
    return;
  }
  const out = ui.cursor.state.output;
  const changed = changedNow();
  el.innerHTML = out.length
    ? out.map((o) => `<div class="out${changed.has(o.w) ? ' latest' : ''}${o.w === ui.sel ? ' selected' : ''}" data-w="${o.w}">${esc(o.text) || '&nbsp;'}</div>`).join('')
    : '<span class="muted">Nothing printed yet.</span>';
  el.scrollTop = el.scrollHeight;
}

function row(id, extra = '') {
  const d = describe(ui.trace, id);
  return `<div class="wrow ${extra}${d.origin ? ' origin' : ''}" data-w="${id}"><span class="txt">${esc(d.text)}${d.note ? ` <span class="muted">(${esc(d.note)})</span>` : ''}</span><span class="at">line ${d.line ?? '?'} · step ${d.step}</span></div>`;
}

function renderWhy() {
  const el = $('why');
  if (ui.sel === null || !ui.cursor) {
    el.innerHTML = '<p class="muted">Click any variable, list item or line of output to see where its value came from.</p>';
    return;
  }
  const trace = ui.trace;
  const d = describe(trace, ui.sel);
  const w = trace.writes[ui.sel];
  let html = '';
  if (ui.trail.length) html += `<div class="trail"><button id="why-back">← back</button></div>`;
  html += `<div class="why-head">${esc(d.text)}</div>`;
  html += `<div class="why-meta">Written at step ${d.step}, line ${d.line ?? '?'}: <code>${esc(d.code)}</code> <button id="why-go">Go there</button></div>`;
  if (d.origin) html += `<div class="muted">${d.k === 'out' ? 'Printed from constants only.' : 'This value came straight from the program text; nothing earlier flowed into it.'}</div>`;
  if (d.deps.length) html += `<div class="why-section">Computed from</div>${d.deps.map((id) => row(id)).join('')}`;
  if (d.idx.length) html += `<div class="why-section">Position chosen by</div>${d.idx.slice(0, 8).map((id) => row(id, 'dim')).join('')}`;
  if (d.ctl.length) html += `<div class="why-section">Only happened because of</div>${d.ctl.slice(0, 6).map((id) => row(id, 'dim')).join('')}${d.ctl.length > 6 ? `<div class="muted">…and ${d.ctl.length - 6} more</div>` : ''}`;
  if (d.deps.length) {
    const o = origins(trace, ui.sel);
    html += `<div class="why-section">Ultimately made from (${o.leaves.length} origin${o.leaves.length === 1 ? '' : 's'}, ${o.reached} steps of history)</div>`;
    html += o.leaves.slice(0, 40).map((id) => row(id)).join('');
    if (o.leaves.length > 40) html += `<div class="muted">…and ${o.leaves.length - 40} more</div>`;
  }
  if (w.k === 'var') {
    const h = history(trace, w.env, w.name);
    if (h.length > 1) {
      html += `<div class="why-section">Every value of ${esc(w.name)} (${h.length})</div><div class="history">${h
        .slice(0, 300)
        .map((id) => `<span data-w="${id}" class="${id === ui.sel ? 'cur' : ''}">${esc(shortValue(trace.writes[id].new.v))}</span>`)
        .join(' → ')}</div>`;
    }
  }
  el.innerHTML = html;
  $('why-back')?.addEventListener('click', () => select(ui.trail.pop(), { push: false }));
  $('why-go').addEventListener('click', () => seek(w.step + 1));
}

// --- wiring ---

for (const ex of EXAMPLES) $('example').insertAdjacentHTML('beforeend', `<option value="${ex.id}">${esc(ex.title)}</option>`);
$('example').insertAdjacentHTML('beforeend', '<option value="">(your own program)</option>');
$('example').addEventListener('change', (e) => {
  const ex = EXAMPLES.find((x) => x.id === e.target.value);
  if (ex) load(ex.code, ex.id);
});
$('run').addEventListener('click', () => {
  if (ui.editing) {
    const src = $('editor').value;
    if (src !== ui.src) ui.example = null;
    ui.src = src;
    if (!ui.example) {
      $('hint').textContent = '';
      $('example').value = '';
    }
  }
  execute();
});
$('edit').addEventListener('click', () => setEditing(true));
$('editor').addEventListener('input', syncGutter);
$('editor').addEventListener('scroll', syncGutter);
$('editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target;
    const s = t.selectionStart;
    t.setRangeText('  ', s, t.selectionEnd, 'end');
    syncGutter();
  }
});
document.querySelector('.transport').addEventListener('click', (e) => {
  const b = e.target.closest('[data-move]');
  if (b && ui.cursor) seek(move(ui.trace, ui.t, b.dataset.move, ui.breakpoints));
});
$('slider').addEventListener('input', (e) => seek(Number(e.target.value)));
$('strip').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  seek(Math.round(((e.clientX - r.left) / r.width) * (ui.trace.steps.length - 1)));
});
$('code-view').addEventListener('click', (e) => {
  const line = e.target.closest('.line');
  if (!line) return;
  const n = Number(line.dataset.line);
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    const t = nextRun(ui.trace, ui.t, n, Number(jump.dataset.jump));
    if (t >= 0) seek(t);
    return;
  }
  if (e.target.closest('.bp, .no')) {
    if (ui.breakpoints.has(n)) ui.breakpoints.delete(n);
    else ui.breakpoints.add(n);
    render();
  }
});
for (const id of ['vars', 'output', 'why']) {
  $(id).addEventListener('click', (e) => {
    const t = e.target.closest('[data-w]');
    if (t && !e.target.closest('button')) select(Number(t.dataset.w));
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    $('run').click();
    return;
  }
  if (ui.editing || e.target.closest('input, select, textarea') || !ui.cursor) return;
  const moves = { ArrowRight: e.shiftKey ? 'over' : 'forward', ArrowLeft: e.shiftKey ? 'over-back' : 'back', Home: 'start', End: 'end' };
  if (moves[e.key]) {
    e.preventDefault();
    seek(move(ui.trace, ui.t, moves[e.key], ui.breakpoints));
  }
});
window.addEventListener('resize', drawStrip);

// Start from the link if there is one, otherwise the first bug hunt. Links can
// name an example (#ex=sort) or carry a whole program (#code=…), plus t= and sel=.
function fromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const ex = EXAMPLES.find((x) => x.id === h.get('ex'));
  let code = null;
  try {
    if (h.get('code')) code = decode(h.get('code'));
  } catch {}
  if (code !== null) load(code, null);
  else load((ex ?? EXAMPLES[0]).code, (ex ?? EXAMPLES[0]).id);
  if (h.has('t')) seek(Number(h.get('t')));
  if (h.has('sel')) select(Number(h.get('sel')));
}
window.addEventListener('hashchange', fromHash);
fromHash();
