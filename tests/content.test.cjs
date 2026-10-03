const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
require('../extension/core.js');
const core = globalThis.ChofuJev;

function harness(calibrationDelays = [400, 400, 400]) {
  let calibrationNumber = 0;
  let now = 0, timerId = 0, rafId = 0, messageListener, nextSession = 0;
  const timeouts = new Map(), rafs = new Map(), pending = new Map(), messages = [];
  const counters = { resets: 0, flaps: [], scans: 0 };
  const el = () => ({ textContent: '', disabled: false, addEventListener() {} });
  const controls = Object.fromEntries(['message', 'stats', 'start', 'stop'].map(id => [id, el()]));
  const shadow = { innerHTML: '', getElementById: id => controls[id] };
  const stage = { isConnected: true, clientHeight: 360, scrollIntoView() {}, focus() {}, getBoundingClientRect: () => ({ width: 672, height: 360, top: 100, bottom: 460 }), dispatchEvent() { counters.flaps.push(now); } };
  const canvas = { isConnected: true, width: 672, height: 360, getContext: () => ({ getImageData() { counters.scans++; return {}; } }) };
  const game = { before() {}, querySelector: selector => ({ '[data-stage]': stage, '[data-canvas]': canvas, '[data-score]': { textContent: '0' }, '[data-panel="over"]': { hidden: true }, '[data-action="restart"]': { click() { counters.resets++; } } })[selector] };
  const prefs = { model: 'qa', endpoint: 'https://api.typesafe.ai/v1/systemone', maxRequests: 1000, requestIntervalMs: 100, autoRestart: false };
  function timeout(callback, ms) { const id = ++timerId; timeouts.set(id, { callback, at: now + ms }); return id; }
  const context = vm.createContext({
    console, innerHeight: 900, performance: { now: () => now }, crypto: { randomUUID },
    PointerEvent: class {}, setTimeout: timeout, clearTimeout: id => timeouts.delete(id),
    requestAnimationFrame: callback => { const id = ++rafId; rafs.set(id, callback); return id; }, cancelAnimationFrame: id => rafs.delete(id),
    localStorage: { getItem() { return null; }, setItem() {} }, window: { addEventListener() {} },
    document: { hidden: false, querySelector: () => game, getElementById: () => null, createElement: () => ({ attachShadow: () => shadow }), addEventListener() {} },
    ChofuJev: { ...core, observe: () => ({ width: 672, height: 360, scale: 1, player: { x: 163, y: 180, radius: 13 }, obstacles: [] }) },
    chrome: { runtime: { onMessage: { addListener(listener) { messageListener = listener; } }, sendMessage(message) {
      messages.push(message);
      if (message.type === 'run:begin') return Promise.resolve({ ok: true, id: `run-${++nextSession}`, config: prefs });
      if (message.type === 'run:stop') {
        for (const [id, item] of pending) if (item.session === message.id) { timeouts.delete(id); item.reject(Error('cancelled')); pending.delete(id); }
        return Promise.resolve({ ok: true });
      }
      const calibration = message.predicted_latency === 0;
      const delay = calibration ? calibrationDelays[calibrationNumber++ % calibrationDelays.length] : 10;
      return new Promise((resolve, reject) => {
        const id = timeout(() => { pending.delete(id); resolve({ ok: true, action: 'FLAP', latencyMs: delay }); }, delay);
        pending.set(id, { session: message.id, reject });
      });
    } } }
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../extension/content.js'), 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function advance(to) {
    while (true) {
      const due = [...timeouts.entries()].filter(([, item]) => item.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timeouts.delete(due[0]); due[1].callback(); await flush();
    }
    now = to; await flush();
  }
  async function frame(at) { await advance(at); const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback(at)); await flush(); }
  const send = type => new Promise(resolve => { messageListener({ type }, {}, resolve); });
  async function start() { const promise = send('ui:start'); await flush(); await advance(now + calibrationDelays.reduce((a,b) => a+b, 0)); assert.equal((await promise).ok, true); }
  return { start, send, advance, frame, flush, counters, messages, controls, get now() { return now; } };
}

test('startup measures three real round trips before the standard reset and ignores calibration choices', async () => {
  const h = harness(), start = h.send('ui:start');
  await h.flush(); await h.advance(1199);
  assert.equal(h.counters.resets, 0);
  assert.equal(h.counters.flaps.length, 0);
  await h.advance(1200); assert.equal((await start).ok, true);
  assert.equal(h.counters.resets, 1);
  assert.equal(h.messages.filter(m => m.type === 'decide:reflex').length, 3);
  await h.frame(1216); await h.frame(1300);
  const sent = h.messages.filter(m => m.type === 'decide:reflex').at(-1);
  assert.equal(sent.predicted_latency, 400);
});

test('an early Jev FLAP executes at its target between render frames, with no extra local clicks', async () => {
  const h = harness(); await h.start(); await h.frame(1216); await h.frame(1300); await h.advance(1310);
  assert.equal(h.counters.flaps.length, 0);
  await h.advance(1699); assert.equal(h.counters.flaps.length, 0);
  await h.advance(1700); assert.deepEqual(h.counters.flaps, [1700]);
  await h.advance(1800); assert.deepEqual(h.counters.flaps, [1700]);
});

test('stop cancels both a queued future FLAP and a startup calibration without stopping a new run', async () => {
  const h = harness(); await h.start(); await h.frame(1216); await h.frame(1300); await h.advance(1310);
  await h.send('ui:stop'); await h.advance(1800); assert.equal(h.counters.flaps.length, 0);
  const cancelled = h.send('ui:start'); await h.flush(); await h.advance(1900); await h.send('ui:stop');
  const restarted = h.send('ui:start'); await h.flush(); await h.advance(3100);
  assert.equal((await cancelled).ok, false); assert.equal((await restarted).ok, true);
  assert.equal((await h.send('ui:status')).running, true);
});

test('between requests, physics frames continue while expensive pixel scans are skipped', async () => {
  const h = harness(); await h.start(); const scans = h.counters.scans;
  for (const at of [1216, 1232, 1248, 1264, 1280, 1296]) await h.frame(at);
  assert.equal(h.counters.scans - scans, 1);
  await h.frame(1312); assert.equal(h.counters.scans - scans, 2);
});


test('one calibration spike cannot push the action target hundreds of milliseconds beyond the typical connection', async () => {
  const h = harness([300, 760, 400]); await h.start();
  await h.frame(1476); await h.frame(1560);
  const sent = h.messages.filter(m => m.type === 'decide:reflex').at(-1);
  assert.equal(sent.predicted_latency, 500);
});
