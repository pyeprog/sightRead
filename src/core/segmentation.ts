/**
 * Automatic recursive function-body segmentation. Pure logic, no vscode dependency.
 *
 * Structure (design.md §3.4):
 *   1. blank lines separate segments;
 *   2. top-level blocks (if/loop/try/with/definitions — detected language-agnostically
 *      via indentation + continuation keywords) form their own segment and are
 *      segmented RECURSIVELY into child nodes;
 *   3. comment/decorator lines bind to the segment that follows them.
 *
 * Naming is structural, never content-copied from comments:
 *   - branches:     `if ... elif{2} ... else ...`
 *   - loops:        `for ...` / `while ...`
 *   - try:          `try ... except ... finally ...`
 *   - definitions:  `def foo` / `class Bar` (whatever keyword the language uses)
 *   - assignments:  `a=.. b=..`
 *   - calls:        `shutil.rmtree(...)` / `path.unlink()`
 *   - flow:         `return ...` / `raise ...`
 */

export type SegmentKind =
  | 'branch'
  | 'loop'
  | 'try'
  | 'with'
  | 'switch'
  | 'definition'
  | 'assignment'
  | 'call'
  | 'flow'
  | 'other';

export interface SegmentNode {
  /** inclusive, relative to the input `lines` array */
  startLine: number;
  /** inclusive */
  endLine: number;
  name: string;
  kind: SegmentKind;
  children: SegmentNode[];
  /**
   * Lines within this segment (own level only, not descendants) that head an
   * indented block — i.e. the language's folding-region headers: `if (x) {`,
   * `} else {`, `elif b:`, a multi-line call's opener, … Used by skeleton fold
   * to fold exactly these regions without ever touching the function's own fold.
   */
  headerLines?: number[];
}

export interface SegmentationOptions {
  /** a block unit shorter than this merges with neighbours like plain lines */
  minBlockLines: number;
  maxNameLength: number;
  /** recursion depth limit */
  maxDepth: number;
  /** max `a=..`/`f(...)` tokens in a statement-summary name */
  maxSummaryTokens: number;
}

export const DEFAULT_OPTIONS: SegmentationOptions = {
  minBlockLines: 3,
  maxNameLength: 60,
  maxDepth: 5,
  maxSummaryTokens: 4,
};

const BLANK_RE = /^\s*$/;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*|#|--|;)/;
const DECORATOR_RE = /^\s*@[\w.]+(\(|\s*$)/;
// A top-level line starting with one of these attaches to the unit above it
// instead of opening a new unit: closers, else/catch chains, method chains, etc.
const CONTINUATION_RE =
  /^(\}|\)|\]|\{|\*|\.|:|\?|&&|\|\||else\b|catch\b|finally\b|elif\b|elsif\b|except\b|rescue\b|case\b|default\b|then\b|end\b)/;

const DEFINITION_RE =
  /^(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+)*(def|function|class|fn|func|interface|struct|enum|trait|impl|object|module)[\s*!]+([A-Za-z_$][\w$]*)?/;

const FLOW_KEYWORDS = new Set([
  'return',
  'raise',
  'throw',
  'yield',
  'break',
  'continue',
  'pass',
]);

/** kinds whose block bodies are structure worth recursing into */
const RECURSIVE_KINDS = new Set<SegmentKind>([
  'branch',
  'loop',
  'try',
  'with',
  'switch',
  'definition',
  'other',
]);

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') {
      n++;
    } else if (ch === '\t') {
      n += 4;
    } else {
      break;
    }
  }
  return n;
}

interface ScopeInfo {
  blank: boolean[];
  indent: number[];
  baseIndent: number;
}

function analyze(lines: string[]): ScopeInfo {
  const blank = lines.map((l) => BLANK_RE.test(l));
  const indent = lines.map((l) => indentOf(l));
  let baseIndent = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < lines.length; i++) {
    if (!blank[i]) {
      baseIndent = Math.min(baseIndent, indent[i]);
    }
  }
  return { blank, indent, baseIndent };
}

interface Unit {
  start: number;
  end: number;
  hasBody: boolean;
  blankBefore: boolean;
  /** comment or decorator line — binds to the unit that follows */
  leading: boolean;
}

function groupUnits(lines: string[], info: ScopeInfo): Unit[] {
  const units: Unit[] = [];
  let pendingBlank = false;
  for (let i = 0; i < lines.length; i++) {
    if (info.blank[i]) {
      pendingBlank = units.length > 0;
      continue;
    }
    const isTop = info.indent[i] <= info.baseIndent;
    const isContinuation = isTop && CONTINUATION_RE.test(lines[i].trimStart());
    const last = units[units.length - 1];
    if (last && (!isTop || isContinuation)) {
      last.end = i;
      if (!isTop) {
        last.hasBody = true;
      }
      pendingBlank = false;
    } else {
      units.push({
        start: i,
        end: i,
        hasBody: false,
        blankBefore: pendingBlank,
        leading: COMMENT_RE.test(lines[i]) || DECORATOR_RE.test(lines[i]),
      });
      pendingBlank = false;
    }
  }
  return units;
}

interface Acc {
  start: number;
  end: number;
  big: boolean;
  leadingOnly: boolean;
}

function groupAccs(units: Unit[], opts: SegmentationOptions): Acc[] {
  const accs: Acc[] = [];
  let cur: Acc | null = null;
  for (const u of units) {
    const len = u.end - u.start + 1;
    const isBlock = u.hasBody && len >= opts.minBlockLines && !u.leading;
    if (!cur) {
      cur = { start: u.start, end: u.end, big: isBlock, leadingOnly: u.leading };
      continue;
    }
    if (cur.leadingOnly && !u.blankBefore) {
      // heading comment/decorator binds to whatever follows it
      cur.end = u.end;
      cur.big = isBlock;
      cur.leadingOnly = u.leading;
      continue;
    }
    if (u.blankBefore || isBlock || cur.big) {
      accs.push(cur);
      cur = { start: u.start, end: u.end, big: isBlock, leadingOnly: u.leading };
    } else {
      cur.end = u.end;
      cur.leadingOnly = false;
    }
  }
  if (cur) {
    accs.push(cur);
  }
  return accs;
}

export function segmentTree(
  lines: string[],
  opts: SegmentationOptions = DEFAULT_OPTIONS,
): SegmentNode[] {
  return buildScope(lines, 0, 0, opts);
}

function buildScope(
  lines: string[],
  offset: number,
  depth: number,
  opts: SegmentationOptions,
): SegmentNode[] {
  const info = analyze(lines);
  if (info.baseIndent === Number.MAX_SAFE_INTEGER) {
    return [];
  }
  const accs = groupAccs(groupUnits(lines, info), opts);
  return accs.map((a) => {
    const segLines = lines.slice(a.start, a.end + 1);
    const summary = summarize(segLines, info.baseIndent, opts);
    const recurse = a.big && depth < opts.maxDepth && RECURSIVE_KINDS.has(summary.kind);
    const children = recurse ? childScopes(lines, info, a, offset, depth, opts) : [];
    return {
      startLine: a.start + offset,
      endLine: a.end + offset,
      name: summary.name,
      kind: summary.kind,
      children,
      headerLines: headerLinesOf(info, a, offset),
    };
  });
}

/** Own-level lines whose next non-blank line is deeper — the fold-region headers. */
function headerLinesOf(info: ScopeInfo, acc: Acc, offset: number): number[] {
  const headers: number[] = [];
  for (let i = acc.start; i <= acc.end; i++) {
    if (info.blank[i] || info.indent[i] > info.baseIndent) {
      continue;
    }
    let j = i + 1;
    while (j <= acc.end && info.blank[j]) {
      j++;
    }
    if (j <= acc.end && info.indent[j] > info.baseIndent) {
      headers.push(i + offset);
    }
  }
  return headers;
}

/** Segments each strictly-deeper run inside a block into child nodes. */
function childScopes(
  lines: string[],
  info: ScopeInfo,
  acc: Acc,
  offset: number,
  depth: number,
  opts: SegmentationOptions,
): SegmentNode[] {
  const out: SegmentNode[] = [];
  let i = acc.start;
  while (i <= acc.end) {
    if (!info.blank[i] && info.indent[i] > info.baseIndent) {
      let j = i;
      let lastDeep = i;
      while (j <= acc.end && (info.blank[j] || info.indent[j] > info.baseIndent)) {
        if (!info.blank[j]) {
          lastDeep = j;
        }
        j++;
      }
      out.push(...buildScope(lines.slice(i, lastDeep + 1), offset + i, depth + 1, opts));
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// structural naming
// ---------------------------------------------------------------------------

interface Summary {
  kind: SegmentKind;
  name: string;
}

function summarize(
  segLines: string[],
  baseIndent: number,
  opts: SegmentationOptions,
): Summary {
  const top: string[] = [];
  for (const line of segLines) {
    if (BLANK_RE.test(line) || indentOf(line) > baseIndent) {
      continue;
    }
    if (COMMENT_RE.test(line) || DECORATOR_RE.test(line)) {
      continue;
    }
    top.push(line.trim());
  }
  if (top.length === 0) {
    const first = segLines.find((l) => !BLANK_RE.test(l))?.trim() ?? '';
    const lead = first.match(/^(\/\/|\/\*|#|--|;|@)/)?.[0] ?? '…';
    return { kind: 'other', name: `${lead} …` };
  }
  const summary = classify(top, opts);
  return { kind: summary.kind, name: truncate(summary.name, opts.maxNameLength) };
}

function classify(top: string[], opts: SegmentationOptions): Summary {
  const first = top[0];
  const kw = first.match(/^([A-Za-z_$][\w$]*)/)?.[1];

  if (kw === 'if' || kw === 'unless') {
    return { kind: 'branch', name: branchName(top) };
  }
  if (kw === 'for' || kw === 'foreach' || kw === 'while' || kw === 'do' || kw === 'loop') {
    return { kind: 'loop', name: `${kw} ...` };
  }
  if (kw === 'with' || kw === 'using') {
    return { kind: 'with', name: `${kw} ...` };
  }
  if (kw === 'try') {
    return { kind: 'try', name: tryName(top) };
  }
  if (kw === 'switch' || kw === 'match' || kw === 'select') {
    return { kind: 'switch', name: `${kw} ...` };
  }
  const def = first.match(DEFINITION_RE);
  if (def) {
    return { kind: 'definition', name: def[2] ? `${def[1]} ${def[2]}` : `${def[1]} ...` };
  }
  if (kw && FLOW_KEYWORDS.has(kw)) {
    const bare = first.replace(/[;\s]+$/, '') === kw;
    return { kind: 'flow', name: bare ? kw : `${kw} ...` };
  }
  if (kw === 'import' || kw === 'from' || kw === 'require' || kw === 'include') {
    return { kind: 'other', name: 'import ...' };
  }
  return statementSummary(top, opts);
}

/** `if ...`, `if ... else ...`, `if ... elif{3} ... else ...` */
function branchName(top: string[]): string {
  let elifKw: string | undefined;
  let elifCount = 0;
  let hasElse = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    const elif = t.match(/^(elif|elsif)\b/) ?? t.match(/^(else\s+if)\b/);
    if (elif) {
      elifKw = elif[1].replace(/\s+/g, ' ');
      elifCount++;
      continue;
    }
    if (/^else\b/.test(t)) {
      hasElse = true;
    }
  }
  const parts = ['if ...'];
  if (elifCount > 0) {
    parts.push(`${elifKw}${elifCount > 1 ? `{${elifCount}}` : ''} ...`);
  }
  if (hasElse) {
    parts.push('else ...');
  }
  return parts.join(' ');
}

/** `try ...`, `try ... except ...`, `try ... catch ... finally ...` */
function tryName(top: string[]): string {
  let catchKw: string | undefined;
  let catchCount = 0;
  let hasFinally = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    const c = t.match(/^(except|catch|rescue)\b/);
    if (c) {
      catchKw = c[1];
      catchCount++;
      continue;
    }
    if (/^finally\b/.test(t)) {
      hasFinally = true;
    }
  }
  const parts = ['try ...'];
  if (catchCount > 0) {
    parts.push(`${catchKw}${catchCount > 1 ? `{${catchCount}}` : ''} ...`);
  }
  if (hasFinally) {
    parts.push('finally ...');
  }
  return parts.join(' ');
}

/** `a=.. b=.. shutil.rmtree(...) …` built from assignment/call shapes. */
function statementSummary(top: string[], opts: SegmentationOptions): Summary {
  const tokens: string[] = [];
  let assigns = 0;
  let calls = 0;
  for (const t of top) {
    if (tokens.length > opts.maxSummaryTokens) {
      break;
    }
    const names = matchAssignment(t);
    if (names) {
      for (const n of names) {
        tokens.push(`${n}=..`);
      }
      assigns++;
      continue;
    }
    const call = matchCall(t);
    if (call) {
      tokens.push(call);
      calls++;
    }
  }
  if (tokens.length === 0) {
    return { kind: 'other', name: top[0] };
  }
  const name =
    tokens.length > opts.maxSummaryTokens
      ? tokens.slice(0, opts.maxSummaryTokens).join(' ') + ' …'
      : tokens.join(' ');
  const kind: SegmentKind =
    assigns > 0 && calls === 0 ? 'assignment' : calls > 0 && assigns === 0 ? 'call' : 'other';
  return { kind, name };
}

function matchAssignment(t: string): string[] | undefined {
  const m = t.match(
    /^(?:(?:const|let|var|final|local|global|nonlocal|my|our)\s+)?([A-Za-z_$][\w$.]*(?:\[[^\]]*\])?(?:\s*,\s*[A-Za-z_$][\w$.]*(?:\[[^\]]*\])?)*)\s*(?::\s*[^=]+?)?\s*(?:[-+*/%&|^]|<<|>>|\*\*|\/\/|\?\?)?=(?![=>])/,
  );
  if (!m) {
    return undefined;
  }
  return m[1].split(',').map((s) => s.trim());
}

function matchCall(t: string): string | undefined {
  const m = t.match(/^(?:await\s+|yield\s+|new\s+)?([A-Za-z_$][\w$.]*)\s*\(\s*(\))?/);
  if (!m) {
    return undefined;
  }
  return m[2] ? `${m[1]}()` : `${m[1]}(...)`;
}

function truncate(s: string, maxLength: number): string {
  return s.length > maxLength ? s.slice(0, maxLength - 1) + '…' : s;
}

/**
 * Heuristically strips the function signature and trailing closer lines from a
 * symbol range, leaving only body lines. `offset` is the index of the first
 * body line within the input.
 */
export function extractBody(lines: string[]): { offset: number; lines: string[] } {
  if (lines.length <= 1) {
    return { offset: lines.length, lines: [] };
  }
  let bodyStart = 1;
  const scanLimit = Math.min(lines.length - 1, 8);
  for (let i = 0; i < scanLimit; i++) {
    if (/[{:]\s*$/.test(lines[i].trimEnd())) {
      bodyStart = i + 1;
      break;
    }
  }
  let bodyEnd = lines.length;
  while (bodyEnd > bodyStart && /^[\s})\];,]*$/.test(lines[bodyEnd - 1])) {
    bodyEnd--;
  }
  return { offset: bodyStart, lines: lines.slice(bodyStart, bodyEnd) };
}
