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
      <small id="stats">Jevが約50msごとにFLAP／WAITを判断します。</small>
      <textarea id="logData" aria-label="診断ログ" rows="10" readonly hidden></textarea>
    </div>`;
  game.before(host);
  const message = shadow.getElementById("message"), stats = shadow.getElementById("stats");
  const startButton = shadow.getElementById("start"), stopButton = shadow.getElementById("stop");
  const logButton = shadow.getElementById("log"), logData = shadow.getElementById("logData");
  const DECISION_INTERVAL_MS = 20, MAX_ACTION_LATENCY_MS = 900;
  const MAX_SCHEDULE_LATE_MS = 50;
  const REFLEX_REQUEST_INTERVAL_MS = ChofuJev.REFLEX_REQUEST_INTERVAL_MS;
  const REFLEX_MAX_IN_FLIGHT = ChofuJev.REFLEX_MAX_IN_FLIGHT;
  const REFLEX_MAX_LATE_MS = ChofuJev.REFLEX_MAX_LATE_MS;
  const LOG_INTERVAL_MS = 50, MAX_LOG_EVENTS = 2400;
  let running = false, generation = 0, timer = null, session = null, prefs = null;
  let last = null, lastFlap = 0, motionVelocity = null, pending = false, nextDecisionAt = 0;
  let latencySamples = [];
  let inflight = null, drainingSession = null, drainTimer = null;
  let requests = 0, decisions = 0, lastLatency = null, restartAt = null;
  let diagnosticEvents = [], runStartedAt = null, runStartedWall = null, lastLoggedAt = -Infinity, attemptNumber = 0;
  let diagnosticsTruncated = false, gameOverLogged = false;
  let best = 0, bestKey = "chofu-jev-best";
  let clickQueue = [], planExpiresAt = null, planAttempt = null, planGapStartedAt = null;
  let benchmark = null, metrics = null, episodeStartedAt = null, gameNumber = 0, runStoppedAt = null;
  let reflexInFlight = new Map(), reflexQueue = [], reflexNextRequestAt = 0, reflexFlapEpoch = 0, reflexLastAction = null;
  const score = () => Number(game.querySelector("[data-score]")?.textContent || 0) || 0;
  const gameIsOver = () => {
    const panel = game.querySelector('[data-panel="over"]');
    return Boolean(panel && !panel.hidden);
  };
  function showStats() {
    const currentInFlight = prefs?.mode === "jev-reflex-neutral" ? reflexInFlight.size : Number(pending);
    const reflex = prefs?.mode === "jev-reflex-neutral" ? ` ／ 並列 ${currentInFlight}/${REFLEX_MAX_IN_FLIGHT}` : "";
    stats.textContent = `スコア ${score()} ／ ベスト ${best} ／ Jev判断 ${decisions}回 ／ API ${requests}/${prefs?.maxRequests ?? 200}回${reflex}${lastLatency === null ? "" : ` ／ ${lastLatency}ms`}`;
  }
  function record(type, detail = {}) {
    if (runStartedAt === null) return;
    if (metrics) {
      if (type === "request") metrics.requests++;
      if (type === "reflex_request") {
        metrics.requests++;
        if (metrics.reflex) {
          metrics.reflex.requests_sent++;
          metrics.reflex.max_observed_in_flight = Math.max(metrics.reflex.max_observed_in_flight, detail.in_flight ?? 0);
        }
      }
      if (type === "request_skipped" && metrics.reflex) metrics.reflex.request_skips += detail.count ?? 1;
      if (type === "reflex_invalidation" && metrics.reflex) metrics.reflex.invalidated_requests++;
      if (type === "reflex_result" && metrics.reflex) {
        if (detail.discard_reason === "superseded") metrics.reflex.superseded_responses++;
        if (detail.discard_reason === "stale") metrics.reflex.stale_responses++;
        if (detail.discard_reason === "game_over") metrics.reflex.game_over_responses++;
        if (detail.action === "FLAP") metrics.reflex.flap_decisions++;
        if (detail.action === "WAIT") metrics.reflex.wait_decisions++;
        if (detail.confidence !== null && detail.confidence !== undefined) metrics.reflex.confidence_samples.push(detail.confidence);
        if (detail.executed && detail.action === "FLAP") metrics.reflex.flaps_executed++;
        if (detail.executed && detail.action === "WAIT") metrics.reflex.waits_applied++;
        if (detail.executed && detail.execution_lateness_ms > 0) metrics.reflex.late_decisions++;
      }
      if (type === "reflex_request_error" && metrics.reflex) {
        metrics.reflex.request_errors++;
        metrics.reflex.failure_classes[detail.failure_class ?? "unknown"] = (metrics.reflex.failure_classes[detail.failure_class ?? "unknown"] ?? 0) + 1;
      }
      if (type === "response" || type === "response_after_game_over") {
        metrics.latencies_ms.push(detail.end_to_end_ms);
        metrics.resolved_models[detail.model] = (metrics.resolved_models[detail.model] ?? 0) + 1;
        if (metrics.reflex && Number.isFinite(detail.latency_ms)) metrics.reflex.api_latencies_ms.push(detail.latency_ms);
        if (type === "response_after_game_over") metrics.late_responses++;
        else { metrics.decisions++; const choice = detail.plan ?? detail.action; metrics.choices[choice] = (metrics.choices[choice] ?? 0) + 1; }
      }
      if (type === "plan_accepted") metrics.planned_clicks += detail.click_offsets_ms.length;
      if (type === "plan_cancelled" && detail.reason === "replaced") metrics.superseded_clicks += detail.cancelled_clicks.length;
      if (type === "plan_cancelled" && detail.reason !== "replaced") metrics.terminated_clicks += detail.cancelled_clicks.length;
      if (type === "scheduled_click_missed") metrics.missed_clicks++;
      if (["request_error", "request_error_after_game_over", "reflex_request_error"].includes(type)) metrics.request_errors++;
      if (type === "plan_underrun") metrics.plan_underruns++;
      if (type === "plan_gap_closed") metrics.plan_gap_ms += detail.duration_ms;
      if (type === "click" && ["jev", "jev-plan", "jev-reflex-neutral"].includes(detail.source)) metrics.executed_clicks++;
      if (type === "scheduled_click_executed") metrics.execution_delays_ms.push(detail.late_ms);
      if (type === "manual_input") metrics.manual_inputs++;
      if (type === "game_over") metrics.games.push({ game: gameNumber, score: detail.score, survival_ms: detail.survival_ms, ended: "game_over" });
      if (type === "stop" && episodeStartedAt !== null && !gameOverLogged) {
        metrics.games.push({ game: gameNumber, score: detail.score, survival_ms: Math.round(performance.now() - episodeStartedAt), ended: "stopped", reason: detail.reason });
        episodeStartedAt = null;
      }
    }
    diagnosticEvents.push({ t_ms: Math.round(performance.now() - runStartedAt), type, ...detail });
    if (diagnosticEvents.length > MAX_LOG_EVENTS) { diagnosticEvents.shift(); diagnosticsTruncated = true; }
    logButton.disabled = drainingSession !== null;
  }
  const send = msg => chrome.runtime.sendMessage(msg);
  function controls() { startButton.disabled = running; stopButton.disabled = !running && drainingSession === null; logButton.disabled = diagnosticEvents.length === 0 || drainingSession !== null; }
  function stop(reason = "停止しました。", retainResponse = false) {
    clearTimeout(drainTimer); drainTimer = null;
    const now = performance.now();
    const reflexMode = prefs?.mode === "jev-reflex-neutral";
    if (running) runStoppedAt = now;
    clearPlan("stop");
    const hasPending = reflexMode ? reflexInFlight.size > 0 : Boolean(inflight);
    record("stop", {
      reason, score: score(), pending: hasPending,
      inflight_elapsed_ms: inflight ? Math.round(now - inflight.startedAt) : null,
      inflight_request_ids: reflexMode ? [...reflexInFlight.keys()] : undefined
    });
    if (reflexMode) discardReflexQueue(retainResponse ? "game_over" : "stopped", now);
    drainingSession = retainResponse && hasPending ? session : null;
    generation++;
    running = false;
    cancelAnimationFrame(timer); timer = null;
    last = null; pending = false; nextDecisionAt = 0;
    controls(); message.textContent = reason + (drainingSession ? " 診断用の応答を待っています…" : ""); showStats();
    if (!drainingSession) {
      inflight = null;
      if (reflexMode) {
        for (const request of reflexInFlight.values()) record("reflex_request_terminated", {
          request_id: request.request_id, discard_reason: retainResponse ? "game_over" : "stopped",
          flap_epoch: request.flap_epoch
        });
        reflexInFlight.clear(); reflexQueue = [];
      }
      send({ type: "run:stop", id: session }).catch(() => {});
    } else {
      const retainedSession = drainingSession;
      drainTimer = setTimeout(() => {
        if (drainingSession === retainedSession) {
          record("diagnostic_wait_timeout", { limit_ms: 3000 });
          if (reflexMode) {
            for (const request of reflexInFlight.values()) record("reflex_request_terminated", {
              request_id: request.request_id, discard_reason: "game_over", flap_epoch: request.flap_epoch,
              reason: "diagnostic_wait_timeout"
            });
            reflexInFlight.clear();
            drainingSession = null;
            send({ type: "run:stop", id: retainedSession }).catch(() => {});
            message.textContent = "ゲーム終了。診断用の応答待ちも終了しました。ログをコピーできます。";
            controls(); showStats();
          } else stop("ゲーム終了。診断用の応答待ちも終了しました。ログをコピーできます。");
        }
      }, 3000);
    }
  }
  function flap(source = "jev-reflex-neutral") {
    stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, buttons: 1 }));
    lastFlap = performance.now();
    motionVelocity = -430 * (last?.frame.scale ?? Math.max(0.7, Math.min(1.15, stage.clientHeight / 360)));
    record("click", { source, score: score() });
  }
  function closePlanGap(now, reason) {
    if (planGapStartedAt === null) return;
    record("plan_gap_closed", { reason, duration_ms: Math.round(now - planGapStartedAt) });
    planGapStartedAt = null;
  }
  function clearPlan(reason, now = performance.now()) {
    if (planExpiresAt !== null || clickQueue.length) record("plan_cancelled", {
      attempt: planAttempt, reason,
      cancelled_clicks: clickQueue.map(click => ({ attempt: click.attempt, due_at_ms: Math.round(click.dueAt - runStartedAt) }))
    });
    clickQueue = []; planExpiresAt = null; planAttempt = null;
    closePlanGap(now, reason);
  }
  function expirePlan(now) {
    if (planExpiresAt === null || now < planExpiresAt) return;
    const budgetEnded = requests >= prefs.maxRequests && !pending;
    record(budgetEnded ? "final_plan_completed" : "plan_underrun", { attempt: planAttempt, pending, expired_at_ms: Math.round(planExpiresAt - runStartedAt) });
    planGapStartedAt = budgetEnded ? null : planExpiresAt; planExpiresAt = null; planAttempt = null;
  }
  function acceptPlan(response, attempt, receivedAt) {
    expirePlan(receivedAt);
    clearPlan("replaced", receivedAt);
    planAttempt = attempt; planExpiresAt = receivedAt + ChofuJev.PLAN_HORIZON_MS;
    clickQueue = response.clickOffsetsMs.map(offset => ({ dueAt: receivedAt + offset, attempt, offset }));
    record("plan_accepted", {
      attempt, plan: response.plan, click_offsets_ms: response.clickOffsetsMs,
      starts_at_ms: Math.round(receivedAt - runStartedAt), expires_at_ms: Math.round(planExpiresAt - runStartedAt)
    });
  }
  function executePlan(now) {
    let clicked = false;
    while (clickQueue.length && clickQueue[0].dueAt <= now) {
      const click = clickQueue.shift(), late = now - click.dueAt;
      const detail = { attempt: click.attempt, offset_ms: click.offset, due_at_ms: Math.round(click.dueAt - runStartedAt), late_ms: Math.round(late * 100) / 100 };
      if (late > MAX_SCHEDULE_LATE_MS) { record("scheduled_click_missed", detail); continue; }
      flap("jev-plan"); clicked = true;
      record("scheduled_click_executed", { ...detail, late_ms: Math.round((lastFlap - click.dueAt) * 100) / 100, executed_at_ms: Math.round(lastFlap - runStartedAt) });
    }
    expirePlan(now);
    return clicked;
  }
  function resetTracking() {
    clearPlan("restart");
    last = null; motionVelocity = null; pending = false; nextDecisionAt = 0; restartAt = null;
    reflexInFlight = new Map(); reflexQueue = []; reflexNextRequestAt = 0; reflexFlapEpoch = 0; reflexLastAction = null;
  }
  async function start() {
    if (running) return { ok: true };
    if (drainingSession) stop("新しい試行のため診断用の応答待ちを中断しました。");
    const epoch = ++generation;
    running = true; controls(); message.textContent = "設定を確認しています…";
    try {
      const response = await send({ type: "run:begin" });
      if (epoch !== generation) return { ok: false, error: "開始をキャンセルしました。" };
      if (!response.ok) throw new Error(response.error);
      session = response.id; prefs = response.config; requests = 0; decisions = 0; lastLatency = null;
      latencySamples = [];
      bestKey = `chofu-jev-best:${prefs.mode === "local" ? "local" : `${prefs.mode === "jev-plan" ? "jev-plan|" : ""}${prefs.endpoint}|${prefs.model}`}`;
      best = 0;
      try { best = Number(localStorage.getItem(bestKey) || 0) || 0; } catch {}
      resetTracking();
      diagnosticEvents = []; runStartedAt = performance.now(); runStartedWall = new Date().toISOString();
      lastLoggedAt = -Infinity; attemptNumber = 0; diagnosticsTruncated = false; gameOverLogged = false;
      metrics = { requests: 0, request_errors: 0, decisions: 0, late_responses: 0, latencies_ms: [], resolved_models: {}, choices: {},
        planned_clicks: 0, executed_clicks: 0, superseded_clicks: 0, terminated_clicks: 0, missed_clicks: 0, execution_delays_ms: [],
        plan_underruns: 0, plan_gap_ms: 0, manual_inputs: 0, games: [],
        ...(prefs.mode === "jev-reflex-neutral" ? { reflex: {
          request_interval_ms: REFLEX_REQUEST_INTERVAL_MS, max_in_flight: REFLEX_MAX_IN_FLIGHT,
          max_late_response_ms: REFLEX_MAX_LATE_MS, requests_sent: 0, request_skips: 0, request_errors: 0,
          failure_classes: {}, flap_decisions: 0, wait_decisions: 0, flaps_executed: 0, waits_applied: 0,
          confidence_samples: [], api_latencies_ms: [], max_observed_in_flight: 0,
          invalidated_requests: 0, superseded_responses: 0, stale_responses: 0, game_over_responses: 0, late_decisions: 0
        } } : {}) };
      gameNumber = 0; episodeStartedAt = null; runStoppedAt = null;
      const questions = prefs.mode === "jev-plan" ? ChofuJev.buildPlanRequest(null, prefs.model).questions
        : prefs.mode === "jev" ? ChofuJev.buildRequest(null, prefs.model).questions
          : prefs.mode === "jev-reflex-neutral" ? ChofuJev.buildReflexRequest(null, prefs.model).questions : null;
      const digest = questions ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(questions))) : null;
      if (epoch !== generation) return { ok: false, error: "開始をキャンセルしました。" };
      benchmark = {
        protocol: prefs.mode === "jev-plan" ? "scheduled-observed-state-v1" : prefs.mode === "jev" ? "observed-state-v1"
          : prefs.mode === "jev-reflex-neutral" ? "jev-reflex-neutral-v1" : "local",
        mode: prefs.mode, endpoint: prefs.endpoint, requested_model: prefs.model,
        questions_sha256: digest ? [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("") : null,
        questions, max_requests: prefs.maxRequests, auto_restart: prefs.autoRestart,
        realtime: true, random_obstacles: true, initial_input: "standard game start/restart",
        controller: prefs.mode === "jev-plan" ? {
          horizon_ms: ChofuJev.PLAN_HORIZON_MS, slot_ms: ChofuJev.PLAN_SLOT_MS, replan_after_ms: ChofuJev.PLAN_REPLAN_MS,
          options: ChofuJev.planOptions, anchor: "answer-arrival", replacement: "cancel remaining old clicks on answer arrival",
          expired_plan: "no input", max_execution_late_ms: MAX_SCHEDULE_LATE_MS
        } : prefs.mode === "jev" ? { decision_interval_ms: DECISION_INTERVAL_MS, stale_response_stop_ms: MAX_ACTION_LATENCY_MS }
          : prefs.mode === "jev-reflex-neutral" ? {
            request_interval_ms: REFLEX_REQUEST_INTERVAL_MS, max_in_flight: REFLEX_MAX_IN_FLIGHT,
            target: "predicted answer application time", prediction: "semi-implicit physics extrapolation at 60Hz",
            max_late_response_ms: REFLEX_MAX_LATE_MS, flap_epoch_supersession: true,
            request_cap_behavior: "skip requests and keep real-time game running"
          } : { policy: "local middle-of-gap control", api: false },
        stage: { width: stage.clientWidth, height: stage.clientHeight },
        canvas: { width: canvas.width, height: canvas.height },
        user_agent: navigator.userAgent, device_pixel_ratio: devicePixelRatio
      };
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
      episodeStartedAt = lastFlap; gameNumber++;
      if (prefs.mode === "jev-plan") planGapStartedAt = lastFlap;
      if (prefs.mode === "jev-reflex-neutral") reflexNextRequestAt = lastFlap + REFLEX_REQUEST_INTERVAL_MS;
      message.textContent = prefs.mode === "jev-plan" ? `${prefs.model}が固定のクリック予定を選択しています（実験）。`
        : prefs.mode === "jev" ? `${prefs.model}がクリックか待機を判断しています。`
          : prefs.mode === "jev-reflex-neutral" ? `${prefs.model}へ50msごとに中立なFLAP／WAIT判断を要求しています。`
            : "ローカルテスト中（Jev APIは使用していません）。";
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
      decision_interval_ms: prefs.mode === "jev-plan" ? ChofuJev.PLAN_REPLAN_MS : DECISION_INTERVAL_MS,
      sample_age_ms: sampleAge,
      ...(prefs.mode === "jev-plan" ? { planning: {
        pending_clicks_ms: clickQueue.map(click => Math.max(0, click.dueAt - sampledAt)),
        current_plan_remaining_ms: Math.max(0, Math.min(ChofuJev.PLAN_HORIZON_MS, (planExpiresAt ?? sampledAt) - sampledAt))
      } } : {})
    };
  }
  async function ask(frame, velocity, sampledAt) {
    const epoch = generation;
    const askedSession = session, diagnosticRun = runStartedWall;
    pending = true;
    const attempt = ++attemptNumber;
    const requestStartedAt = performance.now();
    inflight = { session: askedSession, attempt, startedAt: requestStartedAt, phase: null };
    let state, diagnosticState = null;
    try {
      state = decisionState(frame, velocity, sampledAt);
      diagnosticState = prefs.mode === "jev-plan" ? ChofuJev.sanitizePlanState(state) : ChofuJev.sanitizeState(state);
      record("request", { attempt, state: diagnosticState });
      const response = await send({ type: "decide", id: askedSession, attempt, state });
      const receivedAt = performance.now();
      const ended = game.querySelector('[data-panel="over"]')?.hidden === false;
      if (epoch !== generation || !running || ended) {
        if ((drainingSession === askedSession || (epoch === generation && running && ended)) && diagnosticRun === runStartedWall) {
          if (epoch === generation && running && ended) recordGameOver(receivedAt);
          const elapsed = Math.round(performance.now() - requestStartedAt);
          if (response.ok) {
            requests = response.requests;
            record("response_after_game_over", {
              attempt, action: response.action, plan: response.plan, click_offsets_ms: response.clickOffsetsMs,
              confidence: response.confidence, probabilities: response.probabilities,
              model: response.model, api_latency_ms: response.latencyMs, end_to_end_ms: elapsed,
              requests, executed: false
            });
            message.textContent = `ゲーム終了。終了後に届いた応答（${elapsed}ms）をログへ記録しました。`;
          } else {
            record("request_error_after_game_over", { attempt, error: response.error, end_to_end_ms: elapsed });
            message.textContent = "ゲーム終了。応答待ちの終了理由をログへ記録しました。";
          }
          showStats();
          if (epoch === generation && running && (!response.ok || requests >= prefs.maxRequests)) {
            stop(response.ok ? "API呼び出し上限に達したため停止しました。" : response.error);
          }
        }
        return;
      }
      if (!response.ok) throw new Error(response.error);
      const elapsed = receivedAt - requestStartedAt;
      requests = response.requests; lastLatency = response.latencyMs;
      latencySamples.push(elapsed);
      if (latencySamples.length > 20) latencySamples.shift();
      const observation = last ? {
        sampled_at_ms: Math.round((last.time - runStartedAt) * 100) / 100,
        age_ms: Math.round((performance.now() - last.time) * 100) / 100,
        player_y: last.y, player_velocity_y: Math.round(last.velocity * 100) / 100,
        ...(prefs.mode === "jev" ? { predicted_y_at_same_sample: Math.round((state.player.y + state.player.velocityY * (last.time - sampledAt) / 1000 + 0.5 * state.physics.gravity * ((last.time - sampledAt) / 1000) ** 2) * 100) / 100 } : {}),
        pending_clicks_ms: clickQueue.map(click => Math.max(0, click.dueAt - receivedAt))
      } : null;
      record("response", {
        attempt, action: response.action, plan: response.plan, click_offsets_ms: response.clickOffsetsMs, confidence: response.confidence,
        probabilities: response.probabilities,
        model: response.model, api_latency_ms: response.latencyMs,
        end_to_end_ms: Math.round(elapsed), requests, observation_at_response: observation
      });
      if (prefs.mode === "jev" && elapsed > MAX_ACTION_LATENCY_MS) {
        stop(`Jevの応答が${MAX_ACTION_LATENCY_MS}msを超えたため、古い判断を実行せず停止しました。`);
        return;
      }
      decisions++;
      if (prefs.mode === "jev-plan") {
        acceptPlan(response, attempt, receivedAt);
        nextDecisionAt = receivedAt + ChofuJev.PLAN_REPLAN_MS;
        message.textContent = `Jev: ${response.clickOffsetsMs.length ? response.clickOffsetsMs.join(" / ") + "ms にクリック" : "800ms待機"} ／ ${response.model === "unknown" ? prefs.model : response.model}`;
        showStats(); return;
      }
      const over = game.querySelector('[data-panel="over"]');
      if (response.action === "click" && over?.hidden !== false) flap("jev");
      record("action", { attempt, action: response.action, executed: response.action !== "click" || over?.hidden !== false, score: score() });
      const actionLabel = response.action === "click" ? "クリック" : "待機";
      message.textContent = `Jev: ${actionLabel}${response.confidence === null ? "" : ` ／ 信頼度 ${Math.round(response.confidence * 100)}%`} ／ ${response.model === "unknown" ? prefs.model : response.model}`;
      showStats();
      if (requests >= prefs.maxRequests) stop("API呼び出し上限に達したため停止しました。");
    } catch (error) {
      if (diagnosticRun === runStartedWall && (epoch === generation || drainingSession === askedSession)) {
        record(epoch === generation ? "request_error" : "request_error_after_game_over", { attempt, error: error.message, end_to_end_ms: Math.round(performance.now() - requestStartedAt), state: diagnosticState });
      }
      if (epoch === generation && running) stop(error.message);
      else if (drainingSession === askedSession && diagnosticRun === runStartedWall) message.textContent = "ゲーム終了。応答待ちのエラーをログへ記録しました。";
    } finally {
      if (inflight?.session === askedSession && inflight.attempt === attempt) inflight = null;
      if (drainingSession === askedSession) {
        clearTimeout(drainTimer); drainTimer = null;
        drainingSession = null;
        send({ type: "run:stop", id: askedSession }).catch(() => {});
        controls();
      }
      if (epoch === generation) {
        pending = false;
        if (prefs.mode !== "jev-plan") nextDecisionAt = performance.now() + DECISION_INTERVAL_MS;
      }
    }
  }
  const runTime = time => Math.round((time - runStartedAt) * 100) / 100;
  function discardReflexDecision(item, reason, now, extra = {}) {
    record("reflex_result", {
        request_id: item.request_id, action: item.action, choice: item.action, confidence: item.confidence,
      probabilities: item.probabilities, resolved_model: item.model,
      observation_time: item.observation_time, target_time: item.target_time,
      received_at: item.received_at, flap_epoch: item.flap_epoch,
      executed: false, discard_reason: reason, discarded_at: runTime(now), ...extra
    });
  }
  function discardReflexQueue(reason, now = performance.now(), predicate = () => true) {
    const kept = [];
    for (const item of reflexQueue) {
      if (predicate(item)) discardReflexDecision(item, reason, now);
      else kept.push(item);
    }
    reflexQueue = kept;
  }
  function applyReflexQueue(now) {
    let flapped = false;
    while (reflexQueue.length && reflexQueue[0].target_at <= now) {
      const item = reflexQueue.shift();
      const reason = ChofuJev.reflexDiscardReason(
        { flap_epoch: item.flap_epoch, target_at: item.target_at },
        reflexFlapEpoch, now,
        gameOverLogged || gameIsOver() || item.game_number !== gameNumber,
        REFLEX_MAX_LATE_MS
      );
      if (reason) { discardReflexDecision(item, reason, now); continue; }
      const executedAt = performance.now();
      const lateness = Math.max(0, executedAt - item.target_at);
      if (item.action === "FLAP") {
        const previousEpoch = reflexFlapEpoch;
        flap("jev-reflex-neutral");
        reflexFlapEpoch++;
        reflexNextRequestAt = Math.min(reflexNextRequestAt, executedAt);
        flapped = true;
        reflexLastAction = { request_id: item.request_id, action: item.action, executed_at: runTime(executedAt), flap_epoch: reflexFlapEpoch };
        record("reflex_result", {
          request_id: item.request_id, action: item.action, choice: item.action, confidence: item.confidence,
          probabilities: item.probabilities, resolved_model: item.model,
          observation_time: item.observation_time, target_time: item.target_time,
          received_at: item.received_at, executed: true, executed_at: runTime(executedAt),
          execution_lateness_ms: Math.round(lateness * 100) / 100,
          flap_epoch: previousEpoch, next_flap_epoch: reflexFlapEpoch
        });
        discardReflexQueue("superseded", executedAt, queued => queued.flap_epoch === previousEpoch);
        for (const request of reflexInFlight.values()) {
          if (request.flap_epoch === previousEpoch) {
            request.superseded = true;
            record("reflex_invalidation", {
              request_id: request.request_id, flap_epoch: previousEpoch,
              superseded_by_epoch: reflexFlapEpoch, invalidated_at: runTime(executedAt)
            });
          }
        }
      } else {
        reflexLastAction = { request_id: item.request_id, action: item.action, executed_at: runTime(executedAt), flap_epoch: reflexFlapEpoch };
        record("reflex_result", {
          request_id: item.request_id, action: item.action, choice: item.action, confidence: item.confidence,
          probabilities: item.probabilities, resolved_model: item.model,
          observation_time: item.observation_time, target_time: item.target_time,
          received_at: item.received_at, executed: true, executed_at: runTime(executedAt),
          execution_lateness_ms: Math.round(lateness * 100) / 100, flap_epoch: reflexFlapEpoch
        });
      }
      message.textContent = `Jev: ${item.action}${item.confidence === null ? "" : ` ／ 信頼度 ${Math.round(item.confidence * 100)}%`} ／ ${item.model === "unknown" ? prefs.model : item.model}`;
    }
    return flapped;
  }
  function requestReflex(frame, velocity, sampledAt) {
    const now = performance.now();
    if (now < reflexNextRequestAt) return;
    const missedSlots = Math.floor((now - reflexNextRequestAt) / REFLEX_REQUEST_INTERVAL_MS);
    reflexNextRequestAt += (missedSlots + 1) * REFLEX_REQUEST_INTERVAL_MS;
    if (missedSlots > 0) record("request_skipped", { reason: "frame_delay", count: missedSlots });
    if (requests >= prefs.maxRequests) {
      record("request_skipped", { reason: "max_requests" });
      return;
    }
    if (reflexInFlight.size >= REFLEX_MAX_IN_FLIGHT) {
      record("request_skipped", { reason: "max_in_flight", in_flight: reflexInFlight.size });
      return;
    }
    const sentAt = performance.now();
    const estimate = ChofuJev.estimateLatency(latencySamples);
    const predictedLatency = estimate.typical_ms;
    const targetAt = sentAt + predictedLatency;
    const thresholdX = frame.player.x - frame.player.radius;
    const upcoming = frame.obstacles
      .filter(obstacle => obstacle.x + obstacle.width >= thresholdX)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2);
    const observed = {
      screen: { height: frame.height },
      player: { x: frame.player.x, y: frame.player.y, velocityY: velocity, radius: frame.player.radius },
      physics: { gravity: 1500 * frame.scale, flapVelocity: -430 * frame.scale, speedX: 165 * frame.scale },
      next_obstacle: upcoming[0] ?? null,
      following_obstacle: upcoming[1] ?? null
    };
    const observationTime = runTime(sampledAt);
    const targetTime = runTime(targetAt);
    const state = ChofuJev.predictReflexState(
      observed, Math.max(0, targetAt - sampledAt), targetTime, predictedLatency
    );
    const request = {
      request_id: crypto.randomUUID(), session: session, generation,
      game_number: gameNumber, sent_at: sentAt, observation_at: sampledAt,
      target_at: targetAt, predicted_latency: predictedLatency,
      observation_time: observationTime, target_time: targetTime,
      flap_epoch: reflexFlapEpoch, state, in_flight: reflexInFlight.size + 1
    };
    requests++;
    reflexInFlight.set(request.request_id, request);
    pending = true;
    record("reflex_request", {
      request_id: request.request_id, sent_at: runTime(sentAt),
      observation_time: observationTime, target_time: targetTime,
      predicted_latency: predictedLatency, flap_epoch: request.flap_epoch,
      state_sent_to_jev: state, in_flight: request.in_flight
    });
    showStats();
    void send({
      type: "decide:reflex", id: request.session, request_id: request.request_id,
      sent_at: runTime(sentAt), observation_time: observationTime, target_time: targetTime,
      predicted_latency: predictedLatency, flap_epoch: request.flap_epoch, state
    }).then(response => completeReflexRequest(request, response, performance.now()))
      .catch(error => completeReflexRequest(request, { ok: false, error: error.message, failure_class: "harness" }, performance.now()));
  }
  function completeReflexRequest(request, response, receivedAt) {
    if (reflexInFlight.get(request.request_id) !== request) return;
    reflexInFlight.delete(request.request_id);
    pending = reflexInFlight.size > 0;
    const endToEnd = Math.max(0, receivedAt - request.sent_at);
    const gameOver = gameOverLogged || gameIsOver() || request.game_number !== gameNumber;
    try {
      if (response?.ok) {
        requests = Math.max(requests, response.requests ?? requests);
        lastLatency = response.latencyMs;
        latencySamples.push(endToEnd);
        if (latencySamples.length > 20) latencySamples.shift();
        const answer = {
          request_id: request.request_id, action: response.action,
          choice: response.action,
          confidence: response.confidence, probabilities: response.probabilities,
          model: response.model, resolved_model: response.model, latency_ms: response.latencyMs,
          end_to_end_ms: Math.round(endToEnd * 100) / 100,
          observation_time: request.observation_time, target_time: request.target_time,
          predicted_latency: request.predicted_latency, flap_epoch: request.flap_epoch,
          received_at: runTime(receivedAt), sent_at: runTime(request.sent_at)
        };
        record(gameOver ? "response_after_game_over" : "response", {
          ...answer, resolved_model: answer.model, action: answer.action, executed: false,
          requests, api_latency_ms: answer.latency_ms
        });
        decisions++;
        const discardReason = ChofuJev.reflexDiscardReason(
          { flap_epoch: request.flap_epoch, target_at: request.target_at },
          reflexFlapEpoch, receivedAt, gameOver, REFLEX_MAX_LATE_MS
        );
        if (discardReason) discardReflexDecision({ ...request, ...answer }, discardReason, receivedAt);
        else {
          reflexQueue.push({ ...request, ...answer, action: response.action, model: response.model });
          reflexQueue.sort((a, b) => a.target_at - b.target_at);
          applyReflexQueue(receivedAt);
        }
      } else {
        record("reflex_request_error", {
          request_id: request.request_id, sent_at: runTime(request.sent_at),
          observation_time: request.observation_time, target_time: request.target_time,
          predicted_latency: request.predicted_latency, flap_epoch: request.flap_epoch,
          received_at: runTime(receivedAt),
          end_to_end_ms: Math.round(endToEnd * 100) / 100,
          error: String(response?.error ?? "API応答を受け取れませんでした。").slice(0, 300),
          failure_class: response?.failure_class ?? "harness", after_game_over: gameOver
        });
      }
    } catch (error) {
      record("reflex_request_error", {
        request_id: request.request_id, sent_at: runTime(request.sent_at),
        observation_time: request.observation_time, target_time: request.target_time,
        predicted_latency: request.predicted_latency, flap_epoch: request.flap_epoch,
        received_at: runTime(receivedAt),
        end_to_end_ms: Math.round(endToEnd * 100) / 100,
        error: String(error?.message ?? error).slice(0, 300),
        failure_class: "harness", after_game_over: gameOver
      });
    }
    if (gameOver) showStats();
    if (drainingSession === request.session && reflexInFlight.size === 0) {
      clearTimeout(drainTimer); drainTimer = null;
      drainingSession = null;
      send({ type: "run:stop", id: request.session }).catch(() => {});
      controls();
    }
    showStats();
  }
  function recordGameOver(now) {
    if (gameOverLogged) return;
    const panel = game.querySelector('[data-panel="over"]');
    const reflex = prefs.mode === "jev-reflex-neutral";
    record("game_over", {
      score: score(), survival_ms: episodeStartedAt === null ? null : Math.round(now - episodeStartedAt),
      game_over_reason: panel?.textContent?.trim().slice(0, 200) || null,
      pending: reflex ? reflexInFlight.size > 0 : pending,
      last_latency_ms: lastLatency, inflight_attempt: inflight?.attempt ?? null,
      inflight_elapsed_ms: inflight ? Math.round(now - inflight.startedAt) : null,
      last_network_phase: inflight?.phase ?? null,
      inflight_request_ids: reflex ? [...reflexInFlight.keys()] : undefined,
      last_applied_reflex_action: reflex ? reflexLastAction : undefined,
      flap_epoch: reflex ? reflexFlapEpoch : undefined
    });
    gameOverLogged = true;
    if (reflex) discardReflexQueue("game_over", now);
    expirePlan(now); clearPlan("game_over", now);
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
        recordGameOver(now);
        showStats();
        if (!prefs.autoRestart) {
          const retain = prefs.mode === "jev-reflex-neutral" ? reflexInFlight.size > 0 : pending;
          stop(`ゲーム終了：${currentScore}点。開始で再挑戦できます。`, retain); return;
        }
        if (!pending && requests >= prefs.maxRequests) { stop("ゲーム終了。API呼び出し上限に達したため停止しました。"); return; }
        if (restartAt === null) { restartAt = now + 650; message.textContent = `${currentScore}点で終了。再挑戦します…`; }
        if (now >= restartAt && !pending) {
          game.querySelector('[data-action="restart"]')?.click(); lastFlap = now; record("restart", { source: "auto", score: currentScore }); resetTracking(); gameOverLogged = false;
          episodeStartedAt = performance.now(); gameNumber++;
          if (prefs.mode === "jev-plan") planGapStartedAt = episodeStartedAt;
          if (prefs.mode === "jev-reflex-neutral") reflexNextRequestAt = lastFlap + REFLEX_REQUEST_INTERVAL_MS;
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
      // v1.4.0 has one control path: only Jev's queued answer may cause a flap.
      // After applying a flap, observe its new trajectory on the next frame.
      const flapped = applyReflexQueue(performance.now());
      if (!flapped) requestReflex(frame, velocity, sampledAt);
      showStats(); timer = requestAnimationFrame(tick);
    } catch (error) { stop(`読み取りエラー：${error.message}`); }
  }
  startButton.addEventListener("click", () => void start());
  stopButton.addEventListener("click", () => stop());
  logButton.addEventListener("click", async () => {
    const payload = JSON.stringify({
      format: "chofu-jev-diagnostics-v1", extension_version: chrome.runtime.getManifest().version,
      started_at: runStartedWall, truncated: diagnosticsTruncated,
      benchmark,
      metrics: metrics ? { ...metrics, api_calls: requests,
        plan_gap_ms: metrics.plan_gap_ms + (planGapStartedAt === null ? 0 : Math.round(performance.now() - planGapStartedAt)),
        active_play_ms: metrics.games.reduce((total, item) => total + (item.survival_ms ?? 0), 0)
          + (running && !gameOverLogged && episodeStartedAt !== null ? Math.round(performance.now() - episodeStartedAt) : 0),
        elapsed_ms: Math.round((runStoppedAt ?? performance.now()) - runStartedAt), running } : null,
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
  stage.addEventListener("pointerdown", event => {
    if (running && event.isTrusted) record("manual_input", { kind: "pointer" });
  }, true);
  stage.addEventListener("keydown", event => {
    if (running && event.isTrusted && ["Space", "ArrowUp", "Enter"].includes(event.code)) record("manual_input", { kind: event.code });
  }, true);
  window.addEventListener("pagehide", () => stop());
  window.addEventListener("resize", () => { if (running) stop("画面サイズが変わったため停止しました。開始で再開できます。"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && (running || drainingSession)) stop("タブを離れたため停止しました。"); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && running) stop(); });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "decide:progress") {
      const reflexRequest = msg.request_id ? reflexInFlight.get(msg.request_id) : null;
      if (reflexRequest?.session === msg.id && (running || drainingSession === msg.id)) {
        reflexRequest.phase = msg.phase;
        requests = Math.max(requests, msg.requests ?? requests);
        record("reflex_network_phase", {
          request_id: msg.request_id, phase: msg.phase, worker_elapsed_ms: msg.elapsed_ms,
          body_bytes: msg.body_bytes, http_status: msg.http_status,
          in_flight: msg.in_flight, requests
        });
        showStats();
        reply({ ok: true }); return false;
      }
      if (inflight?.session === msg.id && inflight.attempt === msg.attempt && (running || drainingSession === msg.id)) {
        inflight.phase = msg.phase;
        requests = msg.requests;
        record("network_phase", { attempt: msg.attempt, phase: msg.phase, worker_elapsed_ms: msg.elapsed_ms, body_bytes: msg.body_bytes, http_status: msg.http_status, requests });
        showStats();
      }
      reply({ ok: true }); return false;
    }
    if (msg.type === "ui:status") { reply({ ok: true, running, score: score(), best, requests, decisions, message: message.textContent }); return false; }
    if (msg.type === "ui:stop") { stop(); reply({ ok: true }); return false; }
    if (msg.type === "ui:start") { start().then(reply); return true; }
    return false;
  });
})();
