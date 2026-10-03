const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..', 'extension');

function harness(existing) {
  const stores = existing ?? { local: {}, session: {} };
  const storage = kind => ({
    async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); },
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: stores[kind][keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, stores[kind][k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [k, stores[kind][k] ?? fallback]));
    },
    async set(values) { Object.assign(stores[kind], values); }
  });
  const context = vm.createContext({
    console, URL, performance, crypto: { randomUUID }, AbortController, Response, DOMException, TextEncoder,
    setTimeout, clearTimeout,
    chrome: {
      storage: { local: storage('local'), session: storage('session') },
      permissions: { async contains() { return true; } },
      runtime: { id: 'qa-extension', getURL: p => `chrome-extension://qa-extension/${p}`, onMessage: { addListener() {} } },
      tabs: { sendMessage: async () => ({}), onRemoved: { addListener() {} } }
    }
  });
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { context, handle: vm.runInContext('handle', context), stores };
}

const popup = { id: 'qa-extension', url: 'chrome-extension://qa-extension/popup.html' };
const game = { id: 'qa-extension', url: 'https://www.chofusai.jp/map/', tab: { id: 42 }, frameId: 0 };
const prefs = { mode: 'jev-reflex-guided', model: 'jev-latest', maxRequests: 20, autoRestart: false, requestIntervalMs: 50 };

function request(run, index = 0, changes = {}) {
  const sentAt = 100 + index * 50;
  const observationTime = sentAt - 2;
  const predictedLatency = 180;
  const targetTime = sentAt + predictedLatency;
  const state = {
    protocol: 'jev-reflex-guided-v1',
    screen: { height: 360, wallTop: 0, wallBottom: 360 },
    player: { x: 90, y: 180, velocityY: 35, radius: 13 },
    game: { score: 2 },
    next_obstacle: { x: 300, horizontal_distance: 210, width: 30, gapTop: 100, gapBottom: 260, type: 'gold', score_value: 3 },
    following_obstacle: null,
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165, max_frame_step_ms: 50, obstacle_radius_factor: 0.9 },
    timing: {
      observation_time: observationTime, target_time: targetTime, predicted_latency: predictedLatency,
      request_interval_ms: 50, next_nominal_target_time: targetTime + 50,
      flap_epoch: 2, last_flap_time: 20, since_last_flap_ms: targetTime - 20,
      unit: 'ms_since_run_start'
    },
    observations: { vertical_motion: 'falling', relative_to_next_gap: 'inside_gap', screen_half: 'upper_half' }
  };
  return {
    type: 'decide:reflex', id: run.id, request_id: `qa-${index}`,
    sent_at: sentAt, observation_time: observationTime, target_time: targetTime,
    predicted_latency: predictedLatency, flap_epoch: 2,
    state: { ...state, timing: { ...state.timing, ...changes.timing } }, ...(changes.message ?? {})
  };
}

const waitResult = model => ({ model, answers: { action: { type: 'choice', choice: 'WAIT', confidence: 0.8, probabilities: { FLAP: 0.2, WAIT: 0.8 } } } });

test('only the extension popup can save or read API-key settings', async () => {
  const { handle, stores } = harness();
  await assert.rejects(handle({ type: 'config:save', config: prefs, apiKey: 'fake-key' }, game), /専用/);
  await assert.rejects(handle({ type: 'config:get' }, { ...popup, id: 'other-extension' }), /専用/);
  await assert.rejects(handle({ type: 'run:begin' }, game), /APIキー/);
  const saved = await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  assert.equal(saved.config.hasKey, true);
  assert.equal(saved.config.apiKey, undefined);
  assert.equal(saved.config.apiKeys, undefined);
  assert.equal(stores.local.apiKeys['https://api.typesafe.ai/v1/systemone'], 'fake-test-key');
  assert.equal(stores.session.apiKey, undefined);
  await assert.rejects(handle({ type: 'run:begin' }, { ...game, url: 'https://example.com/map/' }), /専用/);
  await assert.rejects(handle({ type: 'run:begin' }, { ...game, frameId: 2 }), /専用/);
});

test('reflex requests preserve target timing and send observed physics and guided criteria', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: { ...prefs, maxRequests: 1 }, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let calls = 0;
  context.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state.protocol, 'jev-reflex-guided-v1');
    assert.equal(body.state.timing.observation_time, 98);
    assert.equal(body.state.timing.target_time, 280);
    assert.equal(body.state.timing.predicted_latency, 180);
    assert.equal(body.state.timing.flap_epoch, 2);
    assert.equal(body.state.timing.next_nominal_target_time, 330);
    assert.equal(body.state.player.velocityY, 35);
    assert.equal(body.state.next_obstacle.score_value, 3);
    assert.equal(body.state.physics.obstacle_radius_factor, 0.9);
    assert.deepEqual(Object.keys(body.questions.action.criteria), ['FLAP', 'WAIT']);
    assert.equal(typeof body.questions.action.criteria.FLAP, 'string');
    assert.equal(typeof body.questions.action.criteria.WAIT, 'string');
    assert.equal(body.state.goal.target_score, 100);
    return new Response(JSON.stringify(waitResult('jev-1.13.0')), { status: 200 });
  };
  const answer = await handle(request(run), game);
  assert.equal(answer.ok, true);
  assert.equal(answer.action, 'WAIT');
  assert.equal(answer.model, 'jev-1.13.0');
  assert.equal(answer.requests, 1);
  await assert.rejects(handle(request(run, 1), game), /上限/);
  assert.equal(calls, 1);
});

test('background rejects mismatched state epochs and invalid target times before fetch', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let calls = 0;
  context.fetch = async () => { calls++; return new Response(JSON.stringify(waitResult('jev-1.13.0')), { status: 200 }); };
  const mismatchedEpoch = request(run, 0, { timing: { flap_epoch: 1 } });
  await assert.rejects(handle(mismatchedEpoch, game), /時刻が一致/);
  await assert.rejects(handle(request(run, 1, { message: { target_time: 100 } }), game), /時刻が不正/);
  assert.equal(calls, 0);
});

test('up to twelve independent reflex fetches may be in flight, then the thirteenth is skipped by the worker', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: { ...prefs, maxRequests: 20 }, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  const resolvers = [];
  let started = 0;
  let notifyStarted;
  const allStarted = new Promise(resolve => { notifyStarted = resolve; });
  context.fetch = async () => {
    started++;
    if (started === 12) notifyStarted();
    return new Promise(resolve => resolvers.push(resolve));
  };
  const pending = Array.from({ length: 12 }, (_, i) => handle(request(run, i), game));
  await allStarted;
  await assert.rejects(handle(request(run, 12), game), /同時リクエスト上限/);
  assert.equal(started, 12);
  for (const resolve of resolvers) resolve(new Response(JSON.stringify(waitResult('jev-1.13.0')), { status: 200 }));
  const answers = await Promise.all(pending);
  assert.equal(answers.length, 12);
  assert.ok(answers.every(answer => answer.ok && answer.action === 'WAIT'));
});

test('stop aborts every in-flight reflex request and invalidates the session', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  context.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    notifyStarted();
  });
  const pending = handle(request(run), game);
  const check = assert.rejects(pending, /キャンセル/);
  await started;
  await handle({ type: 'run:stop', id: run.id }, game);
  await check;
  await assert.rejects(handle(request(run), game), /セッションが終了/);
});

test('invalid Jev choices and HTTP errors are classified without exposing response bodies', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  let run = await handle({ type: 'run:begin' }, game);
  context.fetch = async () => new Response('private-server-message', { status: 401 });
  await assert.rejects(handle(request(run), game), /APIキーが無効/);
  run = await handle({ type: 'run:begin' }, game);
  context.fetch = async () => new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: 'click', confidence: 0.9 } } }), { status: 200 });
  await assert.rejects(handle(request(run), game), /Jev reflex response is invalid/);
});

test('endpoint keys stay separate and changing the model invalidates its active session', async () => {
  const { context, handle, stores } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-typesafe-key' }, popup);
  const first = await handle({ type: 'run:begin' }, game);
  const local = { ...prefs, endpoint: 'http://127.0.0.1:8009/v1/systemone', model: 'kev-latest' };
  const saved = await handle({ type: 'config:save', config: local }, popup);
  assert.equal(saved.config.hasKey, false);
  assert.equal(stores.local.apiKeys['https://api.typesafe.ai/v1/systemone'], 'fake-typesafe-key');
  await assert.rejects(handle(request(first), game), /セッションが終了/);
  const run = await handle({ type: 'run:begin' }, game);
  context.fetch = async (url, options) => {
    assert.equal(url, local.endpoint);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).model, 'kev-latest');
    return new Response(JSON.stringify(waitResult('kev-4b')), { status: 200 });
  };
  const answer = await handle(request(run), game);
  assert.equal(answer.model, 'kev-4b');
  assert.equal(answer.action, 'WAIT');
});

test('custom endpoints require permission and reject credential-bearing or remote HTTP URLs', async () => {
  const { context, handle } = harness();
  for (const endpoint of ['http://example.com/v1/systemone', 'https://user:password@example.com/api', 'https://example.com/api?key=secret']) {
    await assert.rejects(handle({ type: 'config:save', config: { ...prefs, endpoint } }, popup));
  }
  context.chrome.permissions.contains = async () => false;
  await assert.rejects(handle({ type: 'config:save', config: { ...prefs, endpoint: 'https://example.com/v1/systemone' } }, popup), /許可/);
});

test('request interval defaults to 150ms, persists valid values and rejects invalid values', async () => {
  const { context, handle, stores } = harness();
  assert.equal((await handle({ type: 'config:get' }, popup)).config.requestIntervalMs, 150);
  for (const requestIntervalMs of [50, 150, 500]) {
    const saved = await handle({ type: 'config:save', config: { ...prefs, requestIntervalMs }, apiKey: 'fake-test-key' }, popup);
    assert.equal(saved.config.requestIntervalMs, requestIntervalMs);
    assert.equal(stores.local.requestIntervalMs, requestIntervalMs);
  }
  for (const requestIntervalMs of [49, 501, 150.5, '150', NaN]) {
    await assert.rejects(handle({ type: 'config:save', config: { ...prefs, requestIntervalMs } }, popup), /要求間隔/);
  }
  const run = await handle({ type: 'run:begin' }, game);
  context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.state.timing.request_interval_ms, 500);
    assert.equal(body.state.timing.next_nominal_target_time, 780);
    return new Response(JSON.stringify(waitResult('jev-1.13.0')), { status: 200 });
  };
  await handle(request(run), game);
});
