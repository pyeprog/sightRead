/**
 * Swift syntax. `guard` is a branch, `do { … } catch { … }` is the try chain
 * (`try` itself is an expression prefix, not a block, so it stays out of the
 * keyword set and the statement summary picks up the underlying call).
 * `defer` is a scope-exit block (with kind), `repeat` the do-while loop.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE =
  /^(\}|\)|\]|\{|\.|\?|&&|\|\||else\b|catch\b|case\b|default\b)/;
const SINGLE_KW_RE =
  /^(if|guard|for|while|repeat|switch|do|defer|return|throw|break|continue|fallthrough)\b/;
const DEFINITION_RE =
  /^(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|class)\s+)*(func|class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)?/;
const FLOW_KEYWORDS = new Set(['return', 'throw', 'break', 'continue', 'fallthrough']);

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
    if (kw === 'guard') {
      return { kind: 'branch', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'for' || kw === 'while' || kw === 'repeat') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'defer') {
      return { kind: 'with', name: kw };
    }
    if (kw === 'do') {
      return { kind: 'try', name: tryName(top) };
    }
    if (kw === 'switch') {
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
  if (kw === 'import') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/else if{2}/else` */
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

/** `do`, `do/catch`, `do/catch{2}` */
function tryName(top: string[]): string {
  let catchCount = 0;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^catch\b/.test(t)) {
      catchCount++;
    }
  }
  const parts = ['do'];
  if (catchCount > 0) {
    parts.push(`catch${catchCount > 1 ? `{${catchCount}}` : ''}`);
  }
  return parts.join('/');
}

/** Body opens at the line ending in `{` that leaves exactly one bracket open. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (trimmed, depth) => depth === 1 && trimmed.endsWith('{'));
}

export const swiftSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
