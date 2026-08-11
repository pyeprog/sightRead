/**
 * Automatic recursive function-body segmentation. Pure logic, no vscode
 * dependency.
 *
 * Structure (design.md §3.4):
 *   1. blank lines separate segments;
 *   2. top-level blocks (if/loop/try/with/definitions — detected via
 *      indentation + the language's continuation keywords) form their own
 *      segment and are segmented RECURSIVELY into child nodes;
 *   3. comment/decorator lines bind to the segment that follows them.
 *
 * Everything language-specific — continuation/keyword detection, structural
 * naming, signature-end scanning — is delegated to a `LanguageSyntax`
 * function group: one module per language under lang/, picked wholesale via
 * `syntaxFor(languageId)`. This module owns only the language-independent
 * structure: unit grouping, segment accumulation, recursion, fold headers.
 *
 * Naming is structural, never content-copied from comments — `if/elif{2}/else`,
 * `for`, `try/except`, `def foo`, `related=_expand(...)`, `return` — see the
 * `classify` chain in each language module for the per-kind name shapes.
 * Keyword nodes carry their condensed header expression in `detail` instead,
 * rendered as dimmed description text by the views.
 */

import { truncate } from './lang/expression';
import { genericSyntax } from './lang/generic';
import { LanguageSyntax, SegmentKind, SegmentationOptions, Summary } from './lang/types';

export type { SegmentKind, SegmentationOptions } from './lang/types';

export interface SegmentNode {
  /** inclusive, relative to the input `lines` array */
  startLine: number;
  /** inclusive */
  endLine: number;
  name: string;
  kind: SegmentKind;
  /**
   * Condensed header expression — the `if` condition, loop header, `return`
   * value… Rendered as dimmed detail text next to the structural name.
   */
  detail?: string;
  children: SegmentNode[];
  /**
   * Lines within this segment (own level only, not descendants) that head an
   * indented block — i.e. the language's folding-region headers: `if (x) {`,
   * `} else {`, `elif b:`, a multi-line call's opener, … Used by skeleton fold
   * to fold exactly these regions without ever touching the function's own fold.
   */
  headerLines?: number[];
}

export const DEFAULT_OPTIONS: SegmentationOptions = {
  minBlockLines: 3,
  maxNameLength: 60,
  maxDepth: 5,
  maxSummaryTokens: 4,
  maxDetailLength: 30,
};

const BLANK_RE = /^\s*$/;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*|#|--|;)/;
const DECORATOR_RE = /^\s*@[\w.]+(\(|\s*$)/;

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
  /** first line opens with a structural keyword — see `LanguageSyntax.isKeywordLead` */
  kwLead: boolean;
}

function groupUnits(lines: string[], info: ScopeInfo, syntax: LanguageSyntax): Unit[] {
  const units: Unit[] = [];
  let pendingBlank = false;
  for (let i = 0; i < lines.length; i++) {
    if (info.blank[i]) {
      pendingBlank = units.length > 0;
      continue;
    }
    const isTop = info.indent[i] <= info.baseIndent;
    const isContinuation = isTop && syntax.isContinuationLine(lines[i].trimStart());
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
        kwLead: syntax.isKeywordLead(lines[i].trimStart()),
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
  /** ends on a bodyless keyword statement — nothing may merge in after it */
  sealed: boolean;
}

function groupAccs(units: Unit[], opts: SegmentationOptions): Acc[] {
  const accs: Acc[] = [];
  let cur: Acc | null = null;
  for (const u of units) {
    const len = u.end - u.start + 1;
    const isBlock = u.hasBody && len >= opts.minBlockLines && !u.leading;
    // `if (!x) return;`, `return y;` — a keyword statement with no block of its
    // own. It stands alone so that `classify` names it after its own line.
    const sealed = u.kwLead && !u.hasBody && !u.leading;
    if (!cur) {
      cur = { start: u.start, end: u.end, big: isBlock, leadingOnly: u.leading, sealed };
      continue;
    }
    if (cur.leadingOnly && !u.blankBefore) {
      // heading comment/decorator binds to whatever follows it
      cur.end = u.end;
      cur.big = isBlock;
      cur.leadingOnly = u.leading;
      cur.sealed = sealed;
      continue;
    }
    if (u.blankBefore || isBlock || cur.big || cur.sealed || sealed) {
      accs.push(cur);
      cur = { start: u.start, end: u.end, big: isBlock, leadingOnly: u.leading, sealed };
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
  syntax: LanguageSyntax = genericSyntax,
): SegmentNode[] {
  return buildScope(lines, 0, 0, opts, syntax);
}

function buildScope(
  lines: string[],
  offset: number,
  depth: number,
  opts: SegmentationOptions,
  syntax: LanguageSyntax,
): SegmentNode[] {
  const info = analyze(lines);
  if (info.baseIndent === Number.MAX_SAFE_INTEGER) {
    return [];
  }
  const accs = groupAccs(groupUnits(lines, info, syntax), opts);
  return accs.map((a) => {
    const segLines = lines.slice(a.start, a.end + 1);
    const summary = summarize(segLines, info.baseIndent, opts, syntax);
    const recurse = a.big && depth < opts.maxDepth && RECURSIVE_KINDS.has(summary.kind);
    const children = recurse ? childScopes(lines, info, a, offset, depth, opts, syntax) : [];
    return {
      startLine: a.start + offset,
      endLine: a.end + offset,
      name: summary.name,
      kind: summary.kind,
      detail: summary.detail,
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
  syntax: LanguageSyntax,
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
      out.push(
        ...buildScope(lines.slice(i, lastDeep + 1), offset + i, depth + 1, opts, syntax),
      );
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function summarize(
  segLines: string[],
  baseIndent: number,
  opts: SegmentationOptions,
  syntax: LanguageSyntax,
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
  const summary = syntax.classify(top, opts);
  return {
    kind: summary.kind,
    name: truncate(summary.name, opts.maxNameLength),
    detail: summary.detail,
  };
}

/**
 * Strips the function signature and trailing closer lines from a symbol
 * range, leaving only body lines. Where the signature ends is the language's
 * call (`LanguageSyntax.findBodyStart`); the trailing closer trim is
 * language-independent. `offset` is the index of the first body line within
 * the input.
 */
export function extractBody(
  lines: string[],
  syntax: LanguageSyntax = genericSyntax,
): { offset: number; lines: string[] } {
  if (lines.length <= 1) {
    return { offset: lines.length, lines: [] };
  }
  const bodyStart = syntax.findBodyStart(lines);
  let bodyEnd = lines.length;
  while (bodyEnd > bodyStart && /^[\s})\];,]*$/.test(lines[bodyEnd - 1])) {
    bodyEnd--;
  }
  return { offset: bodyStart, lines: lines.slice(bodyStart, bodyEnd) };
}
