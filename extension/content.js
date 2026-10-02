(() => {
  "use strict";
  const game = document.querySelector("[data-flappy]");
  const stage = game?.querySelector("[data-stage]");
  const canvas = game?.querySelector("[data-canvas]");
  const ctx = canvas?.getContext("2d");
  if (!game || !stage || !canvas || !ctx || document.getElementById("chofu-jev-controls")) return;
  const host = document.createElement("div");
  host.id = "chofu-jev-controls";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{display:block;margin:16px auto;max-width:672px;font:14px/1.6 system-ui,sans-serif;color:#edf6ff}
      .box{background:#122639;border:1px solid #416078;border-radius:14px;padding:16px}
      .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      strong{font-size:16px}p{margin:8px 0 0;color:#c3d9e9}small{display:block;color:#a9c6d9;margin-top:5px}
      button{font:inherit;font-weight:700;border:1px solid #7293ab;border-radius:8px;padding:7px 14px;background:#d2f4ff;color:#092133;cursor:pointer}
      button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:3px solid #fbc96b;outline-offset:3px}
      #stop{background:transparent;color:#edf6ff}#message{white-space:pre-wrap}
      #logData{box-sizing:border-box;width:100%;margin-top:10px;background:#091a29;color:#edf6ff;border:1px solid #416078;border-radius:8px;padding:8px;font:11px/1.4 ui-monospace,monospace}
    </style>
    <div class="box">
      <div class="row"><strong>調布祭 Flappy × Jev</strong><div><button id="start">開始</button> <button id="stop" disabled>停止</button> <button id="log" disabled>ログをコピー</button></div></div>
      <p id="message" role="status" aria-live="polite">拡張機能のアイコンからAPIキーを設定して、開始してください。</p>
      <small id="stats">Jevが各観測でクリックか待機を選び、クリック操作を実行します。</small>
      <textarea id="logData" aria-label="診断ログ" rows="10" readonly hidden></textarea>
    </div>`;
  game.before(host);
  const message = shadow.getElementById("message"), stats = shadow.getElementById("stats");
  const startButton = shadow.getElementById("start"), stopButton = shadow.getElementById("stop");
  const logButton = shadow.getElementById("log"), logData = shadow.getElementById("logData");
  const DECISION_INTERVAL_MS = 20, MAX_ACTION_LATENCY_MS = 900;
  const LOG_INTERVAL_MS = 50, MAX_LOG_EVENTS = 2400;
  let running = false, generation = 0, timer = null, session = null, prefs = null;
  let last = null, lastFlap = 0, motionVelocity = null, pending = false, nextDecisionAt = 0;
  let latencySamples = [];
  let requests = 0, decisions = 0, lastLatency = null, restartAt = null;
  let diagnosticEvents = [], runStartedAt = null, runStartedWall = null, lastLoggedAt = -Infinity, attemptNumber = 0;
  let diagnosticsTruncated = false, gameOverLogged = false;
  let best = 0, bestKey = "chofu-jev-best";
  const score = () => Number(game.querySelector("[data-score]")?.textContent || 0) || 0;
  function showStats() {
    stats.textContent = `スコア ${score()} ／ ベスト ${best} ／ Jev判断 ${decisions}回 ／ API ${requests}/${prefs?.maxRequests ?? 200}回${lastLatency === null ? "" : ` ／ ${lastLatency}ms`}`;
  }
  function record(type, detail = {}) {
    if (runStartedAt === null) return;
    diagnosticEvents.push({ t_ms: Math.round(performance.now() - runStartedAt), type, ...detail });
    if (diagnosticEvents.length > MAX_LOG_EVENTS) { diagnosticEvents.shift(); diagnosticsTruncated = true; }
    logButton.disabled = false;
  }
  const send = msg => chrome.runtime.sendMessage(msg);
  function controls() { startButton.disabled = running; stopButton.disabled = !running; logButton.disabled = diagnosticEvents.length === 0; }
  function stop(reason = "停止しました。") {
    record("stop", { reason, score: score(), pending });
    generation++;
    running = false;
    cancelAnimationFrame(timer); timer = null;
    last = null; pending = false; nextDecisionAt = 0;
    controls(); message.textContent = reason; showStats();
    send({ type: "run:stop" }).catch(() => {});
  }
  function flap(source = "local") {
    stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, buttons: 1 }));
    lastFlap = performance.now();
    motionVelocity = -430 * (last?.frame.scale ?? Math.max(0.7, Math.min(1.15, stage.clientHeight / 360)));
    record("click", { source, score: score() });
  }
  function resetTracking() { last = null; motionVelocity = null; pending = false; nextDecisionAt = 0; restartAt = null; }
  async function start() {
    if (running) return { ok: true };
    const epoch = ++generation;
    running = true; controls(); message.textContent = "設定を確認しています…";
    try {
      const response = await send({ type: "run:begin" });
      if (epoch !== generation) return { ok: false, error: "開始をキャンセルしました。" };
      if (!response.ok) throw new Error(response.error);
      session = response.id; prefs = response.config; requests = 0; decisions = 0; lastLatency = null;
      latencySamples = [];
      bestKey = `chofu-jev-best:${prefs.mode === "local" ? "local" : `${prefs.endpoint}|${prefs.model}`}`;
      best = 0;
      try { best = Number(localStorage.getItem(bestKey) || 0) || 0; } catch {}
      resetTracking();
      diagnosticEvents = []; runStartedAt = performance.now(); runStartedWall = new Date().toISOString();
      lastLoggedAt = -Infinity; attemptNumber = 0; diagnosticsTruncated = false; gameOverLogged = false;
      logData.hidden = true; logData.value = "";
      stage.scrollIntoView({ block: "center", behavior: "instant" });
      stage.focus({ preventScroll: true });
      const restart = game.querySelector('[data-action="restart"]');
      record("start", {
        started_at: runStartedWall, mode: prefs.mode, model: prefs.model,
        start_method: restart ? "restart-button" : "pointer-click",
        stage: { width: stage.clientWidth, height: stage.clientHeight },
        canvas: { width: canvas.width, height: canvas.height }
      });
      if (restart) { restart.click(); lastFlap = performance.now(); record("restart", { source: "start" }); } else flap("start");
      message.textContent = prefs.mode === "jev" ? `${prefs.model}がクリックか待機を判断しています。` : "ローカルテスト中（Jev APIは使用していません）。";
      timer = requestAnimationFrame(tick); showStats();
      return { ok: true };
    } catch (error) {
      if (epoch === generation) stop(error.message);
      return { ok: false, error: error.message };
    }
  }
  function decisionState(frame, velocity, sampledAt) {
    const sampleAge = Math.max(0, performance.now() - sampledAt);
    const timing = ChofuJev.estimateLatency(latencySamples);
    const horizon = timing.typical_ms + sampleAge;
    const gravity = 1500 * frame.scale, speedX = 165 * frame.scale;
    const thresholdX = frame.player.x - frame.player.radius;
    const upcoming = frame.obstacles
      .filter(obstacle => obstacle.x + obstacle.width >= thresholdX)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2);
    return {
      screen: { width: frame.width, height: frame.height },
      player: { ...frame.player, velocityY: velocity },
      physics: { gravity, flapVelocity: -430 * frame.scale, speedX },
      next: upcoming[0] ?? null,
      following: upcoming[1] ?? null,
      since_last_click_ms: Math.max(0, sampledAt - lastFlap),
      decision_horizon_ms: horizon,
      next_response_latency_ms: timing.cautious_ms,
      response_timing: timing,
      decision_interval_ms: DECISION_INTERVAL_MS,
      sample_age_ms: sampleAge
    };
  }
  async function ask(frame, velocity, sampledAt) {
    const epoch = generation;
    pending = true;
    const attempt = ++attemptNumber;
    const requestStartedAt = performance.now();
    let state, diagnosticState = null;
    try {
      state = decisionState(frame, velocity, sampledAt);
      diagnosticState = ChofuJev.sanitizeState(state);
      record("request", { attempt, state: diagnosticState });
      const response = await send({ type: "decide", id: session, state });
      if (epoch !== generation || !running) return;
      if (!response.ok) throw new Error(response.error);
      const elapsed = performance.now() - requestStartedAt;
      requests = response.requests; lastLatency = response.latencyMs;
      latencySamples.push(elapsed);
      if (latencySamples.length > 20) latencySamples.shift();
      const observation = last ? {
        sampled_at_ms: Math.round((last.time - runStartedAt) * 100) / 100,
        age_ms: Math.round((performance.now() - last.time) * 100) / 100,
        player_y: last.y, player_velocity_y: Math.round(last.velocity * 100) / 100,
        predicted_y_at_same_sample: Math.round((state.player.y + state.player.velocityY * (last.time - sampledAt) / 1000 + 0.5 * state.physics.gravity * ((last.time - sampledAt) / 1000) ** 2) * 100) / 100
      } : null;
      record("response", {
        attempt, action: response.action, confidence: response.confidence,
        probabilities: response.probabilities,
        model: response.model, api_latency_ms: response.latencyMs,
        end_to_end_ms: Math.round(elapsed), requests, observation_at_response: observation
      });
      if (elapsed > MAX_ACTION_LATENCY_MS) {
        stop(`Jevの応答が${MAX_ACTION_LATENCY_MS}msを超えたため、古い判断を実行せず停止しました。`);
        return;
      }
      decisions++;
      const over = game.querySelector('[data-panel="over"]');
      if (response.action === "click" && over?.hidden !== false) flap("jev");
      record("action", { attempt, action: response.action, executed: response.action !== "click" || over?.hidden !== false, score: score() });
      const actionLabel = response.action === "click" ? "クリック" : "待機";
      message.textContent = `Jev: ${actionLabel}${response.confidence === null ? "" : ` ／ 信頼度 ${Math.round(response.confidence * 100)}%`} ／ ${response.model === "unknown" ? prefs.model : response.model}`;
      showStats();
      if (requests >= prefs.maxRequests) stop("API呼び出し上限に達したため停止しました。");
    } catch (error) {
      record("request_error", { attempt, error: error.message, end_to_end_ms: Math.round(performance.now() - requestStartedAt), state: diagnosticState });
      if (epoch === generation && running) stop(error.message);
    } finally {
      if (epoch === generation) {
        pending = false;
        nextDecisionAt = performance.now() + DECISION_INTERVAL_MS;
      }
    }
  }
  function tick(frameAt) {
    if (!running) return;
    try {
      if (!stage.isConnected || !canvas.isConnected) { stop("ゲームが見つからなくなったため停止しました。"); return; }
      const now = performance.now(), rect = stage.getBoundingClientRect();
      if (document.hidden || rect.bottom < rect.height * 0.2 || rect.top > innerHeight - rect.height * 0.2) {
        stop("ゲームが画面外になったため停止しました。表示して再開してください。"); return;
      }
      const currentScore = score();
      if (currentScore > best) {
        best = currentScore;
        try { localStorage.setItem(bestKey, String(best)); } catch {}
      }
      if (!game.querySelector('[data-panel="over"]')?.hidden) {
        if (!gameOverLogged) {
          record("game_over", { score: currentScore, pending, last_latency_ms: lastLatency });
          gameOverLogged = true;
        }
        showStats();
        if (!prefs.autoRestart) { stop(`ゲーム終了：${currentScore}点。開始で再挑戦できます。`); return; }
        if (restartAt === null) { restartAt = now + 650; message.textContent = `${currentScore}点で終了。再挑戦します…`; }
        if (now >= restartAt && !pending) {
          game.querySelector('[data-action="restart"]')?.click(); lastFlap = now; record("restart", { source: "auto", score: currentScore }); resetTracking(); gameOverLogged = false;
        }
        timer = requestAnimationFrame(tick); return;
      }
      // The game's rAF callback draws before ours, with this same timestamp.
      // Its semi-implicit Euler update is v += g*dt; y += v*dt, with dt capped at 50ms.
      const sampledAt = frameAt;
      const frame = ChofuJev.observe(ctx.getImageData(0, 0, canvas.width, canvas.height), rect.width, rect.height);
      if (!frame) { stop("赤いプレイヤーを読み取れませんでした。ページを再読み込みしてください。"); return; }
      const dt = Math.max(0, Math.min(0.05, (sampledAt - (last?.time ?? lastFlap)) / 1000));
      motionVelocity ??= -430 * frame.scale;
      motionVelocity += 1500 * frame.scale * dt;
      if (!last) {
        // On the first run the game may reuse its idle animation clock.
        // Recover that first capped step from its known restart position and Euler update.
        const gravity = 1500 * frame.scale, flapVelocity = -430 * frame.scale;
        const discriminant = flapVelocity ** 2 + 4 * gravity * (frame.player.y - frame.height / 2);
        const firstStep = discriminant >= 0 ? (-flapVelocity - Math.sqrt(discriminant)) / (2 * gravity) : -1;
        if (firstStep >= 0 && firstStep <= 0.051) motionVelocity = flapVelocity + gravity * Math.min(0.05, firstStep);
      }
      const velocity = motionVelocity;
      const displacementError = last ? frame.player.y - (last.y + velocity * dt) : null;
      if (sampledAt - lastLoggedAt >= LOG_INTERVAL_MS) {
        record("observation", {
          score: currentScore, pending, velocity_source: "game-frame-physics",
          frame_dt_ms: Math.round(dt * 100000) / 100,
          displacement_error_px: displacementError === null ? null : Math.round(displacementError * 100) / 100,
          sampled_at_ms: Math.round((sampledAt - runStartedAt) * 100) / 100,
          sample_age_ms: Math.round((performance.now() - sampledAt) * 100) / 100,
          screen: { width: frame.width, height: frame.height, scale: frame.scale },
          player: { ...frame.player, velocityY: Math.round(velocity * 100) / 100 },
          obstacles: frame.obstacles.slice(0, 8)
        });
        lastLoggedAt = sampledAt;
      }
      last = { time: sampledAt, y: frame.player.y, velocity, frame };
      if (prefs.mode === "jev") {
        if (!pending && performance.now() >= nextDecisionAt) void ask(frame, velocity, sampledAt);
      } else {
        const next = frame.obstacles.find(o => o.x + o.width >= frame.player.x - frame.player.radius);
        const target = next ? (next.gapTop + next.gapBottom) / 2 : frame.height / 2;
        if (ChofuJev.flapNeeded(frame, target, velocity, sampledAt - lastFlap)) flap();
      }
      showStats(); timer = requestAnimationFrame(tick);
    } catch (error) { stop(`読み取りエラー：${error.message}`); }
  }
  startButton.addEventListener("click", () => void start());
  stopButton.addEventListener("click", () => stop());
  logButton.addEventListener("click", async () => {
    const payload = JSON.stringify({
      format: "chofu-jev-diagnostics-v1", extension_version: chrome.runtime.getManifest().version,
      started_at: runStartedWall, truncated: diagnosticsTruncated,
      events: diagnosticEvents
    }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      logData.hidden = true; message.textContent = "診断ログをコピーしました。ここに貼り付けてください。";
    } catch {
      logData.value = payload; logData.hidden = false; logData.focus(); logData.select();
      message.textContent = "ログを選択しました。Ctrl+Cでコピーして、ここに貼り付けてください。";
    }
  });
  window.addEventListener("pagehide", () => stop());
  window.addEventListener("resize", () => { if (running) stop("画面サイズが変わったため停止しました。開始で再開できます。"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && running) stop("タブを離れたため停止しました。"); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && running) stop(); });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "ui:status") { reply({ ok: true, running, score: score(), best, requests, decisions, message: message.textContent }); return false; }
    if (msg.type === "ui:stop") { stop(); reply({ ok: true }); return false; }
    if (msg.type === "ui:start") { start().then(reply); return true; }
    return false;
  });
})();
