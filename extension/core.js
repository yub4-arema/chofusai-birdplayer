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
      // The game uses one solid color per obstacle pair. Retain that directly
      // observed game fact, including the score shown by the public game rules.
      let colorY = bestStart > 0 ? bestStart - 1 : bestEnd;
      let colorIndex = (colorY * width + column) * 4;
      if (data[colorIndex + 3] <= 120) {
        colorY = Math.min(height - 1, bestEnd + 1);
        colorIndex = (colorY * width + column) * 4;
      }
      const gold = data[colorIndex] > data[colorIndex + 1] && data[colorIndex + 1] > data[colorIndex + 2];
      obstacles.push({
        x: left / rx - inset,
        width: (right - left + 1) / rx + inset * 2,
        gapTop, gapBottom, type: gold ? "gold" : "gray", score_value: gold ? 3 : 1
      });
    }
    return {
      width: cssWidth, height: cssHeight, scale,
      player: { x: (minX + maxX) / (2 * rx), y: (minY + maxY) / (2 * ry), radius: 13 * scale },
      obstacles: obstacles.sort((a, b) => a.x - b.x)
    };
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
  const REFLEX_REQUEST_INTERVAL_MS = 50;
  const REFLEX_MAX_IN_FLIGHT = 12;
  const REFLEX_MAX_LATE_MS = 250;
  const REFLEX_MAX_PREDICTION_MS = 1500;
  function sanitizeReflexState(input) {
    if (!input || typeof input !== "object") throw new Error("Jev reflex state is invalid.");
    const number = (n, low, high) => {
      if (!Number.isFinite(n) || n < low || n > high) throw new Error("Jev reflex state is out of range.");
      return Math.round(n * 100) / 100;
    };
    const height = number(input.screen?.height, 100, 10000);
    const playerX = number(input.player?.x, -10000, 10000);
    const playerY = number(input.player?.y, -10000, 20000);
    const velocityY = number(input.player?.velocityY, -5000, 5000);
    const radius = number(input.player?.radius, 1, 100);
    const gravity = number(input.physics?.gravity, 500, 3000);
    const flapVelocity = number(input.physics?.flapVelocity, -1000, -100);
    const speedX = number(input.physics?.speedX, 50, 500);
    const maxFrameStepMs = number(input.physics?.max_frame_step_ms ?? 50, 1, 100);
    const obstacleRadiusFactor = number(input.physics?.obstacle_radius_factor ?? 0.9, 0.1, 1);
    const frameIntervalMs = number(input.physics?.frame_interval_ms ?? 1000 / 60, 3, 500);
    const obstacle = value => value == null ? null : ({
      x: number(value.x, -10000, 10000),
      horizontal_distance: number(value.horizontal_distance, -20000, 20000),
      width: number(value.width, 1, 500),
      gapTop: number(value.gapTop, -10000, 10000),
      gapBottom: number(value.gapBottom, -10000, 10000),
      type: ["gray", "gold", "unknown"].includes(value.type) ? value.type : "unknown",
      score_value: number(value.score_value ?? 0, 0, 100)
    });
    const next = obstacle(input.next_obstacle);
    const following = obstacle(input.following_obstacle);
    const gameScore = number(input.game?.score ?? 0, 0, 1000000);
    const observationTime = number(input.timing?.observation_time ?? 0, 0, 1000000000);
    const targetTime = number(input.timing?.target_time, 0, 1000000000);
    const predictedLatency = number(input.timing?.predicted_latency, 0, 1500);
    const requestInterval = number(input.timing?.request_interval_ms ?? REFLEX_REQUEST_INTERVAL_MS, 1, 1000);
    const flapEpoch = input.timing?.flap_epoch ?? 0;
    if (!Number.isSafeInteger(flapEpoch) || flapEpoch < 0) throw new Error("Jev reflex epoch is invalid.");
    const lastFlapTime = number(input.timing?.last_flap_time ?? observationTime, 0, 1000000000);
    const sinceLastFlap = number(input.timing?.since_last_flap_ms ?? Math.max(0, targetTime - lastFlapTime), 0, 1000000000);
    const gapPosition = !next ? "no_obstacle"
      : playerY < next.gapTop ? "above_gap"
        : playerY > next.gapBottom ? "below_gap" : "inside_gap";
    const gapHalf = gapPosition !== "inside_gap" ? null
      : playerY + radius < (next.gapTop + next.gapBottom) / 2 ? "upper_half" : playerY - radius > (next.gapTop + next.gapBottom) / 2 ? "lower_half" : "straddling_middle";
    const motion = velocityY < -0.5 ? "rising" : velocityY > 0.5 ? "falling" : "level";
    let nextY = playerY, nextVelocity = velocityY, remaining = requestInterval / 1000, physicalSeconds = 0;
    while (remaining > 0) {
      const wallDt = Math.min(frameIntervalMs / 1000, remaining);
      const dt = Math.min(maxFrameStepMs / 1000, wallDt);
      nextVelocity += gravity * dt;
      nextY += nextVelocity * dt;
      physicalSeconds += dt;
      remaining -= wallDt;
    }
    const nextGap = [next, following].filter(Boolean).find(o => o.x + o.width - speedX * physicalSeconds >= playerX - radius);
    const nextGapPosition = !nextGap ? "no_obstacle" : nextY < nextGap.gapTop ? "above_gap" : nextY > nextGap.gapBottom ? "below_gap" : "inside_gap";
    const screenPosition = playerY < height / 4 ? "top quarter"
      : playerY < height / 2 ? "upper half"
        : playerY < height * 3 / 4 ? "lower half" : "bottom quarter";
    const gapDescription = !next ? "No obstacle is visible."
      : `The bird is ${gapPosition === "inside_gap" ? `inside the gap, ${gapHalf === "straddling_middle" ? "straddling its middle" : gapHalf === "upper_half" ? "entirely in its upper half" : "entirely in its lower half"}` : gapPosition === "above_gap" ? "above the gap" : "below the gap"}. The next obstacle is ${Math.round(next.x - playerX)} pixels horizontally from the bird.`;
    return {
      protocol: "jev-reflex-guided-v1",
      objective: "Stay alive and pass obstacles to increase the displayed score.",
      description: next ? `The bird is ${motion}. ${gapDescription}` : `The bird is in the ${screenPosition} of the screen and ${motion}. ${gapDescription}`,
      screen: { height, wallTop: 0, wallBottom: height },

      player: { x: playerX, y: playerY, velocityY, radius,
        ceiling_clearance: Math.round((playerY - radius) * 100) / 100,
        floor_clearance: Math.round((height - playerY - radius) * 100) / 100 },

      game: { score: gameScore },
      next_obstacle: next,
      following_obstacle: following,
      physics: { gravity, flapVelocity, speedX, max_frame_step_ms: maxFrameStepMs, obstacle_radius_factor: obstacleRadiusFactor, frame_interval_ms: frameIntervalMs },
      timing: {
        observation_time: observationTime, target_time: targetTime, predicted_latency: predictedLatency,
        request_interval_ms: requestInterval, next_nominal_target_time: targetTime + requestInterval,
        flap_epoch: flapEpoch, last_flap_time: lastFlapTime, since_last_flap_ms: sinceLastFlap,
        unit: "ms_since_run_start"
      },
      next_interval: {
        y: Math.round(nextY * 100) / 100, velocityY: Math.round(nextVelocity * 100) / 100,
        relative_to_next_gap: nextGapPosition,
        gap_bottom_clearance: nextGap ? Math.round((nextGap.gapBottom - nextY - radius) * 100) / 100 : null
      },
      observations: {
        vertical_motion: motion,
        relative_to_next_gap: gapPosition,
        next_gap_half: gapHalf,
        ...(!next ? { screen_half: playerY < height / 2 ? "upper_half" : "lower_half" } : {})
      }
    };
  }
  function predictReflexState(input, deltaMs, targetTime, predictedLatency, observationTime, requestIntervalMs = REFLEX_REQUEST_INTERVAL_MS, flapEpoch = 0, lastFlapTime) {
    if (!input || typeof input !== "object") throw new Error("Observed game state is invalid.");
    if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > REFLEX_MAX_PREDICTION_MS) {
      throw new Error("Prediction interval is out of range.");
    }
    const height = input.screen?.height;
    let playerX = input.player?.x;
    let playerY = input.player?.y;
    let velocityY = input.player?.velocityY;
    const radius = input.player?.radius;
    const gravity = input.physics?.gravity;
    const flapVelocity = input.physics?.flapVelocity;
    const speedX = input.physics?.speedX;
    const maxFrameStepMs = input.physics?.max_frame_step_ms ?? 50;
    const frameIntervalMs = input.physics?.frame_interval_ms ?? 1000 / 60;
    const obstacleRadiusFactor = input.physics?.obstacle_radius_factor ?? 0.9;
    const next = input.next_obstacle ? { ...input.next_obstacle } : null;
    const following = input.following_obstacle ? { ...input.following_obstacle } : null;
    const obstacleValues = [next, following].filter(Boolean);
    if (![height, playerX, playerY, velocityY, radius, gravity, flapVelocity, speedX, maxFrameStepMs, obstacleRadiusFactor, frameIntervalMs].every(Number.isFinite) || frameIntervalMs < 3 || frameIntervalMs > 500 ||
        obstacleValues.some(o => ![o.x, o.width, o.gapTop, o.gapBottom].every(Number.isFinite))) {
      throw new Error("Observed game state is invalid.");
    }
    // Match the game's semi-implicit update in short frame-sized steps. This only
    // extrapolates measured physics; it does not evaluate collisions or actions.
    let remaining = deltaMs / 1000;
    while (remaining > 0) {
      const wallDt = Math.min(frameIntervalMs / 1000, remaining);
      const dt = Math.min(maxFrameStepMs / 1000, wallDt);
      velocityY += gravity * dt;
      playerY += velocityY * dt;
      for (const obstacle of obstacleValues) obstacle.x -= speedX * dt;
      remaining -= wallDt;
    }
    const toObstacle = obstacle => obstacle && ({
      x: obstacle.x, horizontal_distance: obstacle.x - playerX,
      width: obstacle.width, gapTop: obstacle.gapTop, gapBottom: obstacle.gapBottom,
      type: obstacle.type ?? "unknown", score_value: obstacle.score_value ?? 0
    });
    // The target can fall after a visible obstacle has passed the bird. Promote
    // the following visible obstacle using projected geometry, without choosing
    // an action or inventing unseen obstacles.
    const upcoming = obstacleValues.filter(obstacle => obstacle.x + obstacle.width >= playerX - radius).sort((a, b) => a.x - b.x);
    return sanitizeReflexState({
      screen: { height },
      player: { x: playerX, y: playerY, velocityY, radius },
      game: input.game,
      next_obstacle: toObstacle(upcoming[0]) ?? null, following_obstacle: toObstacle(upcoming[1]) ?? null,
      physics: { gravity, flapVelocity, speedX, max_frame_step_ms: maxFrameStepMs, obstacle_radius_factor: obstacleRadiusFactor, frame_interval_ms: frameIntervalMs },
      timing: {
        observation_time: observationTime ?? Math.max(0, targetTime - deltaMs),
        target_time: targetTime, predicted_latency: predictedLatency,
        request_interval_ms: requestIntervalMs, next_nominal_target_time: targetTime + requestIntervalMs,
        flap_epoch: flapEpoch, last_flap_time: lastFlapTime ?? (observationTime ?? Math.max(0, targetTime - deltaMs)),
        since_last_flap_ms: Math.max(0, targetTime - (lastFlapTime ?? (observationTime ?? Math.max(0, targetTime - deltaMs))))
      }
    });
  }
  function buildReflexRequest(state, model) {
    return {
      model, state,
      questions: {
        action: {
          type: "choice",
          instructions: {
            task: "Keep the bird alive and increase the score by passing obstacles. Choose FLAP or WAIT at timing.target_time.",
            examples: [
              { observations: { vertical_motion: "falling", relative_to_next_gap: "above_gap" }, choice: "WAIT", reason: "Descend toward a lower opening; do not flap early." },
              { observations: { vertical_motion: "rising", relative_to_next_gap: "inside_gap", next_gap_half: "lower_half" }, choice: "WAIT", reason: "Already climbing; no repeated flap." },
              { observations: { vertical_motion: "falling", relative_to_next_gap: "inside_gap", next_gap_half: "upper_half" }, next_interval: { relative_to_next_gap: "inside_gap" }, choice: "WAIT" },
              { observations: { vertical_motion: "falling", relative_to_next_gap: "inside_gap", next_gap_half: "lower_half" }, choice: "FLAP" },
              { observations: { vertical_motion: "falling", relative_to_next_gap: "inside_gap", next_gap_half: "straddling_middle" }, next_interval: { gap_bottom_clearance: 30 }, choice: "WAIT" },
              { observations: { vertical_motion: "falling", relative_to_next_gap: "inside_gap", next_gap_half: "upper_half" }, next_interval: { relative_to_next_gap: "below_gap", gap_bottom_clearance: -20 }, choice: "FLAP", reason: "Fast fall: act before overshooting the whole gap." }
            ],
            rules: [
              "Coordinates are CSS pixels; y increases downwards. player.x/y are the bird's centre; negative velocityY means rising. obstacle.x is its left edge, with an opening from gapTop to gapBottom. Passing gray earns 1 point; gold earns 3.",
              "Gravity pulls the bird down: each frame updates velocityY += gravity*dt, then y += velocityY*dt. dt is capped by max_frame_step_ms. Obstacles move left at speedX. Touching a wall or obstacle ends the game. Wall contact uses player.radius; obstacle contact uses radius * obstacle_radius_factor.",
              "Positions and velocities already describe target_time. next_interval describes the unchanged motion one request_interval_ms later, not another API-latency interval. Do not advance them again for latency. All times are milliseconds since run start. Requests arrive every request_interval_ms; responses take predicted_latency approximately while the game continues. FLAP invalidates outstanding replies for the previous flap_epoch. When an obstacle is visible, upper/lower half refers ONLY to that opening, never the screen. Return only the selected option."
            ]
          },
          criteria: {
            FLAP: "Choose FLAP when NOT RISING and below the opening, or entirely in its LOWER_HALF. When FALLING inside the opening, also flap if next_interval.gap_bottom_clearance is negative. Otherwise wait in STRADDLING_MIDDLE or UPPER_HALF: flapping too early sends the bird into the upper obstacle. With no obstacle, flap in the screen lower half when not rising. One click resets full upward velocity.",
            WAIT: "Choose WAIT when RISING or ABOVE the opening. Inside the opening, choose WAIT in STRADDLING_MIDDLE or UPPER_HALF unless falling and next_interval.gap_bottom_clearance is negative. Let the bird descend into LOWER_HALF before flapping; the full upward impulse needs this room. With no obstacle, wait in the screen upper half or while rising."

          }
        }
      }
    };
  }
  function parseReflexDecision(result) {
    const answer = result?.answers?.action;
    const confidence = answer?.confidence ?? answer?.answer_confidence ?? null;
    if (answer?.type !== "choice" || !["FLAP", "WAIT"].includes(answer.choice) ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      throw new Error("Jev reflex response is invalid.");
    }
    let probabilities = null;
    if (answer.probabilities !== undefined) {
      const values = answer.probabilities;
      if (!values || typeof values !== "object" || Array.isArray(values) ||
          Object.keys(values).length !== 2 || !["FLAP", "WAIT"].every(name => Number.isFinite(values[name]) && values[name] >= 0 && values[name] <= 1) ||
          Math.abs(values.FLAP + values.WAIT - 1) > 0.02) {
        throw new Error("Jev reflex probabilities are invalid.");
      }
      probabilities = { FLAP: values.FLAP, WAIT: values.WAIT };
    }
    return { action: answer.choice, confidence, probabilities, model: String(result.model ?? "unknown").slice(0, 200) };
  }
  function reflexDiscardReason(request, currentFlapEpoch, now, gameOver, maxLateMs = REFLEX_MAX_LATE_MS) {
    if (gameOver) return "game_over";
    if (request.flap_epoch !== currentFlapEpoch) return "superseded";
    if (now - request.target_at > maxLateMs) return "stale";
    return null;
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
    // Calibration measures the actual connection before play. Use its median
    // immediately; old 180ms priors must not mask a 400ms connection.
    const measured = samples.filter(n => Number.isFinite(n) && n > 0).slice(-20);
    const sorted = (measured.length ? [...measured] : [180, 180, 200, 270]).sort((a, b) => a - b);
    const quantile = q => sorted[Math.ceil(sorted.length * q) - 1];
    return {
      typical_ms: Math.max(100, Math.min(900, quantile(0.5))),
      cautious_ms: Math.max(100, Math.min(900, quantile(0.9))),
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
  globalThis.ChofuJev = Object.freeze({ observe, buildRequest, parseDecision, sanitizeState, estimateLatency, endpoint, originPattern,
    predictReflexState, sanitizeReflexState, buildReflexRequest, parseReflexDecision, reflexDiscardReason,
    REFLEX_REQUEST_INTERVAL_MS, REFLEX_MAX_IN_FLIGHT, REFLEX_MAX_LATE_MS,
    buildPlanRequest, parsePlanDecision, sanitizePlanState, planOptions, PLAN_SLOT_MS, PLAN_HORIZON_MS, PLAN_REPLAN_MS });
})();
