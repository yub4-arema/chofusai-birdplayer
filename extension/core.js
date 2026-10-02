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
      model,
      state,
      questions: {
        action: {
          type: "choice",
          instructions: [
            "Choose ONLY whether to click now or wait. Coordinates use y increasing downward. A negative player.velocityY means rising (UP); positive means falling (DOWN). gravity accelerates DOWNWARD. A click SETS velocity to the negative flapVelocity; it does not add an impulse. Clicking while already rising resets the full upward speed and prolongs the climb.",
            "predicted_at_response is the estimated state when this answer arrives. predicted_if_click_until_next_decision and predicted_if_wait_until_next_decision simulate the full parabola from then until another answer could arrive. hits_upper_wall, hits_lower_wall, and hits_obstacle explicitly indicate a predicted collision during that interval; the wall margins include the player's radius, and obstacle_contacts show whether the player's full circle fits through a gap during horizontal overlap.",
            "predicted_next_obstacle_crossings estimates the vertical path through each approaching gap. time_to_overlap_start_ms tells when the player first overlaps that obstacle horizontally; additional_decisions_before_overlap estimates how many answers can arrive before then. if_click_now shows the path if you click as this answer arrives; if_wait_then_click shows the path if you wait for one more answer and click then; if_wait_no_click shows the path if you continue without clicking. A negative upper_gap_margin_px or lower_gap_margin_px means the player hits that edge during the overlap. A negative wall margin means the path hits that wall before or during the crossing.",
            "Compare click-now against wait-then-click at the actual gap crossing. Click now if waiting makes a safe crossing impossible but clicking now can clear it. Wait if the next answer still arrives in time and waiting preserves a safe crossing. Avoid repeated clicks when the wait path remains safe. If both paths collide, choose the one that stays in bounds and within the gap longer.",
            "Game over occurs when the player's top goes above vertical_bounds.top_wall_y, bottom goes below vertical_bounds.bottom_wall_y, or the player hits an obstacle. vertical_bounds.safe_center_y_min and safe_center_y_max are the allowed center range including radius. gapTop and gapBottom are the opening edges; keep the whole player inside them. The extension executes your click/wait choice directly. Do not choose a route or target height, and do not give explanations."
          ].join(" "),
          criteria: {
            click: "Send one flap click immediately when your response is received.",
            wait: "Do not click before the next observation."
          }
        }
      }
    };
  }
  function parseDecision(result) {
    const action = result?.answers?.action;
    const confidence = action?.confidence ?? action?.answer_confidence ?? action?.probabilities?.[action?.choice] ?? null;
    if (action?.type !== "choice" || !["click", "wait"].includes(action.choice) ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      throw new Error("Jevの応答形式が不正です。");
    }
    return { action: action.choice, confidence, model: String(result.model ?? "unknown").slice(0, 200) };
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
    const predicted = input.predicted_at_response;
    if (!predicted || typeof predicted !== "object") throw new Error("ゲーム状態が不正です。");
    const screenWidth = number(input.screen?.width, 100, 10000);
    const screenHeight = number(input.screen?.height, 100, 10000);
    const playerX = number(input.player?.x, 0, 10000);
    const playerY = number(input.player?.y, 0, 10000);
    const playerRadius = number(input.player?.radius, 1, 100);
    const velocityY = number(input.player?.velocityY, -5000, 5000);
    const gravity = number(input.physics?.gravity, 500, 3000);
    const flapVelocity = number(input.physics?.flapVelocity, -1000, -100);
    const predictedVelocityY = number(predicted.player_velocity_y, -5000, 5000);
    const predictedY = number(predicted.player_y, -1000, 10000);
    const clickApexY = number(predictedY - flapVelocity ** 2 / (2 * gravity), -10000, 10000);
    const decisionHorizonMs = number(input.decision_horizon_ms, 0, 1000);
    const decisionIntervalMs = number(input.decision_interval_ms ?? 20, 0, 1000);
    const nextDecisionHorizonMs = decisionHorizonMs + decisionIntervalMs;
    const speedX = number(input.physics?.speedX, 50, 500);
    const responseObstacles = [
      ["next", obstacle(predicted.next)], ["following", obstacle(predicted.following)]
    ].filter(([, value]) => value !== null);
    const noClickYAt = seconds => predictedY + predictedVelocityY * seconds + 0.5 * gravity * seconds ** 2;
    const pathYAt = (milliseconds, clickAtMs = null) => {
      const seconds = milliseconds / 1000;
      if (clickAtMs === null || milliseconds < clickAtMs) return noClickYAt(seconds);
      const clickSeconds = clickAtMs / 1000;
      const yAtClick = noClickYAt(clickSeconds);
      const afterClick = seconds - clickSeconds;
      return yAtClick + flapVelocity * afterClick + 0.5 * gravity * afterClick ** 2;
    };
    const pathVelocityAt = (milliseconds, clickAtMs = null) => {
      if (clickAtMs !== null && milliseconds >= clickAtMs) return flapVelocity + gravity * (milliseconds - clickAtMs) / 1000;
      return predictedVelocityY + gravity * milliseconds / 1000;
    };
    const extrema = (startMs, endMs, clickAtMs = null) => {
      const start = startMs / 1000, end = endMs / 1000;
      const switchTime = clickAtMs === null ? Infinity : clickAtMs / 1000;
      const cuts = [start, end];
      if (switchTime > start && switchTime < end) cuts.push(switchTime);
      cuts.sort((a, b) => a - b);
      const candidates = [...cuts];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1], midpoint = (a + b) / 2;
        const afterClick = switchTime !== Infinity && midpoint >= switchTime;
        const originTime = afterClick ? switchTime : 0;
        const originVelocity = afterClick ? flapVelocity : predictedVelocityY;
        const apexTime = originTime - originVelocity / gravity;
        if (apexTime >= a && apexTime <= b) candidates.push(apexTime);
      }
      const values = candidates.map(seconds => pathYAt(seconds * 1000, clickAtMs));
      return { min_y: Math.min(...values), max_y: Math.max(...values) };
    };
    const shiftObstacle = (value, horizonMs) => value == null ? null : ({
      ...value, x: number(value.x - speedX * horizonMs / 1000, -10000, 10000)
    });
    const pathSummary = clickAtMs => {
      const duration = nextDecisionHorizonMs;
      const vertical = extrema(0, duration, clickAtMs);
      const upperWallMargin = vertical.min_y - playerRadius;
      const lowerWallMargin = screenHeight - playerRadius - vertical.max_y;
      const contacts = [];
      for (const [which, value] of responseObstacles) {
        const enterMs = (value.x - playerX - playerRadius) / speedX * 1000;
        const exitMs = (value.x + value.width - playerX + playerRadius) / speedX * 1000;
        if (exitMs < 0 || enterMs > duration) continue;
        const startMs = Math.max(0, enterMs), endMs = Math.min(duration, exitMs);
        if (endMs < startMs) continue;
        const overlap = extrema(startMs, endMs, clickAtMs);
        const upperGapMargin = overlap.min_y - (value.gapTop + playerRadius);
        const lowerGapMargin = value.gapBottom - playerRadius - overlap.max_y;
        contacts.push({
          obstacle: which,
          overlap_start_ms: number(startMs, 0, 10000),
          overlap_end_ms: number(endMs, 0, 10000),
          upper_gap_margin_px: number(upperGapMargin, -30000, 30000),
          lower_gap_margin_px: number(lowerGapMargin, -30000, 30000),
          hits_upper_gap: upperGapMargin < 0,
          hits_lower_gap: lowerGapMargin < 0
        });
      }
      const endY = pathYAt(duration, clickAtMs), endVelocityY = pathVelocityAt(duration, clickAtMs);
      return {
        additional_horizon_ms: duration,
        player_y: number(endY, -30000, 30000),
        player_velocity_y: number(endVelocityY, -10000, 10000),
        vertical_direction: endVelocityY < 0 ? "up" : "down",
        upper_wall_margin_px: number(upperWallMargin, -30000, 30000),
        lower_wall_margin_px: number(lowerWallMargin, -30000, 30000),
        hits_upper_wall: upperWallMargin < 0,
        hits_lower_wall: lowerWallMargin < 0,
        hits_obstacle: contacts.some(contact => contact.hits_upper_gap || contact.hits_lower_gap),
        obstacle_contacts: contacts,
        next: shiftObstacle(responseObstacles.find(([which]) => which === "next")?.[1] ?? null, duration),
        following: shiftObstacle(responseObstacles.find(([which]) => which === "following")?.[1] ?? null, duration)
      };
    };
    const crossingForecast = (which, value) => {
      const rawEntryMs = (value.x - playerX - playerRadius) / speedX * 1000;
      const rawExitMs = (value.x + value.width - playerX + playerRadius) / speedX * 1000;
      if (rawExitMs < 0 || rawEntryMs > 5000) return null;
      const startMs = Math.max(0, rawEntryMs), endMs = Math.max(startMs, rawExitMs);
      const pathAtCrossing = clickAtMs => {
        const overlap = extrema(startMs, endMs, clickAtMs);
        const entire = extrema(0, endMs, clickAtMs);
        const upperGapMargin = overlap.min_y - (value.gapTop + playerRadius);
        const lowerGapMargin = value.gapBottom - playerRadius - overlap.max_y;
        const upperWallMargin = entire.min_y - playerRadius;
        const lowerWallMargin = screenHeight - playerRadius - entire.max_y;
        return {
          player_y_at_overlap_start: number(pathYAt(startMs, clickAtMs), -30000, 30000),
          player_y_at_overlap_end: number(pathYAt(endMs, clickAtMs), -30000, 30000),
          upper_gap_margin_px: number(upperGapMargin, -30000, 30000),
          lower_gap_margin_px: number(lowerGapMargin, -30000, 30000),
          hits_upper_gap: upperGapMargin < 0,
          hits_lower_gap: lowerGapMargin < 0,
          upper_wall_margin_before_crossing_px: number(upperWallMargin, -30000, 30000),
          lower_wall_margin_before_crossing_px: number(lowerWallMargin, -30000, 30000),
          hits_wall_before_or_during_crossing: upperWallMargin < 0 || lowerWallMargin < 0
        };
      };
      return {
        obstacle: which,
        time_to_overlap_start_ms: number(startMs, 0, 10000),
        time_to_overlap_end_ms: number(endMs, 0, 10000),
        additional_decisions_before_overlap: Math.max(0, Math.ceil(startMs / Math.max(1, nextDecisionHorizonMs)) - 1),
        gapTop: value.gapTop,
        gapBottom: value.gapBottom,
        if_click_now: pathAtCrossing(0),
        if_wait_then_click: pathAtCrossing(nextDecisionHorizonMs),
        if_wait_no_click: pathAtCrossing(null)
      };
    };
    const waitPath = pathSummary(null);
    const clickPath = pathSummary(0);
    const crossings = responseObstacles.map(([which, value]) => crossingForecast(which, value)).filter(Boolean);
    return {
      screen: { width: screenWidth, height: screenHeight },
      player: { x: playerX, y: playerY, radius: playerRadius, velocityY,
        vertical_direction: velocityY < 0 ? "up" : "down" },
      physics: { gravity, flapVelocity, speedX },
      next: obstacle(input.next), following: obstacle(input.following),
      vertical_bounds: {
        top_wall_y: 0,
        bottom_wall_y: screenHeight,
        safe_center_y_min: playerRadius,
        safe_center_y_max: screenHeight - playerRadius
      },
      since_last_click_ms: number(input.since_last_click_ms, 0, 100000),
      decision_horizon_ms: decisionHorizonMs,
      decision_interval_ms: decisionIntervalMs,
      sample_age_ms: number(input.sample_age_ms ?? 0, 0, 1000),
      predicted_at_response: {
        player_y: predictedY,
        player_velocity_y: predictedVelocityY,
        vertical_direction: predictedVelocityY < 0 ? "up" : "down",
        estimated_click_apex_y_if_clicked_now: clickApexY,
        estimated_click_upper_wall_margin_px: number(clickApexY - playerRadius, -10000, 10000),
        next: responseObstacles.find(([which]) => which === "next")?.[1] ?? null,
        following: responseObstacles.find(([which]) => which === "following")?.[1] ?? null
      },
      predicted_if_click_until_next_decision: clickPath,
      predicted_if_wait_until_next_decision: waitPath,
      predicted_next_obstacle_crossings: crossings
    };
  }
  globalThis.ChofuJev = Object.freeze({ observe, flapNeeded, buildRequest, parseDecision, sanitizeState, endpoint, originPattern });
})();
