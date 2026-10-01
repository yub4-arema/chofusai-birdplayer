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
    </style>
    <div class="box">
      <div class="row"><strong>調布祭 Flappy × Jev</strong><div><button id="start">開始</button> <button id="stop" disabled>停止</button></div></div>
      <p id="message" role="status" aria-live="polite">拡張機能のアイコンからAPIキーを設定して、開始してください。</p>
      <small id="stats">Jevが通過位置を選び、タイミング制御がクリックを実行します。</small>
    </div>`;
  game.before(host);
  const message = shadow.getElementById("message"), stats = shadow.getElementById("stats");
  const startButton = shadow.getElementById("start"), stopButton = shadow.getElementById("stop");
  let running = false, generation = 0, timer = null, session = null, prefs = null;
  let last = null, lastFlap = 0, tracks = [], nextId = 0, pending = false;
  let requests = 0, decisions = 0, lastLatency = null, selected = "middle", restartAt = null;
  let best = 0, bestKey = "chofu-jev-best";
  const score = () => Number(game.querySelector("[data-score]")?.textContent || 0) || 0;
  function showStats() {
    stats.textContent = `スコア ${score()} ／ ベスト ${best} ／ Jev判断 ${decisions}回 ／ API ${requests}/${prefs?.maxRequests ?? 200}回${lastLatency === null ? "" : ` ／ ${lastLatency}ms`}`;
  }
  const send = msg => chrome.runtime.sendMessage(msg);
  function controls() { startButton.disabled = running; stopButton.disabled = !running; }
  function stop(reason = "停止しました。") {
    generation++;
    running = false;
    clearTimeout(timer); timer = null;
    last = null; pending = false;
    controls(); message.textContent = reason; showStats();
    send({ type: "run:stop" }).catch(() => {});
  }
  function flap() {
    stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, buttons: 1 }));
    lastFlap = performance.now();
  }
  function resetTracking() { last = null; tracks = []; nextId = 0; pending = false; restartAt = null; }
  async function start() {
    if (running) return { ok: true };
    const epoch = ++generation;
    running = true; controls(); message.textContent = "設定を確認しています…";
    try {
      const response = await send({ type: "run:begin" });
      if (epoch !== generation) return { ok: false, error: "開始をキャンセルしました。" };
      if (!response.ok) throw new Error(response.error);
      session = response.id; prefs = response.config; requests = 0; decisions = 0; lastLatency = null;
      bestKey = `chofu-jev-best:${prefs.mode === "local" ? "local" : `${prefs.endpoint}|${prefs.model}`}`;
      best = 0;
      try { best = Number(localStorage.getItem(bestKey) || 0) || 0; } catch {}
      resetTracking();
      stage.scrollIntoView({ block: "center", behavior: "instant" });
      stage.focus({ preventScroll: true });
      const restart = game.querySelector('[data-action="restart"]');
      if (restart) { restart.click(); lastFlap = performance.now(); } else flap();
      message.textContent = prefs.mode === "jev" ? `${prefs.model}でプレイ中。判断待ちは中央を狙います。` : "ローカルテスト中（Jev APIは使用していません）。";
      timer = setTimeout(tick, 20); showStats();
      return { ok: true };
    } catch (error) {
      if (epoch === generation) stop(error.message);
      return { ok: false, error: error.message };
    }
  }
  function assignTracks(frame, dt) {
    const used = new Set();
    const previous = tracks;
    tracks = frame.obstacles.map(o => {
      const match = previous.find(t => !used.has(t.id) && Math.abs(t.gapTop - o.gapTop) < 3 &&
        Math.abs(t.gapBottom - o.gapBottom) < 3 && Math.abs(t.x - 165 * frame.scale * dt - o.x) < 28);
      if (match) { used.add(match.id); return { ...match, ...o }; }
      return { ...o, id: ++nextId, choice: "middle", asked: false };
    });
  }
  async function ask(frame, next, velocity) {
    const epoch = generation, trackId = next.id;
    pending = true; next.asked = true;
    const candidateTargets = ChofuJev.plans(frame, next);
    try {
      const following = tracks.find(t => t.x > next.x + next.width + 10);
      const response = await send({
        type: "decide", id: session,
        state: {
          screen: { width: frame.width, height: frame.height },
          player: { ...frame.player, velocityY: velocity },
          physics: { gravity: 1500 * frame.scale, flapVelocity: -430 * frame.scale, speedX: 165 * frame.scale },
          next, following: following ?? null, candidate_targets: candidateTargets
        }
      });
      if (epoch !== generation || !running) return;
      if (!response.ok) throw new Error(response.error);
      requests = response.requests; lastLatency = response.latencyMs;
      const current = tracks.find(t => t.id === trackId);
      if (current && current.x + current.width >= frame.player.x - frame.player.radius) {
        current.choice = response.choice;
        selected = response.choice; decisions++;
        const labels = { upper: "上寄り", middle: "中央", lower: "下寄り" };
        message.textContent = `Jev: ${labels[selected]}を選択${response.confidence === null ? "" : ` ／ 信頼度 ${Math.round(response.confidence * 100)}%`} ／ ${response.model === "unknown" ? prefs.model : response.model}`;
      }
      showStats();
    } catch (error) {
      if (epoch === generation && running) stop(error.message);
    } finally { if (epoch === generation) pending = false; }
  }
  function tick() {
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
        showStats();
        if (!prefs.autoRestart) { stop(`ゲーム終了：${currentScore}点。開始で再挑戦できます。`); return; }
        if (restartAt === null) { restartAt = now + 650; message.textContent = `${currentScore}点で終了。再挑戦します…`; }
        if (now >= restartAt && !pending) {
          game.querySelector('[data-action="restart"]')?.click(); lastFlap = now; resetTracking();
        }
        timer = setTimeout(tick, 20); return;
      }
      const frame = ChofuJev.observe(ctx.getImageData(0, 0, canvas.width, canvas.height), rect.width, rect.height);
      if (!frame) { stop("赤いプレイヤーを読み取れませんでした。ページを再読み込みしてください。"); return; }
      const dt = last ? (now - last.time) / 1000 : 0.04;
      let velocity = last && dt < 0.2 ? (frame.player.y - last.y) / dt : 0;
      velocity = Math.max(-500 * frame.scale, Math.min(1000 * frame.scale, velocity));
      assignTracks(frame, dt);
      const next = tracks.find(o => o.x + o.width >= frame.player.x - frame.player.radius);
      const target = next ? ChofuJev.plans(frame, next)[next.choice] : frame.height / 2;
      if (next && prefs.mode === "jev" && !next.asked && !pending) void ask(frame, next, velocity);
      if (ChofuJev.flapNeeded(frame, target, velocity, now - lastFlap)) flap();
      last = { time: now, y: frame.player.y };
      showStats(); timer = setTimeout(tick, 20);
    } catch (error) { stop(`読み取りエラー：${error.message}`); }
  }
  startButton.addEventListener("click", () => void start());
  stopButton.addEventListener("click", () => stop());
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
