/**
 * Python syntax.
 *
 * `match`/`case` are soft keywords: the lookaheads keep `match = re.match(...)`,
 * bare `match(...)` calls and `case = x` assignments from reading as statements.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE = /^(\}|\)|\]|\.|else\b|elif\b|except\b|finally\b|case\b(?!\s*=))/;
const SINGLE_KW_RE =
  /^(if|for|while|with|try|return|raise|yield|break|continue|pass|match(?=\s+[^=\s]))\b/;
const DEFINITION_RE = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)?/;
const FLOW_KEYWORDS = new Set(['return', 'raise', 'yield', 'break', 'continue', 'pass']);

export function isContinuationLine(trimmed: string): boolean {
  return CONTINUATION_RE.test(trimmed);
}

export function isKeywordLead(trimmed: string): boolean {
  return SINGLE_KW_RE.test(trimmed);
}

export function classify(top: string[], opts: SegmentationOptions): Summary {
  const first = top[0];
  const kw = first.match(/^([A-Za-z_]\w*)/)?.[1];
  if (kw && SINGLE_KW_RE.test(first)) {
    if (kw === 'if') {
      return { kind: 'branch', name: branchName(top), detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'for' || kw === 'while') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'with') {
      return { kind: 'with', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'try') {
      return { kind: 'try', name: tryName(top) };
    }
    if (kw === 'match') {
      return { kind: 'switch', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (FLOW_KEYWORDS.has(kw)) {
      const bare = first.replace(/[;\s]+$/, '') === kw;
      return { kind: 'flow', name: kw, detail: bare ? undefined : condenseHeader(first, kw, opts) };
    }
  }
  const def = first.match(DEFINITION_RE);
  if (def) {
    return { kind: 'definition', name: def[2] ? `${def[1]} ${def[2]}` : def[1] };
  }
  if (kw === 'import' || kw === 'from') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/elif{2}/else` */
function branchName(top: string[]): string {
  let elifCount = 0;
  let hasElse = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^elif\b/.test(t)) {
      elifCount++;
      continue;
    }
    if (/^else\b/.test(t)) {
      hasElse = true;
    }
  }
  const parts = ['if'];
  if (elifCount > 0) {
    parts.push(`elif${elifCount > 1 ? `{${elifCount}}` : ''}`);
  }
  if (hasElse) {
    parts.push('else');
  }
  return parts.join('/');
}

/** `try`, `try/except`, `try/except{2}/finally` */
function tryName(top: string[]): string {
  let exceptCount = 0;
  let hasFinally = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^except\b/.test(t)) {
      exceptCount++;
      continue;
    }
    if (/^finally\b/.test(t)) {
      hasFinally = true;
    }
  }
  const parts = ['try'];
  if (exceptCount > 0) {
    parts.push(`except${exceptCount > 1 ? `{${exceptCount}}` : ''}`);
  }
  if (hasFinally) {
    parts.push('finally');
  }
  return parts.join('/');
}

/** The body opens after the line ending in `:` with every bracket closed — a
 *  parameter list's annotations and defaults keep the depth above zero until
 *  the `) -> T:` line. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (trimmed, depth) => depth === 0 && trimmed.endsWith(':'));
}

export const pythonSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
