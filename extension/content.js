(() => {
  "use strict";
  const game = document.querySelector('[data-flappy]');
  const stage = game?.querySelector('[data-stage]');
  const canvas = game?.querySelector('[data-canvas]');
  const ctx = canvas?.getContext('2d');
  if (!game || !stage || !canvas || !ctx || document.getElementById('chofu-jev-controls')) return;
  const host = document.createElement('div');
  host.id = 'chofu-jev-controls';
  const shadow = host.attachShadow({ mode: 'open' });
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
    <div class="box"><div class="row"><strong>調布祭 Flappy × Jev <span style="font-size:11px;color:#a9c6d9">r3</span></strong><div><button id="start">開始</button> <button id="stop" disabled>停止</button> <button id="diagnosticsCopy">診断ログをコピー</button></div></div>
    <p id="message" role="status" aria-live="polite">拡張機能からAPIキー・要求間隔を設定して、開始してください。</p>
    <small id="stats">クリックするか待つかはJevが選びます。</small></div>`;
  game.before(host);
  const message = shadow.getElementById('message'), stats = shadow.getElementById('stats');
  const startButton = shadow.getElementById('start'), stopButton = shadow.getElementById('stop');
  const send = value => chrome.runtime.sendMessage(value);
  const maxInFlight = ChofuJev.REFLEX_MAX_IN_FLIGHT, maxLate = ChofuJev.REFLEX_MAX_LATE_MS;
  const DIAGNOSTIC_RUN_LIMIT = 8, DIAGNOSTIC_EVENT_LIMIT = 15000;
  let running = false, generation = 0, timer = null, actionTimer = null, session = null, prefs = null;
  let inFlight = new Map(), queue = [], nextRequestAt = 0, flapEpoch = 0, gameNumber = 0;
  let last = null, lastFlap = 0, velocity = null, latencySamples = [], restartAt = null;
  let requests = 0, decisions = 0, lastLatency = null, best = 0, bestKey = '', runStartedAt = 0, lastPhysicsAt = null, frameIntervals = [];
  let diagnosticRuns = [], diagnosticRun = null, diagnosticSequence = 0, lastGameOverLogged = -1;
  const runTime = time => Math.max(0, time - runStartedAt);
  const hasRequestBudget = () => prefs.maxRequests === 0 || requests < prefs.maxRequests;
  const score = () => Number(game.querySelector('[data-score]')?.textContent || 0) || 0;
  const gameOver = () => Boolean(game.querySelector('[data-panel="over"]') && !game.querySelector('[data-panel="over"]').hidden);
  function logEvent(type, fields = {}) {
    if (!diagnosticRun) return;
    diagnosticRun.events.push({
      seq: ++diagnosticSequence, time_ms: Math.round(runTime(performance.now())), game: gameNumber,
      score: score(), flap_epoch: flapEpoch, type, ...fields
    });
    if (diagnosticRun.events.length > DIAGNOSTIC_EVENT_LIMIT) {
      diagnosticRun.events.splice(0, 1000);
      diagnosticRun.dropped_events += 1000;
    }
  }
  function latestCompletedDiagnosticRun() {
    return diagnosticRuns.filter(run => run.status !== 'running' && run.ended_at)
      .reduce((latest, run) => !latest || Date.parse(run.ended_at) >= Date.parse(latest.ended_at) ? run : latest, null);
  }
  async function copyLatestCompletedDiagnostics() {
    const run = latestCompletedDiagnosticRun();
    if (!run) { message.textContent = 'コピーできる終了済みログはありません。'; return; }
    const text = JSON.stringify({ format: 'jev-reflex-diagnostics-v1', ...run }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text; area.setAttribute('readonly', '');
      area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove();
      if (!copied) { message.textContent = '診断ログをコピーできませんでした。'; return; }
    }
    message.textContent = '最新の終了済み診断ログをコピーしました。';
  }
  function update() {
    startButton.disabled = running; stopButton.disabled = !running;
    stats.textContent = `スコア ${score()} ／ ベスト ${best} ／ API ${requests}/${prefs ? (prefs.maxRequests === 0 ? '無制限' : prefs.maxRequests) : '—'}回${prefs ? ` ／ ${prefs.requestIntervalMs}ms間隔` : ''}${lastLatency === null ? '' : ` ／ 応答 ${lastLatency}ms`}`;
  }
  function stop(reason = '停止しました。') {
    if (diagnosticRun?.status === 'running') {
      for (const item of inFlight.values()) logEvent('request_canceled', { request_id: item.id, reason: 'run_stopped' });
      diagnosticRun.status = 'stopped'; diagnosticRun.stop_reason = reason; diagnosticRun.final_score = score(); diagnosticRun.ended_at = new Date().toISOString();
      logEvent('run_stopped', { reason, final_score: score() });
    }
    running = false; generation++;
    cancelAnimationFrame(timer); timer = null; clearTimeout(actionTimer); actionTimer = null;
    inFlight.clear(); queue = []; last = null; restartAt = null;
    const oldSession = session; session = null;
    if (oldSession) send({ type: 'run:stop', id: oldSession }).catch(() => {});
    message.textContent = reason; update();
  }
  function flap() {
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 1 }));
    lastFlap = performance.now();
    velocity = -430 * (last?.frame.scale ?? Math.max(.7, Math.min(1.15, stage.clientHeight / 360)));
  }
  function resetTracking() {
    clearTimeout(actionTimer); actionTimer = null;
    last = null; lastPhysicsAt = null; frameIntervals = []; velocity = null; queue = []; flapEpoch = 0; restartAt = null;
    nextRequestAt = lastFlap + prefs.requestIntervalMs;
  }
  async function start() {
    if (running) return { ok: true };
    const epoch = ++generation;
    running = true; message.textContent = '設定を確認しています…'; update();
    try {
      const response = await send({ type: 'run:begin' });
      if (epoch !== generation) {
        if (response.ok) send({ type: 'run:stop', id: response.id }).catch(() => {});
        return { ok: false, error: '開始をキャンセルしました。' };
      }
      if (!response.ok) throw Error(response.error);
      session = response.id; prefs = response.config;
      runStartedAt = performance.now();
      requests = 0; decisions = 0; lastLatency = null; latencySamples = []; inFlight = new Map();
      diagnosticSequence = 0; lastGameOverLogged = -1;
      diagnosticRun = { id: crypto.randomUUID(), started_at: new Date().toISOString(), ended_at: null, model: prefs.model, interval_ms: prefs.requestIntervalMs, status: 'running', stop_reason: null, final_score: null, dropped_events: 0, events: [] };
      diagnosticRuns.push(diagnosticRun); if (diagnosticRuns.length > DIAGNOSTIC_RUN_LIMIT) diagnosticRuns.shift();
      logEvent('run_started', { max_in_flight: maxInFlight, max_late_ms: Math.min(maxLate, prefs.requestIntervalMs) });
      let restartedBeforeCalibration = false;
      if (gameOver()) {
        const retry = game.querySelector('[data-action="restart"]');
        if (retry) { retry.click(); restartedBeforeCalibration = true; logEvent('game_reset_before_calibration'); }
      }
      bestKey = `chofu-jev-best:${prefs.endpoint}|${prefs.model}`;
      try { best = Number(localStorage.getItem(bestKey) || 0) || 0; } catch { best = 0; }
      stage.scrollIntoView({ block: 'center', behavior: 'instant' }); stage.focus({ preventScroll: true });
      // Measure the connection before the initial standard game input. These
      // replies calibrate timing only and are never replayed as game actions.
      for (let index = 0; index < (prefs.maxRequests === 0 ? 3 : Math.min(3, prefs.maxRequests - 1)); index++) {
        message.textContent = `応答速度を確認しています… ${index + 1}/3`;
        const sampledAt = performance.now(), rect = stage.getBoundingClientRect();
        const frame = ChofuJev.observe(ctx.getImageData(0, 0, canvas.width, canvas.height), rect.width, rect.height);
        if (!frame) throw Error('ゲーム画面を読み取れませんでした。');
        const at = runTime(sampledAt);
        const state = ChofuJev.predictReflexState({
          screen: { height: frame.height }, player: { ...frame.player, velocityY: 0 }, game: { score: score() },
          physics: { gravity: 1500 * frame.scale, flapVelocity: -430 * frame.scale, speedX: 165 * frame.scale },
          next_obstacle: null, following_obstacle: null
        }, 0, at, 0, at, prefs.requestIntervalMs, 0, at);
        requests++; update();
        const requestId = crypto.randomUUID(), calibrationStartedAt = performance.now();
        logEvent('calibration_sent', { request_id: requestId, observation_ms: at });
        const answer = await send({ type: 'decide:reflex', id: session, request_id: requestId, sent_at: at, observation_time: at, target_time: at, predicted_latency: 0, flap_epoch: 0, state });
        if (epoch !== generation) return { ok: false, error: '開始をキャンセルしました。' };
        if (!answer?.ok) throw Error(answer?.error || 'Jevに接続できませんでした。');
        lastLatency = Math.round(performance.now() - sampledAt);
        logEvent('calibration_response', { request_id: requestId, latency_ms: Math.round(performance.now() - calibrationStartedAt), action_ignored: answer.action ?? null });
        latencySamples.push(lastLatency); decisions++;
      }

      if (latencySamples.length === 3) latencySamples.shift();
      const restart = game.querySelector('[data-action="restart"]');
      if (!restartedBeforeCalibration && gameOver() && restart) restart.click(); else flap();
      lastFlap = performance.now(); gameNumber = 1; resetTracking();
      logEvent('game_started', { calibration_samples: latencySamples.length });
      message.textContent = `${prefs.model}が操作します。要求間隔は${prefs.requestIntervalMs}msです。`;
      update(); timer = requestAnimationFrame(tick); return { ok: true };
    } catch (error) { if (epoch === generation) stop(error.message); return { ok: false, error: error.message }; }
  }
  function scheduleAction() {
    clearTimeout(actionTimer); actionTimer = null;
    if (!running || !queue.length) return;
    actionTimer = setTimeout(() => { actionTimer = null; apply(performance.now()); }, Math.max(0, queue[0].targetAt - performance.now()));
  }
  function apply(now) {
    let flapped = false;
    while (queue.length && queue[0].targetAt <= now) {
      const item = queue.shift();
      const reason = item.gameNumber !== gameNumber ? 'game_changed' : ChofuJev.reflexDiscardReason({ flap_epoch: item.epoch, target_at: item.targetAt }, flapEpoch, now, gameOver(), Math.min(maxLate, prefs.requestIntervalMs));
      if (reason) { logEvent('response_discarded', { request_id: item.id, reason, action: item.action, target_lateness_ms: Math.round(now - item.targetAt) }); continue; }
      logEvent('decision_applied', { request_id: item.id, action: item.action, target_lateness_ms: Math.round(now - item.targetAt) });
      if (item.action === 'FLAP') {
        flap(); flapEpoch++; flapped = true;
        logEvent('flap_executed', { request_id: item.id });
        for (const pending of queue) if (pending.epoch !== flapEpoch) logEvent('response_discarded', { request_id: pending.id, reason: 'superseded', action: pending.action, invalidated_by: item.id });
        queue = queue.filter(value => value.epoch === flapEpoch);
        nextRequestAt = Math.min(nextRequestAt, now);
      }
      message.textContent = `${prefs.model}：${item.action}`;
    }
    scheduleAction();
    return flapped;
  }
  function request(frame, sampledAt) {
    const sentAt = performance.now(), interval = prefs.requestIntervalMs;
    if (sentAt < nextRequestAt) return;
    nextRequestAt += (Math.floor((sentAt - nextRequestAt) / interval) + 1) * interval;
    if (!hasRequestBudget() || inFlight.size >= maxInFlight) return;
    const latency = ChofuJev.estimateLatency(latencySamples);
    // One startup spike must not push every target far beyond the typical
    // connection. Preserve at most one request interval of extra lead.
    const predictedLatency = Math.min(latency.cautious_ms, latency.typical_ms + interval);
    const targetAt = sentAt + predictedLatency;
    const upcoming = frame.obstacles.filter(o => o.x + o.width >= frame.player.x - frame.player.radius).sort((a,b) => a.x-b.x).slice(0,2);
    const state = ChofuJev.predictReflexState({
      screen: { height: frame.height }, player: { ...frame.player, velocityY: velocity },
      game: { score: score() },
      physics: { gravity: 1500*frame.scale, flapVelocity: -430*frame.scale, speedX: 165*frame.scale, max_frame_step_ms: 50, obstacle_radius_factor: .9, frame_interval_ms: frameIntervals.length ? [...frameIntervals].sort((a,b)=>a-b)[Math.floor(frameIntervals.length / 2)] : 1000 / 60 },
      next_obstacle: upcoming[0] ?? null, following_obstacle: upcoming[1] ?? null
    }, Math.max(0,targetAt-sampledAt), runTime(targetAt), predictedLatency, runTime(sampledAt), interval, flapEpoch, runTime(lastFlap));
    const item = { id: crypto.randomUUID(), epoch: flapEpoch, gameNumber, targetAt, generation, session };
    inFlight.set(item.id,item); requests++; update();
    logEvent('request_sent', { request_id: item.id, observation_ms: Math.round(runTime(sampledAt)), sent_ms: Math.round(runTime(sentAt)), target_ms: Math.round(runTime(targetAt)), predicted_latency_ms: Math.round(predictedLatency), in_flight: inFlight.size });
    send({ type: 'decide:reflex', id: session, request_id: item.id, sent_at: runTime(sentAt), observation_time: runTime(sampledAt), target_time: runTime(targetAt), predicted_latency: predictedLatency, flap_epoch: flapEpoch, state })
      .then(response => {
        if (!running || item.generation !== generation || item.session !== session) return;
        inFlight.delete(item.id);
        lastLatency = Math.round(performance.now() - sentAt);
        if (!response?.ok) { logEvent('response_error', { request_id: item.id, latency_ms: lastLatency, failure_class: response?.failure_class ?? 'unknown' }); stop(response?.error || 'Jevに接続できませんでした。'); return; }
        latencySamples.push(lastLatency); if (latencySamples.length>20) latencySamples.shift(); decisions++;
        logEvent('response_received', { request_id: item.id, latency_ms: lastLatency, target_lateness_ms: Math.round(performance.now() - item.targetAt), action: response.action });
        const reason = item.gameNumber !== gameNumber ? 'game_changed' : ChofuJev.reflexDiscardReason({flap_epoch:item.epoch,target_at:item.targetAt},flapEpoch,performance.now(),gameOver(),Math.min(maxLate,prefs.requestIntervalMs));
        if (reason) logEvent('response_discarded', { request_id: item.id, reason, action: response.action, target_lateness_ms: Math.round(performance.now() - item.targetAt) });
        else {
          logEvent('response_accepted', { request_id: item.id, action: response.action, wait_until_target_ms: Math.max(0, Math.round(item.targetAt - performance.now())) });
          queue.push({ ...item, action: response.action }); queue.sort((a,b)=>a.targetAt-b.targetAt); apply(performance.now());
        }
        update();
      }).catch(error => {
        if (running && item.generation===generation) { logEvent('response_error', { request_id: item.id, failure_class: error?.failureClass ?? 'unknown' }); stop(error.message); }
      });
  }
  function tick(frameAt) {
    if (!running) return;
    try {
      const rect = stage.getBoundingClientRect();
      if (!stage.isConnected || !canvas.isConnected) { stop('ゲームが見つからなくなったため停止しました。'); return; }
      if (document.hidden || rect.bottom < rect.height*.2 || rect.top > innerHeight-rect.height*.2) { stop('ゲームが画面外になったため停止しました。'); return; }
      const currentScore = score();
      if (currentScore>best) { best=currentScore; try { localStorage.setItem(bestKey,String(best)); } catch {} }
      if (gameOver()) {
        for (const pending of queue) logEvent('response_discarded', { request_id: pending.id, reason: 'game_over', action: pending.action });
        queue=[];
        if (lastGameOverLogged !== gameNumber) { lastGameOverLogged = gameNumber; logEvent('game_over', { final_score: currentScore }); }
        if (!prefs.autoRestart) { stop(`ゲーム終了：${currentScore}点。開始で再挑戦できます。`); return; }
        if (!inFlight.size && !hasRequestBudget()) { stop('API呼び出し上限に達したため停止しました。'); return; }
        restartAt ??= performance.now()+650;
        message.textContent = `${currentScore}点で終了。再挑戦します…`;
        if (performance.now()>=restartAt && !inFlight.size) {
          game.querySelector('[data-action="restart"]')?.click(); lastFlap=performance.now(); gameNumber++; resetTracking(); logEvent('game_restarted');
        }
        update(); timer=requestAnimationFrame(tick); return;
      }
      const scale = Math.max(.7, Math.min(1.15, rect.height / 360));
      if (last && (Math.abs(rect.width-last.frame.width)>3 || Math.abs(rect.height-last.frame.height)>3)) { stop('画面サイズが変わったため停止しました。'); return; }
      if (lastPhysicsAt === null) {
        const frame = ChofuJev.observe(ctx.getImageData(0,0,canvas.width,canvas.height),rect.width,rect.height);
        if (!frame) throw Error('ゲーム画面を読み取れませんでした。');
        const gravity = 1500 * scale, impulse = -430 * scale;
        const discriminant = impulse ** 2 + 4 * gravity * (frame.player.y - frame.height / 2);
        const elapsed = discriminant >= 0 ? (-impulse - Math.sqrt(discriminant)) / (2 * gravity) : 0;
        velocity = impulse + gravity * Math.max(0, Math.min(.05, elapsed));
        last = { time: frameAt, frame };
      } else {
        const wallStep = Math.max(0, frameAt - lastPhysicsAt);
        if (wallStep >= 3 && wallStep <= 500) { frameIntervals.push(wallStep); if (frameIntervals.length > 20) frameIntervals.shift(); }
        velocity += 1500 * scale * Math.min(.05, wallStep / 1000);
      }
      lastPhysicsAt = frameAt;
      const flapped = apply(performance.now());
      // Read Canvas only when sending a decision. At 100ms this avoids roughly
      // five out of six full pixel scans, especially costly on Retina displays.
      if (!flapped && performance.now() >= nextRequestAt && hasRequestBudget() && inFlight.size < maxInFlight) {
        const frame = ChofuJev.observe(ctx.getImageData(0,0,canvas.width,canvas.height),rect.width,rect.height);
        if (!frame) throw Error('ゲーム画面を読み取れませんでした。');
        last = { time: frameAt, frame };
        request(frame, frameAt);
      }
      update(); timer=requestAnimationFrame(tick);
    } catch (error) { stop(`読み取りエラー：${error.message}`); }
  }
  startButton.addEventListener('click',()=>void start()); stopButton.addEventListener('click',()=>stop());
  shadow.getElementById('diagnosticsCopy').addEventListener('click', () => copyLatestCompletedDiagnostics());
  window.addEventListener('pagehide',()=>stop());
  window.addEventListener('resize',()=>{if(running)stop('画面サイズが変わったため停止しました。');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden && running)stop('タブを離れたため停止しました。');});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && running)stop();});
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
    if(msg.type==='ui:status'){reply({ok:true,running,score:score(),best,requests,decisions,message:message.textContent});return false;}
    if(msg.type==='ui:diagnostics'){reply({ok:true,runs:diagnosticRuns});return false;}
    if(msg.type==='ui:stop'){stop();reply({ok:true});return false;}
    if(msg.type==='ui:start'){start().then(reply);return true;}
    return false;
  });
})();
