import { spawn } from 'child_process';
import * as vscode from 'vscode';
import {
  DETECTION_ORDER,
  HarnessProfile,
  buildInvocation,
  extractResult,
  resolveHarness,
} from '../core/harness';

export interface AgentInvocation {
  prompt: string;
  cwd: string;
  /** the child process is killed past this */
  timeoutMs: number;
  /** progress-UI cancellation */
  signal?: AbortSignal;
  /** run with the profile's exploreArgs (read-only repo exploration) */
  explore?: boolean;
  /** appended as `--model <value>`; undefined = the CLI's own default model */
  model?: string;
}

/**
 * Drives one harness profile headless. Stdin follows buildInvocation: piped
 * only when the profile wants the prompt there, otherwise 'ignore' — some
 * CLIs (opencode, pi) block reading an open pipe to EOF.
 */
export class HarnessRunner {
  constructor(
    readonly name: string,
    private profile: HarnessProfile,
  ) {}

  /** whether the profile declares an exploration argv (route planning needs it) */
  supportsExplore(): boolean {
    return this.profile.exploreArgs !== undefined;
  }

  /** resolves false when the executable is not runnable from PATH */
  detect(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.profile.command, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  /** resolves the model's final text; rejects with a user-facing message */
  run(inv: AgentInvocation): Promise<string> {
    return new Promise((resolve, reject) => {
      const { args, stdinPrompt } = buildInvocation(
        this.profile,
        inv.prompt,
        inv.explore === true,
        inv.model,
      );
      const child = spawn(this.profile.command, args, {
        cwd: inv.cwd,
        env: this.profile.env ? { ...process.env, ...this.profile.env } : process.env,
        stdio: [stdinPrompt === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      if (stdinPrompt !== undefined) {
        child.stdin?.write(stdinPrompt);
        child.stdin?.end();
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const fail = (message: string): void => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        fail(`${this.name} timed out after ${Math.round(inv.timeoutMs / 1000)}s`);
      }, inv.timeoutMs);
      const onAbort = (): void => {
        child.kill();
        fail('cancelled');
      };
      inv.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(`could not run '${this.profile.command}': ${e.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        inv.signal?.removeEventListener('abort', onAbort);
        if (settled) {
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim().split('\n').pop() ?? '';
          fail(`${this.name} exited with code ${code}${detail ? `: ${detail}` : ''}`);
          return;
        }
        const extracted = extractResult(stdout, this.profile);
        if (!extracted.ok) {
          fail(`${this.name}: ${extracted.error}`);
          return;
        }
        settled = true;
        resolve(extracted.text);
      });
    });
  }
}

let cachedRunner: HarnessRunner | undefined;

/** Detection results survive across runs; call on any sightread config change. */
export function invalidateHarnessCache(): void {
  cachedRunner = undefined;
}

function customHarnesses(): Record<string, HarnessProfile> {
  return vscode.workspace
    .getConfiguration('sightread')
    .get<Record<string, HarnessProfile>>('guide.customHarnesses', {});
}

/** The auto order: market share, except a Cursor host promotes cursor first. */
export function autoDetectionOrder(): string[] {
  const order = [...new Set([...DETECTION_ORDER, ...Object.keys(customHarnesses())])];
  if (vscode.env.appName.includes('Cursor')) {
    return ['cursor', ...order.filter((n) => n !== 'cursor')];
  }
  return order;
}

/**
 * Picks the harness per settings: an explicit name resolves directly, 'auto'
 * probes autoDetectionOrder() and takes the first hit. Only successful picks
 * are cached — a missing CLI may get installed mid-session.
 */
export async function pickHarness(): Promise<HarnessRunner | undefined> {
  if (cachedRunner) {
    return cachedRunner;
  }
  const name = vscode.workspace.getConfiguration('sightread').get<string>('guide.harness', 'auto');
  const custom = customHarnesses();
  const candidates =
    name === 'auto'
      ? autoDetectionOrder()
      : [name];
  for (const candidate of candidates) {
    const resolved = resolveHarness(candidate, custom);
    if (!resolved) {
      continue;
    }
    const runner = new HarnessRunner(resolved.name, resolved.profile);
    if (await runner.detect()) {
      cachedRunner = runner;
      return runner;
    }
  }
  return undefined;
}
