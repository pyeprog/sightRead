/**
 * Classifies a pair of consecutive settled cursor states as a structural
 * navigation (design.md §3.7). Pure logic, no vscode dependency.
 *
 * Deliberately precision-first: anything ambiguous is no jump at all, and
 * every candidate returned here is verified against the definition provider
 * by the vs layer before it becomes an edge. Missed recall is covered by the
 * explicit "Pin Current Function to Trail" command.
 */

export interface SettledSymbol {
  name: string;
  /** first line of the definition range, inclusive */
  startLine: number;
  /** last line of the definition range, inclusive */
  endLine: number;
  /** the cursor sits on the symbol's own name */
  onName: boolean;
}

export interface SettledState {
  uriString: string;
  line: number;
  /** word under the cursor at settle time */
  word?: string;
  /** innermost enclosing symbol — header lines count as the symbol itself */
  at?: SettledSymbol;
}

export interface JumpCandidate {
  type: 'drill-in' | 'ref-jump';
  /** which state's enclosing scope is the caller (its `at`, or its module) */
  caller: 'prev' | 'curr';
  /** call-site line, in the caller state's document */
  callsiteLine: number;
}

/**
 * A raw (undebounced) cursor observation. Fast jump gestures — Cmd+click,
 * click-then-F12 within the debounce window — never let the departure point
 * settle, so the settled-pair classification cannot see it; the raw trace is
 * where the departure survives.
 */
export interface RawCursorState {
  uriString: string;
  line: number;
  character: number;
  word?: string;
  ms: number;
}

/**
 * The departure point of the jump that landed at `landing`: the latest raw
 * state on a different line, no newer than the landing and within the time
 * window. States newer than the landing belong to later activity (replay).
 */
export function pickDeparture(
  history: RawCursorState[],
  landing: { uriString: string; line: number; ms: number },
  windowMs: number,
): RawCursorState | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.ms > landing.ms) {
      continue;
    }
    if (h.uriString === landing.uriString && h.line === landing.line) {
      continue;
    }
    return landing.ms - h.ms <= windowMs ? h : undefined;
  }
  return undefined;
}

/** C-family symbol names carry parameter lists ("foo(int)") the word never has. */
export function stripParens(name: string): string {
  return name.replace(/\([^)]*\)/g, '').trim();
}

function sameSymbol(a: SettledState, b: SettledState): boolean {
  return (
    !!a.at &&
    !!b.at &&
    a.uriString === b.uriString &&
    a.at.startLine === b.at.startLine &&
    a.at.endLine === b.at.endLine &&
    a.at.name === b.at.name
  );
}

/**
 * The two structural gestures, recognized by their semantic signature rather
 * than by the input gesture — F12, Cmd+click, a peek pick and a plain click
 * onto the line all read the same:
 *
 * - drill-in — landed on a symbol's own name, coming from a mention of that
 *   name: the previous scope calls the landed symbol.
 * - ref-jump — landed on a mention of the symbol just read: the landing
 *   scope calls the previous symbol (the caller becomes the parent).
 *
 * A candidate with `caller` pointing at a state whose `at` is undefined means
 * the caller is that document's module top level (script code).
 */
export function classifyJump(
  prev: SettledState,
  curr: SettledState,
): JumpCandidate | undefined {
  // no movement across lines — clicking around one line is never a jump
  if (prev.uriString === curr.uriString && prev.line === curr.line) {
    return undefined;
  }

  // drill into a definition; re-clicking the name we were already on is not
  // a self call, but arriving from a call site inside the same symbol is
  // (recursion)
  if (
    curr.at?.onName &&
    prev.word !== undefined &&
    stripParens(curr.at.name) === prev.word &&
    !(sameSymbol(prev, curr) && prev.at!.onName)
  ) {
    return { type: 'drill-in', caller: 'prev', callsiteLine: prev.line };
  }

  // jump to a reference of the symbol just read; landing on any definition
  // header is a definition, not a call site
  if (
    prev.at &&
    curr.word !== undefined &&
    stripParens(prev.at.name) === curr.word &&
    !curr.at?.onName
  ) {
    return { type: 'ref-jump', caller: 'curr', callsiteLine: curr.line };
  }

  return undefined;
}
