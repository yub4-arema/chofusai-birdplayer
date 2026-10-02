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
            click: "Reset upward velocity once when this answer arrives, because that timing best preserves survival and reaching the opening.",
            wait: "Leave the player without a flap until another answer, because delaying the flap best preserves survival and reaching the opening."
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
      ["Downward motion in the lower half", 199.3, -20, null, "click", 180],
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
  globalThis.ChofuJev = Object.freeze({ observe, flapNeeded, buildRequest, parseDecision, sanitizeState, estimateLatency, endpoint, originPattern });
})();
