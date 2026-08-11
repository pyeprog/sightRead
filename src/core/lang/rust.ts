/**
 * Rust syntax. `match` is the dispatch statement; error handling is
 * Result-based (`?`), so there is no try chain. `match` is a hard keyword
 * here — unlike Python/JS it can never be an identifier.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE = /^(\}|\)|\]|\{|\.|&&|\|\||else\b)/;
const SINGLE_KW_RE = /^(if|for|while|loop|match|return|break|continue)\b/;
const DEFINITION_RE =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const)\s+)*(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)?/;
const FLOW_KEYWORDS = new Set(['return', 'break', 'continue']);

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
    if (kw === 'for' || kw === 'while' || kw === 'loop') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
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
  if (kw === 'use') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/else if{2}/else` — covers `else if let` chains too. */
function branchName(top: string[]): string {
  let elseIfCount = 0;
  let hasElse = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^else\s+if\b/.test(t)) {
      elseIfCount++;
      continue;
    }
    if (/^else\b/.test(t)) {
      hasElse = true;
    }
  }
  const parts = ['if'];
  if (elseIfCount > 0) {
    parts.push(`else if${elseIfCount > 1 ? `{${elseIfCount}}` : ''}`);
  }
  if (hasElse) {
    parts.push('else');
  }
  return parts.join('/');
}

/** Body opens at the line ending in `{` that leaves exactly one bracket open
 *  — `-> Result<(), Error> {` closes the parameter list first. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (trimmed, depth) => depth === 1 && trimmed.endsWith('{'));
}

export const rustSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
