// Offline aggregation of exported live-game logs. No API calls or game simulation.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const paths = process.argv.slice(2);
if (!paths.length) {
  process.stderr.write("Usage: node tools/summarize-logs.mjs log1.json log2.json ...\n");
  process.exitCode = 1;
} else {
  const groups = new Map(), seen = new Set(), warnings = [];
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const finite = value => Number.isFinite(value);
  const sum = values => values.reduce((total, value) => total + value, 0);
  const quantile = (values, q) => {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null;
  };
  for (const path of paths) {
    const log = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (log.format !== "chofu-jev-diagnostics-v1" || !Array.isArray(log.events)) throw new Error(`Unsupported log: ${path}`);
    if (!log.benchmark || !log.metrics) {
      warnings.push({ file: path, reason: "v1.4.0 benchmark metadata/metrics missing; excluded to avoid mixing conditions" });
      continue;
    }
    const b = log.benchmark, m = log.metrics;
    if (b.questions && hash(b.questions) !== b.questions_sha256) throw new Error(`Question hash mismatch: ${path}`);
    const models = Object.keys(m.resolved_models).sort();
    const condition = {
      extension_version: log.extension_version, mode: b.mode, protocol: b.protocol,
      questions_sha256: b.questions_sha256, controller: b.controller,
      max_requests: b.max_requests, auto_restart: b.auto_restart,
      realtime: b.realtime, random_obstacles: b.random_obstacles, initial_input: b.initial_input,
      stage: b.stage, canvas: b.canvas, device_pixel_ratio: b.device_pixel_ratio, user_agent: b.user_agent
    };
    const identity = { condition, endpoint: b.endpoint, requested_model: b.requested_model, resolved_models: models };
    const key = hash(identity), runId = `${b.endpoint}|${b.requested_model}|${b.mode}|${log.started_at}`;
    if (seen.has(runId)) throw new Error(`Duplicate start/run: ${path}; use one final export per start`);
    seen.add(runId);
    if (log.truncated) warnings.push({ file: path, reason: "Detailed events truncated; cumulative metrics are retained" });
    if (m.running) warnings.push({ file: path, reason: "Run still active; excluded from aggregate" });
    if (m.manual_inputs > 0) warnings.push({ file: path, reason: "Manual input detected; excluded from aggregate" });
    if (b.mode === "local") warnings.push({ file: path, reason: "No-model local control; excluded from Jev aggregate" });
    if (m.running || m.manual_inputs > 0 || b.mode === "local") continue;
    if (!groups.has(key)) groups.set(key, { condition_sha256: hash(condition), ...identity, files: [], metrics: [] });
    groups.get(key).files.push(path); groups.get(key).metrics.push(m);
  }
  const output = [...groups.values()].map(group => {
    const rows = group.metrics, games = rows.flatMap(m => m.games);
    const completed = games.filter(game => game.ended === "game_over"), stopped = games.filter(game => game.ended !== "game_over");
    const latencies = rows.flatMap(m => m.latencies_ms), delays = rows.flatMap(m => m.execution_delays_ms);
    const reflexRows = rows.map(m => m.reflex).filter(Boolean);
    const apiLatencies = reflexRows.flatMap(reflex => reflex.api_latencies_ms ?? []);
    const confidences = reflexRows.flatMap(reflex => reflex.confidence_samples ?? []);
    const failureClasses = {};
    for (const reflex of reflexRows) for (const [name, count] of Object.entries(reflex.failure_classes ?? {})) {
      failureClasses[name] = (failureClasses[name] ?? 0) + count;
    }
    const activeMs = sum(rows.map(m => m.active_play_ms));
    const decisions = sum(rows.map(m => m.decisions));
    const choices = {};
    for (const row of rows) for (const [choice, count] of Object.entries(row.choices)) choices[choice] = (choices[choice] ?? 0) + count;
    const { metrics: ignored, ...identity } = group;
    return {
      ...identity, starts: rows.length, completed_games: completed.length,
      // Stopped trials are censored, never silently dropped as if they did not happen.
      completed_game_scores: completed.map(game => game.score),
      score_median: quantile(completed.map(game => game.score), 0.5),
      score_mean: completed.length ? sum(completed.map(game => game.score)) / completed.length : null,
      survival_median_ms: quantile(completed.map(game => game.survival_ms), 0.5),
      stopped_games: stopped, active_play_ms: activeMs,
      api_calls: sum(rows.map(m => m.api_calls)), request_attempts: sum(rows.map(m => m.requests)),
      request_errors: sum(rows.map(m => m.request_errors)), decisions,
      decisions_per_active_second: activeMs > 0 ? decisions / (activeMs / 1000) : null, choices,
      latency_samples: latencies.length, latency_p50_ms: quantile(latencies, 0.5), latency_p95_ms: quantile(latencies, 0.95),
      latency_max_ms: latencies.length ? Math.max(...latencies) : null,
      responses_after_death: sum(rows.map(m => m.late_responses)),
      planned_clicks: sum(rows.map(m => m.planned_clicks)), executed_clicks: sum(rows.map(m => m.executed_clicks)),
      superseded_clicks: sum(rows.map(m => m.superseded_clicks)), missed_clicks: sum(rows.map(m => m.missed_clicks)),
      terminated_clicks: sum(rows.map(m => m.terminated_clicks)),
      execution_delay_p95_ms: quantile(delays, 0.95),
      plan_underruns: sum(rows.map(m => m.plan_underruns)),
      // Includes startup without a plan, distinct from expiry count.
      no_plan_ms: sum(rows.map(m => m.plan_gap_ms)),
      ...(reflexRows.length ? { reflex: {
        flap_decisions: sum(reflexRows.map(r => r.flap_decisions)),
        wait_decisions: sum(reflexRows.map(r => r.wait_decisions)),
        flaps_executed: sum(reflexRows.map(r => r.flaps_executed)),
        waits_applied: sum(reflexRows.map(r => r.waits_applied)),
        confidence_samples: confidences.length,
        confidence_mean: confidences.length ? sum(confidences) / confidences.length : null,
        confidence_p50: quantile(confidences, 0.5),
        max_in_flight: Math.max(...reflexRows.map(r => r.max_observed_in_flight ?? 0)),
        superseded_responses: sum(reflexRows.map(r => r.superseded_responses)),
        stale_responses: sum(reflexRows.map(r => r.stale_responses)),
        game_over_responses: sum(reflexRows.map(r => r.game_over_responses)),
        late_decisions: sum(reflexRows.map(r => r.late_decisions)),
        request_skips: sum(reflexRows.map(r => r.request_skips)),
        api_errors: sum(reflexRows.map(r => r.request_errors)),
        failure_classes: failureClasses,
        api_latency_samples: apiLatencies.length,
        api_latency_p50_ms: quantile(apiLatencies, 0.5),
        api_latency_p95_ms: quantile(apiLatencies, 0.95),
        api_latency_max_ms: apiLatencies.length ? Math.max(...apiLatencies) : null
      } } : {})
    };
  });
  process.stdout.write(JSON.stringify({ format: "chofu-jev-benchmark-summary-v1", groups: output, warnings }, null, 2) + "\n");
}
