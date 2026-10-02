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
      tabs: { onRemoved: { addListener() {} } }
    }
  });
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { context, handle: vm.runInContext('handle', context), stores };
}
const popup = { id: 'qa-extension', url: 'chrome-extension://qa-extension/popup.html' };
const game = { id: 'qa-extension', url: 'https://www.chofusai.jp/map/', tab: { id: 42 }, frameId: 0 };
const prefs = { mode: 'jev', model: 'jev-latest', maxRequests: 1, autoRestart: false };
const state = {
  screen: { width: 672, height: 360 }, player: { x: 163, y: 180, radius: 13, velocityY: 25 },
  physics: { gravity: 1500, flapVelocity: -430, speedX: 165 },
  next: { x: 600, width: 30, gapTop: 100, gapBottom: 265 }, following: null,
  since_last_click_ms: 320, decision_horizon_ms: 250,
  predicted_at_response: { player_y: 233, player_velocity_y: 400, next: { x: 559, width: 30, gapTop: 100, gapBottom: 265 }, following: null },
  pageText: 'This page property must never be sent to the API.'
};
const result = { model: 'jev-test', answers: { action: { type: 'choice', choice: 'click', confidence: 0.9 } } };
test('only extension popup can save/read config; game cannot retrieve the key', async () => {
  const { handle, stores } = harness();
  await assert.rejects(handle({ type: 'config:save', config: prefs, apiKey: 'fake' }, game), /専用/);
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
test('API request matches official contract and drops page properties; budget is enforced', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let calls = 0;
  context.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.action.type, 'choice');
    assert.deepEqual(body.questions.action.criteria, {
      click: {
        effect: 'Set velocityY to flapVelocity once, AFTER decision_horizon_ms has elapsed.',
        choose_when: [
          'Without this flap, the player would reach the floor or the lower obstacle before another answer can intervene, and this flap would avoid that contact.',
          'The approaching opening requires upward motion at answer time, and a flap would allow entry without hitting the ceiling or upper obstacle.'
        ],
        boundary_cases: 'A slightly negative observed velocity can become downward during the response delay. An opening far ahead does not remove the need to prevent falling into the floor now.'
      },
      wait: {
        effect: 'Keep the current motion with gravity and no flap until the NEXT answer, including both response delays and decision_interval_ms.',
        choose_when: [
          'Waiting through the full interval keeps the player alive and leaves a later answer time to act.',
          'The player is above an approaching lower opening and needs to descend into it; a flap would keep the player above gapTop or send it into the upper obstacle.',
          'A flap would cause contact with the ceiling or upper obstacle, and waiting gives a better chance to survive.'
        ],
        boundary_cases: 'Do not wait solely because observed velocityY is negative or the player is in the upper half. Account for falling during both response delays. Do not click solely because an earlier apex example chose click: the next opening may require descent.'
      }
    });
    assert.equal(body.state.pageText, undefined);
    assert.equal(body.state.next.id, undefined);
    assert.equal(body.state.predicted_at_response, undefined);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const answer = await handle({ type: 'decide', id: run.id, state }, game);
  assert.equal(answer.ok, true); assert.equal(answer.action, 'click'); assert.equal(answer.requests, 1);
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /上限/);
  assert.equal(calls, 1);
});
test('stop aborts in-flight requests and invalidates old sessions', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  context.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    notifyStarted();
  });
  const pending = handle({ type: 'decide', id: run.id, state }, game);
  const check = assert.rejects(pending, /応答待ちが終了/);
  await started;
  await handle({ type: 'run:stop' }, game);
  await check;
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /セッションが終了/);
});
test('concurrent decisions cannot exceed the budget or start a second fetch', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  const run = await handle({ type: 'run:begin' }, game);
  let resolveFetch, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let calls = 0;
  context.fetch = async () => {
    calls++; notifyStarted();
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  const first = handle({ type: 'decide', id: run.id, state }, game);
  await started;
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /問い合わせ中/);
  resolveFetch(new Response(JSON.stringify(result), { status: 200 }));
  await first;
  assert.equal(calls, 1);
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /上限/);
});
test('invalid decisions and HTTP errors are reported; server body is not exposed', async () => {
  const { context, handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-test-key' }, popup);
  let run = await handle({ type: 'run:begin' }, game);
  context.fetch = async () => new Response('private-server-message', { status: 401 });
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /APIキーが無効/);
  run = await handle({ type: 'run:begin' }, game);
  context.fetch = async () => new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: 'execute_script', confidence: 0.9 } } }), { status: 200 });
  await assert.rejects(handle({ type: 'decide', id: run.id, state }, game), /応答形式が不正/);
});
test('endpoint keys persist separately; local System One never receives the TypeSafe key', async () => {
  const { context, handle, stores } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake-typesafe-key' }, popup);
  const local = { ...prefs, endpoint: 'http://127.0.0.1:8009/v1/systemone', model: 'kev-latest' };
  const saved = await handle({ type: 'config:save', config: local }, popup);
  assert.equal(saved.config.hasKey, false);
  assert.equal(stores.local.apiKeys['https://api.typesafe.ai/v1/systemone'], 'fake-typesafe-key');
  const run = await handle({ type: 'run:begin' }, game);
  context.fetch = async (url, options) => {
    assert.equal(url, local.endpoint);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).model, 'kev-latest');
    return new Response(JSON.stringify({ ...result, model: 'kev-4b' }), { status: 200 });
  };
  const answer = await handle({ type: 'decide', id: run.id, state }, game);
  assert.equal(answer.model, 'kev-4b');
  await handle({ type: 'config:save', config: local, apiKey: 'fake-local-key' }, popup);
  const changed = await handle({ type: 'config:save', config: { ...local, endpoint: 'http://127.0.0.1:8000/v1/systemone', model: 'english' } }, popup);
  assert.equal(changed.config.hasKey, false);
  const back = await handle({ type: 'config:save', config: prefs }, popup);
  assert.equal(back.config.hasKey, true);
  assert.equal(stores.local.apiKeys[local.endpoint], 'fake-local-key');
  await handle({ type: 'key:clear', endpoint: local.endpoint }, popup);
  assert.equal(stores.local.apiKeys[local.endpoint], undefined);
  assert.equal((await handle({ type: 'config:get' }, popup)).config.hasKey, true);
});
test('custom endpoints require permission and reject credential-bearing or remote HTTP URLs', async () => {
  const { context, handle } = harness();
  for (const endpoint of ['http://example.com/v1/systemone', 'https://user:password@example.com/api', 'https://example.com/api?key=secret']) {
    await assert.rejects(handle({ type: 'config:save', config: { ...prefs, endpoint } }, popup));
  }
  context.chrome.permissions.contains = async () => false;
  await assert.rejects(handle({ type: 'config:save', config: { ...prefs, endpoint: 'https://example.com/v1/systemone' } }, popup), /許可/);
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake' }, popup);
  assert.equal((await handle({ type: 'key:clear' }, popup)).config.hasKey, false);
});
test('model switching invalidates the old run; model IDs may contain slashes', async () => {
  const { handle } = harness();
  await handle({ type: 'config:save', config: prefs, apiKey: 'fake' }, popup);
  const first = await handle({ type: 'run:begin' }, game);
  await handle({ type: 'config:save', config: { ...prefs, model: 'jev-preview' } }, popup);
  await assert.rejects(handle({ type: 'decide', id: first.id, state }, game), /セッション/);
  const saved = await handle({ type: 'config:save', config: { ...prefs, endpoint: 'https://example.com/v1/classifier', model: 'org/model-4b' } }, popup);
  assert.equal(saved.config.model, 'org/model-4b');
});
test('keys survive worker restarts and legacy session keys migrate without being exposed', async () => {
  const first = harness({ local: {}, session: { apiKey: 'fake-legacy-key' } });
  const config = await first.handle({ type: 'config:get' }, popup);
  assert.equal(config.config.hasKey, true);
  assert.equal(config.config.apiKeys, undefined);
  assert.equal(first.stores.session.apiKey, '');
  const second = harness(first.stores);
  assert.equal((await second.handle({ type: 'config:get' }, popup)).config.hasKey, true);
  const run = await second.handle({ type: 'run:begin' }, game);
  second.context.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fake-legacy-key');
    return new Response(JSON.stringify(result), { status: 200 });
  };
  assert.equal((await second.handle({ type: 'decide', id: run.id, state }, game)).ok, true);
});
