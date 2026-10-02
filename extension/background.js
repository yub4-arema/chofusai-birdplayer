"use strict";
importScripts("core.js");
const REFLEX_MODE = "jev-reflex-neutral";
const defaults = { mode: REFLEX_MODE, endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", maxRequests: 200, autoRestart: false };
const sessions = new Map();
const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
  const legacy = await chrome.storage.session.get(["apiKey", "apiKeyEndpoint"]);
  if (legacy.apiKey) {
    const stored = await keys();
    const endpoint = ChofuJev.endpoint(legacy.apiKeyEndpoint ?? defaults.endpoint);
    if (!stored[endpoint]) stored[endpoint] = legacy.apiKey;
    await chrome.storage.local.set({ apiKeys: stored });
    await chrome.storage.session.set({ apiKey: "" });
  }
})();
async function keys() {
  const { apiKeys } = await chrome.storage.local.get("apiKeys");
  return apiKeys && typeof apiKeys === "object" && !Array.isArray(apiKeys) ? apiKeys : {};
}
function isPopup(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html") && !sender.tab;
}
function isGame(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === "https://www.chofusai.jp" && /^\/map\/?$/.test(url.pathname);
  } catch { return false; }
}
function end(tabId) {
  const session = sessions.get(tabId);
  session?.controller?.abort();
  for (const controller of session?.controllers?.values() ?? []) controller.abort();
  session?.controllers?.clear();
  sessions.delete(tabId);
}
async function config() {
  await ready;
  const [prefs, stored] = await Promise.all([chrome.storage.local.get(defaults), keys()]);
  // v1.4.0 has one standard control protocol. Migrate any v1.3 mode selection.
  if (prefs.mode !== REFLEX_MODE) await chrome.storage.local.set({ mode: REFLEX_MODE });
  return { ...prefs, mode: REFLEX_MODE, hasKey: Boolean(stored[prefs.endpoint]) };
}
function requestError(message, failureClass = "harness") {
  const error = new Error(message);
  error.failureClass = failureClass;
  return error;
}
async function decideReflex(session, tabId, message, receivedAt) {
  const requestId = message.request_id;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 100 ||
      session.seenRequestIds.has(requestId)) throw requestError("リクエストIDが不正です。");
  if (session.count >= session.prefs.maxRequests) throw requestError("設定したAPI呼び出し上限に達しました。");
  if (session.controllers.size >= ChofuJev.REFLEX_MAX_IN_FLIGHT) throw requestError("同時リクエスト上限に達しました。");
  let metadata;
  try {
    metadata = {
      sent_at: Number(message.sent_at),
      observation_time: Number(message.observation_time),
      target_time: Number(message.target_time),
      predicted_latency: Number(message.predicted_latency),
      flap_epoch: Number(message.flap_epoch)
    };
    if (![metadata.sent_at, metadata.observation_time, metadata.target_time, metadata.predicted_latency].every(Number.isFinite) ||
        metadata.observation_time < 0 || metadata.sent_at < metadata.observation_time || metadata.target_time < metadata.sent_at ||
        metadata.predicted_latency < 0 || metadata.predicted_latency > 1500 ||
        !Number.isSafeInteger(metadata.flap_epoch) || metadata.flap_epoch < 0 ||
        Math.abs(metadata.target_time - metadata.sent_at - metadata.predicted_latency) > 2) {
      throw new Error("リクエスト時刻が不正です。");
    }
    const state = ChofuJev.sanitizeReflexState(message.state);
    if (Math.abs(state.timing.target_time - metadata.target_time) > 1 ||
        Math.abs(state.timing.predicted_latency - metadata.predicted_latency) > 1) {
      throw new Error("状態とリクエストの時刻が一致しません。");
    }
    message = { ...message, state };
  } catch (error) {
    throw requestError(error.message, "harness");
  }
  const controller = new AbortController();
  session.seenRequestIds.add(requestId);
  session.controllers.set(requestId, controller);
  session.count++;
  let timer;
  let timedOut = false;
  const progress = (phase, detail = {}) => {
    chrome.tabs.sendMessage(tabId, {
      type: "decide:progress", id: session.id, request_id: requestId,
      phase, elapsed_ms: Math.round(performance.now() - receivedAt),
      requests: session.count, in_flight: session.controllers.size, ...detail
    }, { frameId: 0 }).catch(() => {});
  };
  let phase = "validation";
  try {
    progress("worker_ready");
    phase = "credentials";
    const apiKey = (await keys())[session.prefs.endpoint];
    if (new URL(session.prefs.endpoint).origin === "https://api.typesafe.ai" && !apiKey) {
      throw requestError("APIキーがありません。拡張機能から再設定してください。", "api_error");
    }
    if (session.prefs.endpoint !== defaults.endpoint && !await chrome.permissions.contains({ origins: [ChofuJev.originPattern(session.prefs.endpoint)] })) {
      throw requestError("接続先へのアクセス権がありません。", "api_error");
    }
    if (sessions.get(tabId) !== session) throw requestError("セッションが終了しました。", "cancelled");
    const body = JSON.stringify(ChofuJev.buildReflexRequest(message.state, session.prefs.model));
    progress("request_prepared", { body_bytes: new TextEncoder().encode(body).byteLength });
    phase = "network";
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, 2500);
    progress("fetch_started");
    const started = performance.now();
    const response = await fetch(session.prefs.endpoint, {
      method: "POST",
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json", Accept: "application/json" },
      body, signal: controller.signal, credentials: "omit", redirect: "error"
    });
    progress("headers_received", { http_status: response.status });
    if (!response.ok) {
      const reasons = { 401: "APIキーが無効です", 403: "APIへのアクセス権がありません", 429: "APIの利用制限に達しました" };
      throw requestError(`Jev API: ${reasons[response.status] ?? "接続エラー"} (HTTP ${response.status})`, "api_error");
    }
    phase = "response";
    const result = await response.json();
    progress("body_received");
    phase = "jev_decision";
    const decision = ChofuJev.parseReflexDecision(result);
    if (sessions.get(tabId) !== session) throw requestError("セッションが終了しました。", "cancelled");
    progress("decision_parsed");
    return {
      ok: true, ...decision, request_id: requestId,
      latencyMs: Math.round(performance.now() - started), requests: session.count
    };
  } catch (error) {
    if (error.failureClass) throw error;
    if (error.name === "AbortError") {
      throw requestError(timedOut ? "Jevの応答がタイムアウトしました。" : "リクエストがキャンセルされました。", timedOut ? "network_latency" : "cancelled");
    }
    if (error instanceof TypeError && phase === "network") throw requestError("Jev APIに接続できません。ネットワークを確認してください。", "network_latency");
    throw requestError(error.message, phase === "jev_decision" ? "jev_decision" : phase === "response" ? "jev_response" : "harness");
  } finally {
    clearTimeout(timer);
    if (session.controllers.get(requestId) === controller) session.controllers.delete(requestId);
  }
}
async function handle(message, sender) {
  const receivedAt = performance.now();
  await ready;
  if (message?.type === "config:get" && isPopup(sender)) return { ok: true, config: await config() };
  if (message?.type === "key:clear" && isPopup(sender)) {
    const endpoint = ChofuJev.endpoint(message.endpoint ?? (await config()).endpoint);
    const stored = await keys(); delete stored[endpoint];
    await chrome.storage.local.set({ apiKeys: stored });
    for (const [id, session] of sessions) if (session.prefs?.endpoint === endpoint) end(id);
    return { ok: true, config: await config() };
  }
  if (message?.type === "config:save" && isPopup(sender)) {
    const prefs = message.config;
    if (!prefs || typeof prefs.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(prefs.model) ||
        !Number.isInteger(prefs.maxRequests) || prefs.maxRequests < 1 || prefs.maxRequests > 1000) throw new Error("設定値を確認してください。");
    const endpoint = ChofuJev.endpoint(prefs.endpoint ?? defaults.endpoint);
    if (endpoint !== defaults.endpoint && !await chrome.permissions.contains({ origins: [ChofuJev.originPattern(endpoint)] })) throw new Error("接続先へのアクセスを許可してください。");
    if (message.apiKey !== undefined && (typeof message.apiKey !== "string" || message.apiKey.length > 512)) throw new Error("APIキーを確認してください。");
    const previous = await config();
    if (previous.endpoint !== endpoint || previous.model !== prefs.model) for (const id of [...sessions.keys()]) end(id);
    if (message.apiKey !== undefined) {
      const stored = await keys();
      if (message.apiKey.trim()) stored[endpoint] = message.apiKey.trim(); else delete stored[endpoint];
      await chrome.storage.local.set({ apiKeys: stored });
    }
    await chrome.storage.local.set({ mode: REFLEX_MODE, endpoint, model: prefs.model, maxRequests: prefs.maxRequests, autoRestart: Boolean(prefs.autoRestart) });
    return { ok: true, config: await config() };
  }
  if (message?.type?.startsWith("config:")) throw new Error("設定の操作は拡張機能のポップアップ専用です。");
  if (!isGame(sender)) throw new Error("この操作は調布祭のゲームページ専用です。");
  const tabId = sender.tab.id;
  if (message.type === "run:begin") {
    end(tabId);
    const id = crypto.randomUUID();
    const starting = { id, prefs: null, count: 0, controller: null, controllers: new Map(), seenRequestIds: new Set() };
    sessions.set(tabId, starting);
    try {
      const prefs = await config();
      if (sessions.get(tabId) !== starting) throw new Error("開始をキャンセルしました。");
      if (new URL(prefs.endpoint).origin === "https://api.typesafe.ai" && !prefs.hasKey) throw new Error("拡張機能でTypeSafe APIキーを設定してください。");
      starting.prefs = prefs;
      return { ok: true, id, config: prefs };
    } catch (error) {
      if (sessions.get(tabId) === starting) end(tabId);
      throw error;
    }
  }
  if (message.type === "run:stop") {
    // Cleanup from an old diagnostic request must not abort a newly started run.
    if (!message.id || sessions.get(tabId)?.id === message.id) end(tabId);
    return { ok: true };
  }
  const session = sessions.get(tabId);
  if (!session || message.id !== session.id) throw new Error("セッションが終了しました。もう一度開始してください。");
  if (message.type === "decide:reflex") {
    if (session.prefs.mode !== REFLEX_MODE) throw new Error("v1.4.0の標準要求形式に一致しません。");
    return await decideReflex(session, tabId, message, receivedAt);
  }
  if (message.type !== "decide" || !["jev-plan", "jev"].includes(session.prefs.mode)) throw new Error("操作が不正です。");
  if (session.controller) throw new Error("Jevに問い合わせ中です。");
  if (session.count >= session.prefs.maxRequests) throw new Error("設定したAPI呼び出し上限に達しました。");
  const planned = session.prefs.mode === "jev-plan";
  const state = planned ? ChofuJev.sanitizePlanState(message.state) : ChofuJev.sanitizeState(message.state);
  const controller = new AbortController();
  session.controller = controller;
  let timer;
  let timedOut = false;
  const started = performance.now();
  const progress = (phase, detail = {}) => {
    if (!Number.isInteger(message.attempt)) return;
    chrome.tabs.sendMessage(tabId, {
      type: "decide:progress", id: session.id, attempt: message.attempt,
      phase, elapsed_ms: Math.round(performance.now() - receivedAt), requests: session.count, ...detail
    }, { frameId: 0 }).catch(() => {});
  };
  progress("worker_ready");
  try {
    const apiKey = (await keys())[session.prefs.endpoint];
    if (new URL(session.prefs.endpoint).origin === "https://api.typesafe.ai" && !apiKey) throw new Error("APIキーがありません。拡張機能から再設定してください。");
    if (session.prefs.endpoint !== defaults.endpoint && !await chrome.permissions.contains({ origins: [ChofuJev.originPattern(session.prefs.endpoint)] })) throw new Error("接続先へのアクセス権がありません。");
    if (sessions.get(tabId) !== session) throw new Error("セッションが終了しました。");
    session.count++;
    const body = JSON.stringify(planned ? ChofuJev.buildPlanRequest(state, session.prefs.model) : ChofuJev.buildRequest(state, session.prefs.model));
    progress("request_prepared", { body_bytes: new TextEncoder().encode(body).byteLength });
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, 2500);
    progress("fetch_started");
    const response = await fetch(session.prefs.endpoint, {
      method: "POST",
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json", Accept: "application/json" },
      body, signal: controller.signal,
      credentials: "omit", redirect: "error"
    });
    progress("headers_received", { http_status: response.status });
    if (!response.ok) {
      const reasons = { 401: "APIキーが無効です", 403: "APIへのアクセス権がありません", 429: "APIの利用制限に達しました" };
      throw new Error(`Jev API: ${reasons[response.status] ?? "接続エラー"} (HTTP ${response.status})`);
    }
    const result = await response.json();
    progress("body_received");
    const decision = planned ? ChofuJev.parsePlanDecision(result) : ChofuJev.parseDecision(result);
    if (sessions.get(tabId) !== session) throw new Error("セッションが終了しました。");
    progress("decision_parsed");
    return { ok: true, ...decision, latencyMs: Math.round(performance.now() - started), requests: session.count };
  } catch (error) {
    progress(error.name === "AbortError" ? (timedOut ? "timeout" : "cancelled") : "request_failed");
    if (error.name === "AbortError") throw new Error("Jevの応答待ちが終了しました（停止またはタイムアウト）。");
    if (error instanceof TypeError) throw new Error("Jev APIに接続できません。ネットワークを確認してください。");
    throw error;
  } finally {
    clearTimeout(timer);
    session.controller = null;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond).catch(error => respond({ ok: false, error: error.message, failure_class: error.failureClass ?? "harness" }));
  return true;
});
chrome.tabs.onRemoved.addListener(end);
