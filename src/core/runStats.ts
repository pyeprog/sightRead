/**
 * Duration history of AI harness runs. Pure logic, no vscode dependency.
 *
 * The harness is silent until it finishes, so the progress tick is the only
 * feedback; a "typically ~Ns" figure next to the elapsed counter tells the
 * reader whether 40s in is normal or a hang. Only successful runs are
 * recorded — timeouts and cancels are not typical durations.
 */

/** Successful runs kept per key — enough for a stable median, quick to adapt. */
const MAX_SAMPLES = 10;

/** Appends a run's duration, keeping the newest MAX_SAMPLES. */
export function recordDuration(recent: readonly number[], ms: number): number[] {
  return [...recent, ms].slice(-MAX_SAMPLES);
}

/**
 * The typical duration: median of the recorded runs, robust against the odd
 * outlier run. Undefined until a first run has been recorded.
 */
export function typicalMs(recent: readonly number[]): number | undefined {
  if (recent.length === 0) {
    return undefined;
  }
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
