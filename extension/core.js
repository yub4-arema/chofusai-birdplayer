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
          instructions: "Choose the immediate gameplay action for the moment this response is received. Select click to send exactly one flap click now, or wait to send no input until the next observation. The extension executes your choice directly; no local controller chooses flap timing or tracks a target height. Use predicted_at_response as the estimated state when your answer arrives. The player falls under gravity and a click sets upward velocity. Coordinates increase DOWNWARD. Prefer survival through the next and following gaps. Do not give explanations.",
          criteria: {
            click: "Send one flap click immediately when your response is received.",
            wait: "Do not click before the next observation."
          }
        }
      }
    };
  }
  function parseDecision(result) {
    const answer = result?.answers?.action;
    const confidence = answer?.confidence ?? answer?.answer_confidence ?? answer?.probabilities?.[answer?.choice] ?? null;
    if (answer?.type !== "choice" || !["click", "wait"].includes(answer.choice) ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      throw new Error("Jevの応答形式が不正です。");
    }
    return { action: answer.choice, confidence, model: String(result.model ?? "unknown").slice(0, 200) };
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
    return {
      screen: { width: number(input.screen?.width, 100, 10000), height: number(input.screen?.height, 100, 10000) },
      player: { x: number(input.player?.x, 0, 10000), y: number(input.player?.y, 0, 10000),
        radius: number(input.player?.radius, 1, 100), velocityY: number(input.player?.velocityY, -5000, 5000) },
      physics: { gravity: number(input.physics?.gravity, 500, 3000), flapVelocity: number(input.physics?.flapVelocity, -1000, -100), speedX: number(input.physics?.speedX, 50, 500) },
      next: obstacle(input.next), following: obstacle(input.following),
      since_last_click_ms: number(input.since_last_click_ms, 0, 100000),
      decision_horizon_ms: number(input.decision_horizon_ms, 0, 1000),
      predicted_at_response: {
        player_y: number(predicted.player_y, -1000, 10000),
        player_velocity_y: number(predicted.player_velocity_y, -5000, 5000),
        next: obstacle(predicted.next),
        following: obstacle(predicted.following)
      }
    };
  }
  globalThis.ChofuJev = Object.freeze({ observe, flapNeeded, buildRequest, parseDecision, sanitizeState, endpoint, originPattern });
})();
