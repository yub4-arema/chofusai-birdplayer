/* Shared, dependency-free game observation and TypeSafe API contract. */
(() => {
  "use strict";
  const isRed = (r, g, b, a) => a > 120 && r > 145 && r > g * 1.6 && r > b * 1.5;
  function observe(image, cssWidth, cssHeight) {
    const { data, width, height } = image;
    if (!width || !height || cssWidth < 1 || cssHeight < 1) return null;
    const rx = width / cssWidth, ry = height / cssHeight;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    const occupied = new Uint8Array(width);
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (isRed(data[i], data[i + 1], data[i + 2], data[i + 3])) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        } else if (data[i + 3] > 120) occupied[x] = 1;
      }
    }
    if (maxX < 0) return null;
    const scale = Math.max(0.7, Math.min(1.15, cssHeight / 360));
    const inset = Math.max(1, 2 * scale);
    const groups = [];
    for (let x = 0; x < width; x++) {
      if (!occupied[x]) continue;
      const left = x;
      while (x + 1 < width && occupied[x + 1]) x++;
      if ((x - left + 1) / rx > 6) groups.push([left, x]);
    }
    const obstacles = [];
    for (const [left, right] of groups) {
      const column = Math.floor((left + right) / 2);
      let bestStart = 0, bestEnd = 0, start = 0;
      for (let y = 0; y <= height; y++) {
        const i = (y * width + column) * 4;
        const filled = y === height || (data[i + 3] > 120 && !isRed(data[i], data[i + 1], data[i + 2], data[i + 3]));
        if (filled) {
          if (y - start > bestEnd - bestStart) { bestStart = start; bestEnd = y; }
          start = y + 1;
        }
      }
      const gapTop = bestStart / ry + inset;
      const gapBottom = bestEnd / ry - inset;
      if (gapBottom - gapTop < 35 * scale) continue;
      obstacles.push({
        x: left / rx - inset,
        width: (right - left + 1) / rx + inset * 2,
        gapTop, gapBottom
      });
    }
    return {
      width: cssWidth, height: cssHeight, scale,
      player: { x: (minX + maxX) / (2 * rx), y: (minY + maxY) / (2 * ry), radius: 13 * scale },
      obstacles: obstacles.sort((a, b) => a.x - b.x)
    };
  }
  function flapNeeded(frame, target, velocity, sinceFlap) {
    if (sinceFlap < 110) return false;
    const lookAhead = 0.02;
    const predicted = frame.player.y + velocity * lookAhead + 0.5 * 1500 * frame.scale * lookAhead ** 2;
    return predicted > target + 32 * frame.scale || predicted + frame.player.radius > frame.height - 5 * frame.scale;
  }
  function buildRequest(state, model) {
    return {
      model, state,
      questions: {
        action: {
          type: "choice",
          instructions: {
            task: "Should the player flap when this answer arrives, or wait until another answer? Choose ONLY click or wait. Predict motion and collisions yourself from the observed state, physics, boundaries, and timing. The extension executes your choice directly.",
            rules: [
              "Coordinates are pixels; y increases downward. velocityY is pixels/second, gravity is pixels/second squared, and negative velocityY means rising. A click SETS velocityY to flapVelocity; it does not add an impulse. Clicking while rising resets full upward speed and prolongs the climb.",
              "Each game frame caps elapsed time at physics.maxFrameStepMs, then updates velocityY += gravity*dt and y += velocityY*dt. Obstacles move left at speedX. Game over occurs if the player's circle touches an obstacle or crosses the upper/lower wall. gapTop/gapBottom are the opening boundaries. Wall tests use player.radius; obstacle circle/rectangle tests use player.radius * physics.obstacleRadiusFactor.",
              "player and obstacles are OBSERVED at sample time. No collision verdict, predicted position, trajectory, or target height is supplied. decision_horizon_ms estimates observation-to-answer time. Clicking happens AFTER this delay, not at the observed position. A wait leaves the player without input until the next answer; account for decision_interval_ms plus next_response_latency_ms. response_timing contains estimates, not guaranteed deadlines.",
              "A slightly negative observed velocity can become positive before this answer arrives. Near the apex, waiting for two response delays can be too late even though the bird is still rising in the observation. Evaluate the whole wait interval, not just the observed direction.",
              "Choose the action that best preserves survival and passage through the next opening. A needless flap can push the player too high. If both choices allow a later decision safely, prefer waiting. If both are dangerous, choose the one with more time to recover. Distant obstacles can be handled by later answers.",
              "Examples show observed-state inputs and the selected action under their estimated timing. They are fixed demonstrations, not the current game state. Infer the current decision from state, not from the example names. Do not choose a route or target height, and do not give explanations."
            ],
            examples: decisionExamples()
          },
          criteria: {
            click: {
              effect: "Set velocityY to flapVelocity once, AFTER decision_horizon_ms has elapsed.",
              choose_when: [
                "Without this flap, the player would reach the floor or the lower obstacle before another answer can intervene, and this flap would avoid that contact.",
                "The approaching opening requires upward motion at answer time, and a flap would allow entry without hitting the ceiling or upper obstacle."
              ],
              boundary_cases: "A slightly negative observed velocity can become downward during the response delay. An opening far ahead does not remove the need to prevent falling into the floor now."
            },
            wait: {
              effect: "Keep the current motion with gravity and no flap until the NEXT answer, including both response delays and decision_interval_ms.",
              choose_when: [
                "Waiting through the full interval keeps the player alive and leaves a later answer time to act.",
                "The player is above an approaching lower opening and needs to descend into it; a flap would keep the player above gapTop or send it into the upper obstacle.",
                "A flap would cause contact with the ceiling or upper obstacle, and waiting gives a better chance to survive."
              ],
              boundary_cases: "Do not wait solely because observed velocityY is negative or the player is in the upper half. Account for falling during both response delays. Do not click solely because an earlier apex example chose click: the next opening may require descent."
            }
          }
        }
      }
    };
  }
  function parseDecision(result) {
    const action = result?.answers?.action;
    const confidence = action?.confidence ?? action?.answer_confidence ?? null;
    if (action?.type !== "choice" || !["click", "wait"].includes(action.choice) ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      throw new Error("Jevの応答形式が不正です。");
    }
    let probabilities = null;
    if (action.probabilities !== undefined) {
      if (!action.probabilities || typeof action.probabilities !== "object") throw new Error("Jevの選択確率が不正です。");
      const { click, wait } = action.probabilities;
      if (![click, wait].every(p => Number.isFinite(p) && p >= 0 && p <= 1) || Math.abs(click + wait - 1) > 0.02) {
        throw new Error("Jevの選択確率が不正です。");
      }
      probabilities = { click, wait };
    }
    return { action: action.choice, confidence, probabilities, model: String(result.model ?? "unknown").slice(0, 200) };
  }
  const PLAN_SLOT_MS = 200, PLAN_HORIZON_MS = 800, PLAN_REPLAN_MS = 400;
  const planOptions = Object.freeze(Object.fromEntries(Array.from({ length: 16 }, (_, mask) => {
    const offsets = Array.from({ length: 4 }, (_, slot) => slot * PLAN_SLOT_MS).filter((_, slot) => mask & (1 << slot));
    return [offsets.length ? `click_${offsets.join("_")}` : "wait_all", Object.freeze(offsets)];
  })));
  function sanitizePlanState(input) {
    const state = sanitizeState(input);
    const queued = input?.planning?.pending_clicks_ms;
    const remaining = input?.planning?.current_plan_remaining_ms;
    if (!Array.isArray(queued) || queued.length > 4 ||
        queued.some((n, index) => !Number.isFinite(n) || n < 0 || n > PLAN_HORIZON_MS || (index > 0 && n <= queued[index - 1])) ||
        !Number.isFinite(remaining) || remaining < 0 || remaining > PLAN_HORIZON_MS) {
      throw new Error("クリック予定の状態が不正です。");
    }
    return {
      ...state, protocol: "scheduled-observed-state-v1",
      planning: {
        horizon_ms: PLAN_HORIZON_MS, slot_ms: PLAN_SLOT_MS, replan_after_ms: PLAN_REPLAN_MS,
        pending_clicks_ms: queued.map(n => Math.round(n * 100) / 100),
        current_plan_remaining_ms: Math.round(remaining * 100) / 100
      }
    };
  }
  function buildPlanRequest(state, model) {
    return {
      model, state,
      questions: {
        plan: {
          type: "choice",
          instructions: {
            task: "Select the complete click schedule for the 800ms AFTER this answer arrives. Predict motion and collisions yourself. Select one option; the extension executes exactly those clicks, and replans while executing the schedule.",
            rules: [
              "Coordinates are pixels; y increases downward. velocityY is pixels/second; gravity is pixels/second squared. A click SETS velocityY to flapVelocity, restarting full upward speed. Each frame caps dt at maxFrameStepMs, then does velocityY += gravity*dt; y += velocityY*dt. Obstacles move left at speedX.",
              "Survive the upper/lower walls and pass through openings. Walls use player.radius; obstacle circle/rectangle contact uses player.radius * obstacleRadiusFactor. A lower opening may require falling rather than another flap. Repeated flaps while rising can cause an upper collision.",
              "The state is observed BEFORE the response delay. decision_horizon_ms estimates this delay; response_timing describes uncertainty. Before this answer arrives, the existing pending_clicks_ms schedule continues. Those times are relative to the observed sample. Include those possible clicks in your reasoning about the state at answer time.",
              "When this answer arrives, all remaining old scheduled clicks are cancelled and your selected schedule starts from that arrival time. The option's click_offsets_ms are relative to ANSWER ARRIVAL, not the observed sample. 0 means the next animation frame; 200, 400 and 600 mean clicks at those offsets. Empty means no clicks. Do not assume earlier pending clicks survive this replacement.",
              "The next request is sent 400ms after this schedule starts, and the old schedule keeps running during that inference. Choose the entire schedule for the full 800ms, even if a later answer may replace its remaining clicks. Once a schedule expires, there are no clicks until another answer arrives. Do not rely on another response arriving in time to rescue an unsafe schedule. Prefer fewer clicks when equally safe. If every schedule is dangerous, choose the one with the best chance to survive.",
              "Only observed coordinates, physics, timing and already-selected scheduled actions are supplied. No predicted position, trajectory, collision verdict, safety margin or local action recommendation is supplied."
            ]
          },
          criteria: Object.fromEntries(Object.entries(planOptions).map(([name, offsets]) => [name, {
            click_offsets_ms: offsets,
            effect: offsets.length ? "Click only at these times after answer arrival; otherwise let gravity act." : "Let gravity act for the full 800ms without clicking."
          }]))
        }
      }
    };
  }
  function parsePlanDecision(result) {
    const answer = result?.answers?.plan;
    const confidence = answer?.confidence ?? answer?.answer_confidence ?? null;
    if (answer?.type !== "choice" || !Object.hasOwn(planOptions, answer.choice) ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      throw new Error("Jevのクリック予定の応答形式が不正です。");
    }
    let probabilities = null;
    if (answer.probabilities !== undefined) {
      const values = answer.probabilities;
      if (!values || typeof values !== "object" || Array.isArray(values) ||
          Object.keys(values).length !== Object.keys(planOptions).length ||
          Object.keys(planOptions).some(name => !Number.isFinite(values[name]) || values[name] < 0 || values[name] > 1) ||
          Math.abs(Object.values(values).reduce((sum, p) => sum + p, 0) - 1) > 0.02) {
        throw new Error("Jevのクリック予定の選択確率が不正です。");
      }
      probabilities = Object.fromEntries(Object.keys(planOptions).map(name => [name, values[name]]));
    }
    return {
      plan: answer.choice, clickOffsetsMs: [...planOptions[answer.choice]], confidence, probabilities,
      model: String(result.model ?? "unknown").slice(0, 200)
    };
  }
  function estimateLatency(samples) {
    // Priors come from the 99 completed responses in the supplied v1.2.5 logs.
    // A small prior prevents the first slow reply from becoming the sole estimate.
    const measured = samples.filter(n => Number.isFinite(n) && n > 0).slice(-20);
    const sorted = [180, 180, 180, 200, 270, ...measured].sort((a, b) => a - b);
    const quantile = q => sorted[Math.ceil(sorted.length * q) - 1];
    return {
      typical_ms: Math.max(100, Math.min(900, quantile(0.5))),
      cautious_ms: Math.max(270, Math.min(900, quantile(0.9))),
      sample_count: measured.length,
      max_observed_ms: measured.length ? Math.max(...measured) : null
    };
  }
  let cachedExamples = null;
  function decisionExamples() {
    if (cachedExamples) return cachedExamples;
    // Fixed observed-state demonstrations. Two near-apex inputs come from v1.2.6
    // logs where waiting left too little time. Only inputs and labels are sent.
    const cases = [
      ["Rising with ample room", 251.3, -420, null, "wait", 180],
      ["Small upper clearance", 111.3, -420, null, "wait", 180],
      ["Near the apex in the lower half", 199.3, -20, null, "click", 180],
      ["Approaching the apex", 192, -30, [120, 300], "click", 200, 603.33],
      ["Approaching an elevated opening", 188.3, -70, [60, 180], "click", 180, 222.2],
      ["Approaching an opening while high", 183.3, -320, [100, 280], "wait", 180, 222.2],
      ["Approaching a wide opening", 224.3, -270, [120, 300], "wait", 180, 222.2],
      ["Approaching the apex in the lower half", 268, -55, [120, 300], "click", 210, 490.67],
      ["Upward motion close to the ceiling", 64.5, -420, null, "wait", 100],
      ["An opening far ahead", 251.3, -420, [180, 300], "wait", 180, 729.7]
    ];
    cachedExamples = cases.map(([name, y, velocityY, gap, action, delayMs, obstacleX]) => {
      const next = gap ? { x: obstacleX, width: 30, gapTop: gap[0], gapBottom: gap[1] } : null;
      return {
        name,
        state: sanitizeState({
          screen: { width: 672, height: 360 },
          player: { x: 163, y, radius: 13, velocityY },
          physics: { gravity: 1500, flapVelocity: -430, speedX: 165 }, next, following: null,
          since_last_click_ms: (velocityY + 430) / 1500 * 1000,
          decision_horizon_ms: delayMs, next_response_latency_ms: 270, decision_interval_ms: 20,
          sample_age_ms: 0
        }),
        correct_choice: action
      };
    });
    return cachedExamples;
  }
  function endpoint(value) {
    if (typeof value !== "string" || value.length > 2048) throw new Error("接続先URLを確認してください。");
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("接続先はHTTPS、またはlocalhost/127.0.0.1のHTTP URLにしてください。認証情報はAPIキー欄に入力してください。");
    }
    return url.href;
  }
  function originPattern(value) {
    const url = new URL(endpoint(value));
    return `${url.protocol}//${url.hostname}/*`;
  }
  function sanitizeState(input) {
    if (!input || typeof input !== "object") throw new Error("ゲーム状態が不正です。");
    const number = (n, low, high) => {
      if (!Number.isFinite(n) || n < low || n > high) throw new Error("ゲーム状態が範囲外です。");
      return Math.round(n * 100) / 100;
    };
    const obstacle = o => o == null ? null : ({
      x: number(o?.x, -200, 10000), width: number(o?.width, 1, 200),
      gapTop: number(o?.gapTop, 0, 10000), gapBottom: number(o?.gapBottom, 0, 10000)
    });
    const height = number(input.screen?.height, 100, 10000);
    const horizon = number(input.decision_horizon_ms, 0, 1500);
    return {
      protocol: "observed-state-v1",
      screen: { width: number(input.screen?.width, 100, 10000), height },
      player: {
        x: number(input.player?.x, 0, 10000), y: number(input.player?.y, 0, 10000),
        radius: number(input.player?.radius, 1, 100), velocityY: number(input.player?.velocityY, -5000, 5000)
      },
      physics: {
        gravity: number(input.physics?.gravity, 500, 3000),
        flapVelocity: number(input.physics?.flapVelocity, -1000, -100),
        speedX: number(input.physics?.speedX, 50, 500), maxFrameStepMs: 50, obstacleRadiusFactor: 0.9
      },
      next: obstacle(input.next), following: obstacle(input.following),
      vertical_bounds: { top_wall_y: 0, bottom_wall_y: height },
      since_last_click_ms: number(input.since_last_click_ms, 0, 100000),
      decision_horizon_ms: horizon,
      next_response_latency_ms: number(input.next_response_latency_ms ?? horizon, 0, 1500),
      response_timing: input.response_timing ? {
        typical_ms: number(input.response_timing.typical_ms, 100, 900),
        cautious_ms: number(input.response_timing.cautious_ms, 100, 900),
        sample_count: number(input.response_timing.sample_count, 0, 20),
        max_observed_ms: input.response_timing.max_observed_ms === null ? null : number(input.response_timing.max_observed_ms, 0, 10000)
      } : null,
      decision_interval_ms: number(input.decision_interval_ms ?? 20, 0, 1000),
      sample_age_ms: number(input.sample_age_ms ?? 0, 0, 1000)
    };
  }
  globalThis.ChofuJev = Object.freeze({ observe, flapNeeded, buildRequest, parseDecision, sanitizeState, estimateLatency, endpoint, originPattern,
    buildPlanRequest, parsePlanDecision, sanitizePlanState, planOptions, PLAN_SLOT_MS, PLAN_HORIZON_MS, PLAN_REPLAN_MS });
})();
