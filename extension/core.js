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
          instructions: "Choose ONLY whether to click now or wait. Coordinates use y increasing downward. A negative player.velocityY means the player is rising (moving UP); a positive value means falling (moving DOWN). The same sign rule applies to predicted_at_response.player_velocity_y. gravity is positive and accelerates DOWNWARD; flapVelocity is negative, so a click makes the player jump UP. Each click SETS vertical velocity to flapVelocity; it does not add a small impulse. Clicking again while already rising resets the full upward speed and prolongs the climb, so do not click just because the last click occurred; use the observed direction and predicted_at_response. since_last_click_ms is elapsed time since the last click. After a click, the normal upward phase lasts about abs(flapVelocity)/gravity seconds (about 287 ms in this game), then the player descends. predicted_at_response.estimated_click_apex_y_if_clicked_now estimates the player's center at the next jump apex if you click as this response arrives. If it is below vertical_bounds.safe_center_y_min, that click would hit the upper wall; estimated_click_upper_wall_margin_px shows the clearance. Game over occurs if the player's top (player.y - player.radius) goes above vertical_bounds.top_wall_y or the bottom (player.y + player.radius) goes below vertical_bounds.bottom_wall_y. vertical_bounds.safe_center_y_min and safe_center_y_max are the allowed range for the player's center, including radius. Keep the entire player inside each obstacle opening too: gapTop is the opening's upper edge, gapBottom its lower edge. Use current and predicted position/direction, both vertical out boundaries, and the next gaps to time the next single click. The extension executes your click/wait choice directly. Do not choose a route or target height, and do not give explanations.",
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
    return {
      screen: { width: screenWidth, height: screenHeight },
      player: { x: playerX, y: playerY, radius: playerRadius, velocityY,
        vertical_direction: velocityY < 0 ? "up" : "down" },
      physics: { gravity, flapVelocity, speedX: number(input.physics?.speedX, 50, 500) },
      next: obstacle(input.next), following: obstacle(input.following),
      vertical_bounds: {
        top_wall_y: 0,
        bottom_wall_y: screenHeight,
        safe_center_y_min: playerRadius,
        safe_center_y_max: screenHeight - playerRadius
      },
      since_last_click_ms: number(input.since_last_click_ms, 0, 100000),
      decision_horizon_ms: number(input.decision_horizon_ms, 0, 1000),
      predicted_at_response: {
        player_y: predictedY,
        player_velocity_y: predictedVelocityY,
        vertical_direction: predictedVelocityY < 0 ? "up" : "down",
        estimated_click_apex_y_if_clicked_now: clickApexY,
        estimated_click_upper_wall_margin_px: number(clickApexY - playerRadius, -10000, 10000),
        next: obstacle(predicted.next),
        following: obstacle(predicted.following)
      }
    };
  }
  globalThis.ChofuJev = Object.freeze({ observe, flapNeeded, buildRequest, parseDecision, sanitizeState, endpoint, originPattern });
})();
