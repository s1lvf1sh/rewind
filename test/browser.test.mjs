// Drives the real page in headless Firefox over WebDriver BiDi (built into Firefox,
// spoken here with Node's own WebSocket): real clicks and key presses.
// Needs Firefox on the PATH. Run with `npm run test:browser`.
// Set SHOTS=dir to also save screenshots.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8198;
const BIDI = 9338;
const SHOTS = process.env.SHOTS;
const profile = mkdtempSync(join(tmpdir(), 'rewind-ff-'));
const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const firefox = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${BIDI}`], { stdio: 'ignore' });
process.on('exit', () => {
  firefox.kill();
  server.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 40 && !ws; i++) {
  await sleep(250);
  try {
    const s = new WebSocket(`ws://127.0.0.1:${BIDI}/session`);
    await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
    ws = s;
  } catch {}
}
if (!ws) { console.log('FAIL  could not reach Firefox over WebDriver BiDi'); process.exit(1); }

let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.type === 'error' ? rej(new Error(`${m.error}: ${m.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
await send('session.new', { capabilities: {} });
const { context } = await send('browsingContext.create', { type: 'tab' });
await send('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 } });
const js = async (expression) => {
  const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
  if (r.type === 'exception') throw new Error(`page script failed: ${r.exceptionDetails?.text} in ${expression.slice(0, 80)}`);
  return r.result.value;
};
process.on('uncaughtException', (e) => {
  console.log(results.join('\n'));
  console.log(`FAIL  ${e.message}`);
  process.exit(1);
});
const click = (x, y) => send('input.performActions', { context, actions: [{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
const key = (k, shift = false) => send('input.performActions', { context, actions: [{ type: 'key', id: 'k', actions: [...(shift ? [{ type: 'keyDown', value: '\uE008' }] : []), { type: 'keyDown', value: k }, { type: 'keyUp', value: k }, ...(shift ? [{ type: 'keyUp', value: '\uE008' }] : [])] }] });
const clickOn = async (sel) => {
  const [x, y] = JSON.parse(await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify([r.x + Math.min(r.width / 2, 40), r.y + r.height / 2]); })()`));
  await click(x, y);
  await sleep(150);
};
const shot = async (name) => {
  if (!SHOTS) return;
  await js('window.scrollTo(0, 0)');
  const { data } = await send('browsingContext.captureScreenshot', { context });
  writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
};
const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
const where = () => js(`document.getElementById('where').textContent`);

await send('browsingContext.navigate', { context, url: `http://localhost:${PORT}/#ex=average`, wait: 'complete' });
await sleep(500);
ok('the first example runs to the end', (await where()).includes('finished'), await where());
ok('its wrong answer is printed', (await js(`document.getElementById('output').textContent`)).includes('62.4'));

// Why was 62.4 printed? Its origins should be exactly the first four scores.
await clickOn('#output .out');
const origins = await js(`[...document.querySelectorAll('#why .wrow.origin .txt')].map((e) => e.textContent).join(' | ')`);
ok('asking why the average was printed traces it to the scores that were added', /item 0 = 72/.test(origins) && /item 3 = 91/.test(origins) && !/= 78/.test(origins), origins);
await shot('why-average.png');

// Step backwards with the keyboard, then forwards again.
const before = await where();
await key('\uE012'); // ArrowLeft
await key('\uE012');
const back = await where();
await key('\uE014'); // ArrowRight
ok('arrow keys step backward and forward', before !== back && (await where()) !== back, `${back}`);

// Go to the write that produced the selected value.
await clickOn('#vars .var .item');
const wrote = await js(`document.querySelector('#why .why-meta').textContent.match(/step (\\d+)/)[1]`);
await clickOn('#why-go');
ok('"Go there" moves to just after the step that wrote the value', Number(await js(`document.getElementById('slider').value`)) === Number(wrote) + 1, `wrote at step ${wrote}; ${await where()}`);

// A breakpoint on line 7, then continue from the start.
await key('\uE011'); // Home
await clickOn('.line[data-line="7"] .no');
await clickOn('[data-move="continue"]');
const at1 = await where();
await clickOn('[data-move="continue"]');
const total = await js(`[...document.querySelectorAll('#vars .var')].find((v) => v.querySelector('.name').textContent === 'total')?.querySelector('.val').textContent`);
ok('a breakpoint stops on its line, and continuing reaches it again', /line 7/.test(at1) && total === '72', `${at1}; total = ${total}`);
await clickOn('[data-move="continue-back"]');
ok('continuing backwards returns to the previous hit', /line 7/.test(await where()));
ok('inside a call, the stack shows the function and its argument', (await js(`document.querySelector('#vars .frame-head').textContent`)).startsWith('average(xs = […])'));
await clickOn('[data-move="out"]');
ok('step out returns to the caller', /top level/.test(await where()), await where());

// The crash example starts at the moment of the error.
await send('browsingContext.navigate', { context, url: `http://localhost:${PORT}/#ex=reverse`, wait: 'complete' });
await sleep(400);
const err = await js(`document.getElementById('error').textContent`);
const vars = await js(`[...document.querySelectorAll('#vars .var')].map((v) => v.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
ok('a crash is shown with the variables at that moment', /out of range/.test(err) && /\bj\s*5\b/.test(vars) && /\bi\s*0\b/.test(vars), `${err.trim()} — ${vars}`);
await shot('crash.png');

// Recursion: step over and the call skyline.
await send('browsingContext.navigate', { context, url: `http://localhost:${PORT}/#ex=fib`, wait: 'complete' });
await sleep(400);
await key('\uE011');
await key('\uE014');
await key('\uE014', true);
const before9 = await where();
await key('\uE014', true);
ok('step over runs the whole recursive call in one move', /line 9/.test(before9) && /finished/.test(await where()), `${before9} → ${await where()}`);
await clickOn('#output .out');
const fibOrigins = await js(`[...document.querySelectorAll('#why .wrow.origin .txt')].map((e) => e.textContent).join(' | ')`);
const fibReached = await js(`document.querySelector('#why').textContent.match(/(\\d+) steps of history/)[1]`);
ok('fib(8) = 21 traces back through every call to its single origin, the 8', /^n = 8/.test(fibOrigins) && !fibOrigins.includes('|') && Number(fibReached) > 50, `${fibOrigins}; ${fibReached} writes of history`);

// Edit a program, run it, and share it by link.
await clickOn('#edit');
await js(`document.getElementById('editor').value = 'let a = [3, 1, 2]\\nlet s = 0\\nfor x in a { s += x * x }\\nprint(s)\\n'`);
await clickOn('#run');
ok('an edited program runs', (await js(`document.getElementById('output').textContent`)).includes('14'));
ok('the edited program is saved in the link', (await js('location.hash')).startsWith('#code='));
const link = await js('location.href');
await send('browsingContext.navigate', { context, url: link, wait: 'complete' });
await sleep(400);
ok('opening the link reruns the same program', (await js(`document.getElementById('output').textContent`)).includes('14'));

// The infinite loop is stopped and can be scrubbed.
await send('browsingContext.navigate', { context, url: `http://localhost:${PORT}/#ex=search`, wait: 'complete' });
await sleep(1200);
ok('an infinite loop is stopped, and its history is still there', /Stopped after/.test(await js(`document.getElementById('error').textContent`)) && /of 100,000/.test(await where()));
await shot('search.png');

console.log(results.join('\n'));
await send('session.end').catch(() => {});
ws.close();
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} check(s) failed` : 'All browser checks passed'}`);
process.exit(failed ? 1 : 0);
