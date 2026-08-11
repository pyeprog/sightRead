/**
 * TypeScript / JavaScript syntax (plus the react dialects).
 *
 * `using` is a soft keyword: the lookahead keeps `using = x` and `using(...)`
 * from reading as a resource block.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE =
  /^(\}|\)|\]|\{|\*|\.|:|\?|&&|\|\||else\b|catch\b|finally\b|case\b|default\b)/;
const SINGLE_KW_RE =
  /^(if|for|while|do|with|try|switch|return|throw|yield|break|continue|using(?=\s+[A-Za-z_$]))\b/;
const DEFINITION_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|enum|namespace)[\s*]+([A-Za-z_$][\w$]*)?/;
const FLOW_KEYWORDS = new Set(['return', 'throw', 'yield', 'break', 'continue']);

export function isContinuationLine(trimmed: string): boolean {
  return CONTINUATION_RE.test(trimmed);
}

export function isKeywordLead(trimmed: string): boolean {
  return SINGLE_KW_RE.test(trimmed);
}

export function classify(top: string[], opts: SegmentationOptions): Summary {
  const first = top[0];
  const kw = first.match(/^([A-Za-z_$][\w$]*)/)?.[1];
  if (kw && SINGLE_KW_RE.test(first)) {
    if (kw === 'if') {
      return { kind: 'branch', name: branchName(top), detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'for' || kw === 'while' || kw === 'do') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'with' || kw === 'using') {
      return { kind: 'with', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'try') {
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
  if (kw === 'import' || kw === 'require') {
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

/** `try`, `try/catch`, `try/catch/finally` */
function tryName(top: string[]): string {
  let catchCount = 0;
  let hasFinally = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    if (/^catch\b/.test(t)) {
      catchCount++;
      continue;
    }
    if (/^finally\b/.test(t)) {
      hasFinally = true;
    }
  }
  const parts = ['try'];
  if (catchCount > 0) {
    parts.push(`catch${catchCount > 1 ? `{${catchCount}}` : ''}`);
  }
  if (hasFinally) {
    parts.push('finally');
  }
  return parts.join('/');
}

/** The body opens at the line ending in `{` that leaves exactly one bracket
 *  open — a destructured parameter list's own `{` sits at depth 2 and never
 *  qualifies. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (trimmed, depth) => depth === 1 && trimmed.endsWith('{'));
}

export const tsJsSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
