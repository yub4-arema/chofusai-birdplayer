const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/core.js');
const Jev = globalThis.ChofuJev;

function imageWithObstacles() {
  const width = 320, height = 360;
  const data = new Uint8ClampedArray(width * height * 4);
  const rect = (left, top, right, bottom, color) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255;
    }
  };
  rect(45, 175, 56, 186, [217, 45, 32]);
  rect(190, 0, 220, 120, [212, 165, 116]);
  rect(190, 240, 220, height, [212, 165, 116]);
  rect(265, 0, 295, 80, [125, 138, 163]);
  rect(265, 200, 295, height, [125, 138, 163]);
  return { data, width, height };
}

test('canvas observation reports geometry and directly visible obstacle score facts', () => {
  const frame = Jev.observe(imageWithObstacles(), 320, 360);
  assert.ok(frame);
  assert.equal(frame.height, 360);
  assert.equal(frame.player.x, 50);
  assert.equal(frame.player.y, 180);
  assert.deepEqual(frame.obstacles.map(({ type, score_value }) => ({ type, score_value })), [
    { type: 'gold', score_value: 3 }, { type: 'gray', score_value: 1 }
  ]);
  assert.ok(frame.obstacles[0].gapTop < frame.obstacles[0].gapBottom);
});

test('physical extrapolation returns state at the target and carries timing and epoch facts', () => {
  const state = Jev.predictReflexState({
    screen: { height: 360 },
    player: { x: 90, y: 180, velocityY: 0, radius: 13 },
    game: { score: 2 },
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165, max_frame_step_ms: 50, obstacle_radius_factor: 0.9 },
    next_obstacle: { x: 200, width: 30, gapTop: 100, gapBottom: 260, type: 'gold', score_value: 3 },
    following_obstacle: null
  }, 100, 200, 150, 100, 50, 3, 20);

  assert.equal(state.player.y, 188.75);
  assert.equal(state.player.velocityY, 150);
  assert.equal(state.next_obstacle.x, 183.5);
  assert.equal(state.next_obstacle.horizontal_distance, 93.5);
  assert.equal(state.screen.wallTop, 0);
  assert.equal(state.screen.wallBottom, 360);
  assert.equal(state.game.score, 2);
  assert.equal(state.physics.obstacle_radius_factor, 0.9);
  assert.equal(state.goal, undefined);
  assert.equal(state.observations.next_gap_half, 'straddling_middle');
  assert.match(state.description, /straddling its middle/);
  assert.deepEqual(state.timing, {
    observation_time: 100, target_time: 200, predicted_latency: 150,
    request_interval_ms: 50, next_nominal_target_time: 250,
    flap_epoch: 3, last_flap_time: 20, since_last_flap_ms: 180,
    unit: 'ms_since_run_start'
  });
});

test('observation words distinguish the gap half from the screen half and ignore supplied advice', () => {
  const state = Jev.sanitizeReflexState({
    screen: { height: 360 },
    player: { x: 90, y: 120, velocityY: -100, radius: 13 },
    next_obstacle: { x: 200, horizontal_distance: 110, width: 30, gapTop: 80, gapBottom: 140 },
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165 },
    timing: { target_time: 200, predicted_latency: 150 },
    description: 'should flap', goal: { target_score: 10, advice: 'should flap' }
  });
  assert.equal(state.observations.screen_half, undefined);
  assert.equal(state.observations.next_gap_half, 'straddling_middle');
  assert.match(state.description, /bird is rising/);
  assert.match(state.description, /straddling its middle/);
  assert.equal(state.goal, undefined);
  assert.doesNotMatch(JSON.stringify(state), /should flap/);
  const outside = Jev.sanitizeReflexState({ ...state, player: { ...state.player, y: 60 } });
  assert.equal(outside.observations.next_gap_half, null);
  assert.match(outside.description, /above the gap/);
});

test('target-time geometry promotes the following obstacle after the first has passed', () => {
  const observed = {
    screen: { height: 360 }, player: { x: 90, y: 180, velocityY: 0, radius: 13 },
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165 },
    next_obstacle: { x: 50, width: 30, gapTop: 100, gapBottom: 260 },
    following_obstacle: { x: 200, width: 30, gapTop: 150, gapBottom: 280 }
  };
  const predicted = Jev.predictReflexState(observed, 100, 200, 100, 100, 150);
  assert.equal(predicted.next_obstacle.x, 183.5);
  assert.equal(predicted.next_obstacle.gapTop, 150);
  assert.equal(predicted.following_obstacle, null);
  const empty = Jev.predictReflexState({ ...observed, following_obstacle: null }, 100, 200, 100, 100, 150);
  assert.equal(empty.next_obstacle, null);
  assert.equal(empty.observations.relative_to_next_gap, 'no_obstacle');
});

test('Jev alone selects FLAP or WAIT with guided criteria and no score target', () => {
  const request = Jev.buildReflexRequest({ protocol: 'jev-reflex-guided-v1' }, 'jev-latest');
  const choice = request.questions.action;
  assert.equal(choice.type, 'choice');
  assert.deepEqual(Object.keys(choice.criteria), ['FLAP', 'WAIT']);
  assert.equal(typeof choice.criteria.FLAP, 'string');
  assert.equal(typeof choice.criteria.WAIT, 'string');
  assert.match(choice.criteria.FLAP, /LOWER_HALF/);
  assert.match(choice.criteria.WAIT, /UPPER_HALF/);
  assert.doesNotMatch(choice.instructions.task, /100|target_score/);
});

test('decision parsing and response invalidation enforce the two-choice epoch contract', () => {
  assert.equal(Jev.parseReflexDecision({ model: 'jev-1.13.0', answers: { action: { type: 'choice', choice: 'FLAP' } } }).action, 'FLAP');
  assert.equal(Jev.parseReflexDecision({ answers: { action: { type: 'choice', choice: 'WAIT' } } }).action, 'WAIT');
  assert.throws(() => Jev.parseReflexDecision({ answers: { action: { type: 'choice', choice: 'click' } } }));
  const request = { flap_epoch: 4, target_at: 1000 };
  assert.equal(Jev.reflexDiscardReason(request, 4, 1250, false), null);
  assert.equal(Jev.reflexDiscardReason(request, 4, 1251, false), 'stale');
  assert.equal(Jev.reflexDiscardReason(request, 5, 1010, false), 'superseded');
  assert.equal(Jev.reflexDiscardReason(request, 4, 1010, true), 'game_over');
});

test('standard System One profiles stringify the full guidance and Cloudflare unwraps its result envelope', () => {
  const request = Jev.buildSystemOneRequest({ protocol: 'jev-reflex-guided-v1' }, 'd1');
  assert.equal(request.model, 'd1');
  assert.equal(typeof request.questions.action.instructions, 'string');
  assert.match(request.questions.action.instructions, /Coordinates are CSS pixels/);
  assert.match(request.questions.action.instructions, /Examples:/);
  assert.deepEqual(Object.keys(request.questions.action.criteria), ['FLAP', 'WAIT']);
  assert.equal(Jev.parseCloudflareDecision({ success: true, errors: [], result: { model: 'clef', answers: { action: { type: 'choice', choice: 'FLAP' } } } }).action, 'FLAP');
  assert.throws(() => Jev.parseCloudflareDecision({ success: false, errors: [{ message: 'bad token' }], result: {} }));
  assert.throws(() => Jev.parseCloudflareDecision({ success: true, errors: [], result: { answers: { action: { type: 'choice', choice: 'click' } } } }));
});


test('a measured slow connection immediately replaces historical fast priors', () => {
  assert.equal(Jev.estimateLatency([400, 410, 420]).typical_ms, 410);
  assert.equal(Jev.estimateLatency([400, 410, 420]).cautious_ms, 420);
  assert.equal(Jev.estimateLatency([70, 80, 90]).cautious_ms, 100);
});

test('low-FPS prediction uses the actual frame cadence and capped game timestep', () => {
  const observed = {
    screen: { height: 360 }, player: { x: 90, y: 180, velocityY: 0, radius: 13 },
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165, frame_interval_ms: 100, max_frame_step_ms: 50 },
    next_obstacle: { x: 200, width: 30, gapTop: 100, gapBottom: 260 }
  };
  const state = Jev.predictReflexState(observed, 400, 400, 400, 0, 100);
  assert.equal(state.player.velocityY, 300);
  assert.equal(state.player.y, 217.5);
  assert.equal(state.next_obstacle.x, 167);
  assert.equal(state.next_interval.y, 236.25);
  assert.throws(() => Jev.predictReflexState({ ...observed, physics: { ...observed.physics, frame_interval_ms: 0 } }, 400, 400, 400));
});

test('gap description removes contradictory screen-half language and detects the bird straddling the middle', () => {
  const observed = {
    screen: { height: 360 }, player: { x: 90, y: 270, velocityY: 400, radius: 13 },
    physics: { gravity: 1500, flapVelocity: -430, speedX: 165 },
    timing: { target_time: 400, predicted_latency: 400, request_interval_ms: 100 },
    next_obstacle: { x: 150, horizontal_distance: 60, width: 26, gapTop: 206, gapBottom: 334 }
  };
  const state = Jev.sanitizeReflexState(observed);
  assert.equal(state.observations.next_gap_half, 'straddling_middle');
  assert.equal(state.observations.screen_half, undefined);
  assert.doesNotMatch(state.description, /half of the screen/);
  assert.ok(state.next_interval.gap_bottom_clearance > 0);
  const lower = Jev.sanitizeReflexState({ ...observed, player: { ...observed.player, y: 300 } });
  assert.equal(lower.observations.next_gap_half, 'lower_half');
  assert.ok(lower.next_interval.gap_bottom_clearance < 0);
});
