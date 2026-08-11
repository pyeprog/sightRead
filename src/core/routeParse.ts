/**
 * Parsing/validation of an agent's reading-route response. Pure logic, no
 * vscode dependency. The agent is asked for bare JSON (see routePrompt.ts)
 * but real responses may wrap it in fences or prose — tolerated via
 * guideParse's extractJson.
 *
 * The hops array order carries no meaning — structure comes only from
 * calledBy references, resolved here into 0-based calledFrom indexes.
 */

import { extractJson } from './guideParse';
import { TrailNodeKind } from './trail';

export interface RouteHop {
  /** workspace-relative path as the agent reported it */
  file: string;
  symbol: string;
  containerName?: string;
  /** unknown values fall back to 'function' */
  kind: TrailNodeKind;
  /** 0-based definition line hint; undefined when the agent gave none */
  line?: number;
  /** why this hop is on the route */
  note?: string;
  /** scenario A: the meat of the goal; scenario B: an entry */
  core?: boolean;
  /** 0-based index into the surviving hops; undefined = root */
  calledFrom?: number;
  /** 0-based call-site line in the calledFrom hop */
  callsiteLine?: number;
}

export interface Route {
  summary?: string;
  hops: RouteHop[];
  /** human-readable log of hops dropped or re-rooted during parsing */
  dropped: string[];
}

export type RouteParseResult = { ok: true; route: Route } | { ok: false; error: string };

/** hard safety guard against runaway responses — the quality bound
 *  (≤12 hops per tree, tree count unbounded) lives in the prompt contract */
const MAX_HOPS = 60;
const MAX_NOTE_CHARS = 100;
const KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'module']);

/** 1-based number in the response → 0-based internally; anything else is unknown. */
function toZeroBased(v: unknown): number | undefined {
  return typeof v === 'number' && v >= 1 ? Math.floor(v) - 1 : undefined;
}

export function parseRouteResponse(raw: string): RouteParseResult {
  const parsed = extractJson(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'the response contains no JSON object' };
  }
  const obj = parsed as { summary?: unknown; hops?: unknown };
  const summary =
    typeof obj.summary === 'string' && obj.summary.trim() !== '' ? obj.summary.trim() : undefined;
  if (!Array.isArray(obj.hops)) {
    return { ok: false, error: 'the response JSON has no "hops" array' };
  }
  if (obj.hops.length === 0) {
    // the contract's no-route escape: the summary says what the agent found instead
    return { ok: false, error: summary ?? 'the agent found no route' };
  }

  // pass 1 — each hop on its own merits; original 1-based number → surviving index
  const dropped: string[] = [];
  const drafts: (RouteHop & { calledByNumber?: number })[] = [];
  const surviving = new Map<number, number>();
  obj.hops.forEach((h: unknown, i: number) => {
    if (drafts.length >= MAX_HOPS) {
      dropped.push(`hop ${i + 1} dropped: over the ${MAX_HOPS}-hop safety cap`);
      return;
    }
    if (typeof h !== 'object' || h === null) {
      dropped.push(`hop ${i + 1} dropped: not an object`);
      return;
    }
    const { file, symbol, container, kind, line, note, core, calledBy, callsiteLine } = h as Record<
      string,
      unknown
    >;
    if (typeof file !== 'string' || file.trim() === '') {
      dropped.push(`hop ${i + 1} dropped: missing "file"`);
      return;
    }
    if (typeof symbol !== 'string' || symbol.trim() === '') {
      dropped.push(`hop ${i + 1} dropped: missing "symbol"`);
      return;
    }
    surviving.set(i + 1, drafts.length);
    drafts.push({
      file: file.trim(),
      symbol: symbol.trim(),
      containerName:
        typeof container === 'string' && container.trim() !== '' ? container.trim() : undefined,
      kind: (typeof kind === 'string' && KINDS.has(kind) ? kind : 'function') as TrailNodeKind,
      line: toZeroBased(line),
      note:
        typeof note === 'string' && note.trim() !== ''
          ? note.trim().slice(0, MAX_NOTE_CHARS)
          : undefined,
      core: core === true ? true : undefined,
      calledByNumber: typeof calledBy === 'number' ? Math.floor(calledBy) : undefined,
      callsiteLine: toZeroBased(callsiteLine),
    });
  });
  if (drafts.length === 0) {
    return { ok: false, error: 'the response has no valid hops' };
  }

  // pass 2 — resolve links; a reference to a dropped hop or to itself re-roots
  const hops: RouteHop[] = drafts.map(({ calledByNumber, ...hop }, i) => {
    const target = calledByNumber === undefined ? undefined : surviving.get(calledByNumber);
    const calledFrom = target !== undefined && target !== i ? target : undefined;
    if (calledByNumber !== undefined && calledFrom === undefined) {
      dropped.push(
        `hop "${hop.symbol}" re-rooted: calledBy ${calledByNumber} is dropped, unknown, or itself`,
      );
    }
    return {
      ...hop,
      calledFrom,
      callsiteLine: calledFrom === undefined ? undefined : hop.callsiteLine,
    };
  });
  // break cycles deterministically: the lowest-index hop whose chain returns
  // to itself loses its link and becomes a root
  hops.forEach((hop, i) => {
    const seen = new Set<number>();
    let p = hop.calledFrom;
    while (p !== undefined && !seen.has(p)) {
      if (p === i) {
        hop.calledFrom = undefined;
        hop.callsiteLine = undefined;
        dropped.push(`hop "${hop.symbol}" re-rooted: its calledBy chain loops back to it`);
        return;
      }
      seen.add(p);
      p = hops[p].calledFrom;
    }
  });

  return { ok: true, route: { summary, hops, dropped } };
}
