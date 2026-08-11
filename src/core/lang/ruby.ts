/**
 * Ruby syntax. Blocks close with `end`, so the def line itself is the whole
 * signature — the body starts at the first line where every bracket is closed
 * (line 1 for a single-line `def`). `begin/rescue/ensure` is the try chain,
 * `case/when` the dispatch, `unless`/`until` the negated branch/loop.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE =
  /^(\}|\)|\]|\.|else\b|elsif\b|rescue\b|ensure\b|when\b|then\b|end\b)/;
const SINGLE_KW_RE =
  /^(if|unless|for|while|until|loop|case|begin|return|raise|yield|break|next)\b/;
const DEFINITION_RE = /^(def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[?!]?)?/;
const FLOW_KEYWORDS = new Set(['return', 'raise', 'yield', 'break', 'next']);

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
    if (kw === 'if' || kw === 'unless') {
      return { kind: 'branch', name: branchName(top), detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'for' || kw === 'while' || kw === 'until' || kw === 'loop') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'begin') {
      return { kind: 'try', name: tryName(top) };
    }
    if (kw === 'case') {
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
  if (kw === 'require' || kw === 'require_relative' || kw === 'include') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/elsif{2}/else` — `unless` heads its own chain. */
function branchName(top: string[]): string {
  const lead = top[0].startsWith('unless') ? 'unless' : 'if';
  let elsifCount = 0;
  let hasElse = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^elsif\b/.test(t)) {
      elsifCount++;
      continue;
    }
    if (/^else\b/.test(t)) {
      hasElse = true;
    }
  }
  const parts = [lead];
  if (elsifCount > 0) {
    parts.push(`elsif${elsifCount > 1 ? `{${elsifCount}}` : ''}`);
  }
  if (hasElse) {
    parts.push('else');
  }
  return parts.join('/');
}

/** `begin`, `begin/rescue`, `begin/rescue{2}/ensure` */
function tryName(top: string[]): string {
  let rescueCount = 0;
  let hasEnsure = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^rescue\b/.test(t)) {
      rescueCount++;
      continue;
    }
    if (/^ensure\b/.test(t)) {
      hasEnsure = true;
    }
  }
  const parts = ['begin'];
  if (rescueCount > 0) {
    parts.push(`rescue${rescueCount > 1 ? `{${rescueCount}}` : ''}`);
  }
  if (hasEnsure) {
    parts.push('ensure');
  }
  return parts.join('/');
}

/** The signature has no opener character: the body starts at the first line
 *  where every bracket is closed — after the `)` of a multi-line parameter
 *  list, or immediately after a single-line `def`. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (_trimmed, depth) => depth === 0);
}

export const rubySyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
