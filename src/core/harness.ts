/**
 * Agent-harness profiles and the pure logic of driving them. A profile
 * describes how one coding-agent CLI runs headless for a single
 * self-contained prompt; the spawning itself lives in vs/agentCli.ts.
 *
 * Builtin presets are verified against each CLI's docs/source (2026-07).
 * Users add profiles — or replace builtin ones wholesale, by the same
 * name — via the `sightread.guide.customHarnesses` setting.
 */

export interface HarnessProfile {
  /** executable name, resolved via PATH */
  command: string;
  /** argv; "${prompt}" is substituted — without it the prompt is piped to stdin */
  args: string[];
  /** argv for read-only repo exploration (more turns); absent = cannot explore */
  exploreArgs?: string[];
  /** extra environment variables for the child process */
  env?: Record<string, string>;
  /** field of a JSON-envelope stdout holding the final text; omitted = raw stdout */
  resultField?: string;
  /** envelope field that signals failure when strictly true */
  errorField?: string;
}

export const PROMPT_PLACEHOLDER = '${prompt}';

export const BUILTIN_HARNESSES: Record<string, HarnessProfile> = {
  claude: {
    command: 'claude',
    // deliberately no --bare: it skips OAuth and would break subscription users
    args: ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json', '--max-turns', '1', '--allowedTools', ''],
    // read-only tools only; exploration takes many tool calls — the run timeout is the real bound
    exploreArgs: ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json', '--max-turns', '40', '--allowedTools', 'Read,Grep,Glob,LS'],
    resultField: 'result',
    errorField: 'is_error',
  },
  codex: {
    // read-only sandbox is codex exec's default — explicit anyway; '-' reads the prompt from stdin
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
    // the read-only sandbox already explores — same argv
    exploreArgs: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
  },
  opencode: {
    // headless runs auto-reject permission asks, so denying edit/bash/webfetch cannot hang
    command: 'opencode',
    args: ['run', PROMPT_PLACEHOLDER],
    // the env below already denies mutation while read/grep/glob stay — same argv
    exploreArgs: ['run', PROMPT_PLACEHOLDER],
    env: {
      OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"deny","bash":"deny","webfetch":"deny"}}',
    },
  },
  pi: {
    command: 'pi',
    args: ['-p', PROMPT_PLACEHOLDER, '--no-tools', '--no-session'],
  },
  cursor: {
    // the primary command became `agent` in 2026-01, but that name is too
    // generic to probe for — the compat alias stays unambiguous
    command: 'cursor-agent',
    args: ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json', '--mode', 'ask'],
    resultField: 'result',
    errorField: 'is_error',
  },
  devin: {
    // Windsurf's lineage: Cognition's official CLI (Windsurf → Devin Desktop).
    // Headless -p cannot show the workspace-trust prompt — disable it explicitly.
    // permission-mode 'plan' = read-only tools (grep/glob/read); doc-level
    // verified against docs.devin.ai (2026-08), not yet machine-tested.
    command: 'devin',
    args: ['-p', PROMPT_PLACEHOLDER, '--permission-mode', 'plan', '--respect-workspace-trust', 'false'],
    exploreArgs: ['-p', PROMPT_PLACEHOLDER, '--permission-mode', 'plan', '--respect-workspace-trust', 'false'],
  },
  aider: {
    command: 'aider',
    args: [
      '--message', PROMPT_PLACEHOLDER, '--chat-mode', 'ask', '--yes-always',
      '--no-pretty', '--no-stream', '--no-auto-commits', '--dry-run', '--no-git',
      '--no-suggest-shell-commands', '--no-detect-urls', '--no-check-update',
      '--no-analytics', '--map-tokens', '0',
    ],
  },
  agy: {
    // Google-OAuth only (no injectable key); --output-format needs agy >= 1.1.1
    command: 'agy',
    args: ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json'],
    // headless soft-denies approval-needing tools (writes/commands) while read
    // tools stay — read-only by default; agy's own --print-timeout (default 5m)
    // is pinned to match the 300s route bound. Doc-level verified (2026-08),
    // not yet machine-tested.
    exploreArgs: ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json', '--print-timeout', '5m'],
    resultField: 'response',
  },
};

/** auto-detection priority — market share as of 2026-08 */
export const DETECTION_ORDER = ['claude', 'codex', 'opencode', 'pi', 'cursor', 'devin', 'aider', 'agy'];

function isValidProfile(p: unknown): p is HarnessProfile {
  if (typeof p !== 'object' || p === null) {
    return false;
  }
  const o = p as Record<string, unknown>;
  return (
    typeof o.command === 'string' &&
    o.command.length > 0 &&
    Array.isArray(o.args) &&
    o.args.every((a) => typeof a === 'string') &&
    (o.exploreArgs === undefined ||
      (Array.isArray(o.exploreArgs) && o.exploreArgs.every((a) => typeof a === 'string')))
  );
}

/**
 * A custom entry replaces a same-named builtin wholesale (no field merge —
 * behavior stays predictable). Malformed custom entries are ignored, falling
 * back to the builtin if one exists.
 */
export function resolveHarness(
  name: string,
  custom: Record<string, HarnessProfile>,
): { name: string; profile: HarnessProfile } | undefined {
  const candidate = custom[name];
  const profile = isValidProfile(candidate) ? candidate : BUILTIN_HARNESSES[name];
  return profile ? { name, profile } : undefined;
}

/**
 * Expands ${prompt} in argv; with no placeholder the prompt goes to stdin.
 * `explore` picks the profile's exploreArgs when declared (capability gating
 * lives in HarnessRunner.supportsExplore — this only falls back gently).
 * `model` is appended as `--model <value>` — the one flag every builtin CLI
 * shares — kept ahead of a trailing stdin marker so flags precede the
 * positional (codex).
 */
export function buildInvocation(
  profile: HarnessProfile,
  prompt: string,
  explore = false,
  model?: string,
): { args: string[]; stdinPrompt?: string } {
  let substituted = false;
  let argv = explore && profile.exploreArgs ? profile.exploreArgs : profile.args;
  if (model) {
    argv =
      argv[argv.length - 1] === '-'
        ? [...argv.slice(0, -1), '--model', model, '-']
        : [...argv, '--model', model];
  }
  const args = argv.map((a) => {
    if (a.includes(PROMPT_PLACEHOLDER)) {
      substituted = true;
      return a.replaceAll(PROMPT_PLACEHOLDER, prompt);
    }
    return a;
  });
  return substituted ? { args } : { args, stdinPrompt: prompt };
}

/**
 * Extracts the final text from a harness's stdout per its profile: envelope
 * field when configured, error flag check, and raw passthrough for
 * plain-stdout CLIs or unparsable envelopes (the guide parser is tolerant).
 */
export function extractResult(
  stdout: string,
  profile: HarnessProfile,
): { ok: true; text: string } | { ok: false; error: string } {
  if (!profile.resultField && !profile.errorField) {
    return { ok: true, text: stdout };
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch (_e) {
    // older CLI or plain-text output — let the guide parser try the raw text
    return { ok: true, text: stdout };
  }
  const resultValue = profile.resultField ? envelope[profile.resultField] : undefined;
  if (profile.errorField && envelope[profile.errorField] === true) {
    return {
      ok: false,
      error: typeof resultValue === 'string' ? resultValue : 'the harness reported an error',
    };
  }
  return { ok: true, text: typeof resultValue === 'string' ? resultValue : stdout };
}
