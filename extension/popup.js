"use strict";
const $ = id => document.getElementById(id);
let hasKey = false;
const buttons = [...document.querySelectorAll("button")];
const setStatus = text => { $("status").textContent = text; };
async function background(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "拡張機能に接続できません。");
  return result;
}
function displayConfig(config) {
  hasKey = config.hasKey;
  $("provider").value = config.provider || "jev";
  $("accountId").value = config.accountId || "";
  $("model").value = config.model;
  $("endpoint").value = config.endpoint;
  $("limit").value = config.maxRequests; $("autoRestart").checked = config.autoRestart;
  $("requestInterval").value = config.requestIntervalMs;
  updateProviderFields(false);
  $("keyStatus").textContent = hasKey ? "この接続先のキーは保存済みです。空欄ならそのキーを使います。" : "この接続先のキーは未設定です。不要な場合は空欄のままで使えます。";
}
function updateProviderFields(setPreset = true) {
  const provider = $("provider").value;
  const cloudflare = provider.startsWith("cloudflare-");
  $("accountLabel").hidden = !cloudflare;
  $("accountId").hidden = !cloudflare;
  $("accountId").required = cloudflare;
  $("endpoint").readOnly = cloudflare;
  $("model").readOnly = cloudflare || provider === "liquid-d1";
  if (!setPreset) return;
  const presets = {
    jev: ["https://api.typesafe.ai/v1/systemone", "jev-latest"],
    "liquid-d1": ["https://api.liquid.ai/decisions/v1/systemone", "d1"],
    laya: ["http://127.0.0.1:8000/v1/systemone", "english"]
  };
  if (cloudflare) {
    const account = $("accountId").value.trim();
    const model = provider === "cloudflare-clef" ? "clef" : "clef-flash";
    $("model").value = model;
    $("endpoint").value = account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}` : "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run/@cf/cloudflare/" + model;
    return;
  }
  if (presets[provider]) {
    $("endpoint").value = presets[provider][0];
    $("model").value = presets[provider][1];
  }
}
async function save() {
  if (!$("settings").reportValidity()) throw new Error("設定値を確認してください。");
  const endpoint = ChofuJev.endpoint($("endpoint").value.trim());
  if (endpoint !== "https://api.typesafe.ai/v1/systemone") {
    if (!await chrome.permissions.request({ origins: [ChofuJev.originPattern(endpoint)] })) throw new Error("接続先へのアクセスが許可されませんでした。");
  }
  const message = {
    type: "config:save",
    config: { provider: $("provider").value, accountId: $("accountId").value.trim(), endpoint, model: $("model").value.trim(), maxRequests: Number($("limit").value), autoRestart: $("autoRestart").checked, requestIntervalMs: Number($("requestInterval").value) }
  };
  if ($("apiKey").value.trim()) message.apiKey = $("apiKey").value.trim();
  const result = await background(message);
  $("apiKey").value = ""; displayConfig(result.config);
}
async function game(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("ゲームのタブを開いてください。");
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { type }); }
  catch { throw new Error("調布祭のマップを開いて、ページを再読み込みしてください。"); }
  if (!result?.ok) throw new Error(result?.error || "ゲームが見つかりません。");
  return result;
}
async function action(task) {
  buttons.forEach(button => { button.disabled = true; });
  try { await task(); } catch (error) { setStatus(error.message); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
$("settings").addEventListener("submit", event => {
  event.preventDefault(); void action(async () => { await save(); setStatus("設定を保存しました。"); });
});
$("start").addEventListener("click", () => void action(async () => {
  await save(); setStatus("開始しています…"); await game("ui:stop"); await game("ui:start");
  setStatus(`開始しました。要求間隔${$("requestInterval").value}msです。`);
}));
$("stop").addEventListener("click", () => void action(async () => { await game("ui:stop"); setStatus("停止しました。"); }));
$("clearKey").addEventListener("click", () => void action(async () => {
  const result = await background({ type: "key:clear", endpoint: ChofuJev.endpoint($("endpoint").value.trim()) });
  $("apiKey").value = ""; displayConfig(result.config); setStatus("APIキーを削除しました。");
}));
$("endpoint").addEventListener("input", () => {
  $("keyStatus").textContent = "キーは接続先ごとに保存されています。空欄で保存すると、その接続先の保存済みキーを使います。";
});
$("provider").addEventListener("change", () => updateProviderFields(true));
$("accountId").addEventListener("input", () => updateProviderFields(true));
void action(async () => {
  displayConfig((await background({ type: "config:get" })).config);
  try {
    const state = await game("ui:status");
    setStatus(state.running ? state.message : "ゲームの準備ができています。保存して開始を押してください。");
  } catch (error) { setStatus(error.message); }
});
