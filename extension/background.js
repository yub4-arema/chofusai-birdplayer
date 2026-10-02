"use strict";
importScripts("core.js");
const defaults = { mode: "jev-plan", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", maxRequests: 200, autoRestart: false };
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
  sessions.get(tabId)?.controller?.abort();
  sessions.delete(tabId);
}
async function config() {
  await ready;
  const [prefs, stored] = await Promise.all([chrome.storage.local.get(defaults), keys()]);
  return { ...prefs, hasKey: Boolean(stored[prefs.endpoint]) };
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
    if (!["jev-plan", "jev", "local"].includes(prefs?.mode) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(prefs.model) ||
        !Number.isInteger(prefs.maxRequests) || prefs.maxRequests < 1 || prefs.maxRequests > 1000) throw new Error("設定値を確認してください。");
    const endpoint = ChofuJev.endpoint(prefs.endpoint ?? defaults.endpoint);
    if (endpoint !== defaults.endpoint && prefs.mode !== "local" && !await chrome.permissions.contains({ origins: [ChofuJev.originPattern(endpoint)] })) throw new Error("接続先へのアクセスを許可してください。");
    if (message.apiKey !== undefined && (typeof message.apiKey !== "string" || message.apiKey.length > 512)) throw new Error("APIキーを確認してください。");
    const previous = await config();
    if (previous.endpoint !== endpoint || previous.model !== prefs.model || previous.mode !== prefs.mode) for (const id of [...sessions.keys()]) end(id);
    if (message.apiKey !== undefined) {
      const stored = await keys();
      if (message.apiKey.trim()) stored[endpoint] = message.apiKey.trim(); else delete stored[endpoint];
      await chrome.storage.local.set({ apiKeys: stored });
    }
    await chrome.storage.local.set({ mode: prefs.mode, endpoint, model: prefs.model, maxRequests: prefs.maxRequests, autoRestart: Boolean(prefs.autoRestart) });
    return { ok: true, config: await config() };
  }
  if (message?.type?.startsWith("config:")) throw new Error("設定の操作は拡張機能のポップアップ専用です。");
  if (!isGame(sender)) throw new Error("この操作は調布祭のゲームページ専用です。");
  const tabId = sender.tab.id;
  if (message.type === "run:begin") {
    end(tabId);
    const id = crypto.randomUUID();
    const starting = { id, prefs: null, count: 0, controller: null };
    sessions.set(tabId, starting);
    try {
      const prefs = await config();
      if (sessions.get(tabId) !== starting) throw new Error("開始をキャンセルしました。");
      if (prefs.mode !== "local" && new URL(prefs.endpoint).origin === "https://api.typesafe.ai" && !prefs.hasKey) throw new Error("拡張機能でTypeSafe APIキーを設定してください。");
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
  handle(message, sender).then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(end);
