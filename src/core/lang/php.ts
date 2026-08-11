/**
 * PHP syntax. Variables all start with `$`, so keyword collisions are rare;
 * `elseif` and `else if` are both legal and the branch name keeps the source
 * spelling. `match` (PHP 8) is reserved and joins `switch` as dispatch;
 * `->`/`?->` method chains continue the line above.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE =
  /^(\}|\)|\]|\{|\.|->|\?|:|&&|\|\||else\b|elseif\b|catch\b|finally\b|case\b|default\b)/;
const SINGLE_KW_RE =
  /^(if|for|foreach|while|do|switch|match|try|return|throw|yield|break|continue)\b/;
const DEFINITION_RE =
  /^(?:(?:abstract|final|public|private|protected|static)\s+)*(function|class|interface|trait|enum)\s+&?([A-Za-z_]\w*)?/;
const FLOW_KEYWORDS = new Set(['return', 'throw', 'yield', 'break', 'continue']);

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
    if (kw === 'for' || kw === 'foreach' || kw === 'while' || kw === 'do') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'try') {
      return { kind: 'try', name: tryName(top) };
    }
    if (kw === 'switch' || kw === 'match') {
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
  if (kw === 'use' || kw === 'require' || kw === 'require_once' || kw === 'include') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/elseif{2}/else` — elseif spelling taken from the source. */
function branchName(top: string[]): string {
  let elseIfKw: string | undefined;
  let elseIfCount = 0;
  let hasElse = false;
  for (const raw of top.slice(1)) {
    const t = raw.replace(/^[})\];\s]+/, '');
    const elseIf = t.match(/^(elseif|else\s+if)\b/);
    if (elseIf) {
      elseIfKw = elseIf[1].replace(/\s+/g, ' ');
      elseIfCount++;
      continue;
    }
    if (/^else\b/.test(t)) {
      hasElse = true;
    }
  }
  const parts = ['if'];
  if (elseIfCount > 0) {
    parts.push(`${elseIfKw}${elseIfCount > 1 ? `{${elseIfCount}}` : ''}`);
  }
  if (hasElse) {
    parts.push('else');
  }
  return parts.join('/');
}

/** `try`, `try/catch`, `try/catch{2}/finally` */
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

/** Body opens at the line ending in `{` that leaves exactly one bracket open. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(lines, (trimmed, depth) => depth === 1 && trimmed.endsWith('{'));
}

export const phpSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
