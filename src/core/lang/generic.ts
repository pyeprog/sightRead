/**
 * Generic fallback syntax for languages without a dedicated module — the
 * historical mixed-keyword heuristic, every supported language's markers in
 * one table. Behaves exactly as segmentation did before per-language dispatch
 * existed. New languages should get their own module instead of growing this
 * one.
 */

import { condenseHeader, scanSignatureEnd, statementSummary } from './expression';
import { LanguageSyntax, SegmentationOptions, Summary } from './types';

const CONTINUATION_RE =
  /^(\}|\)|\]|\{|\*|\.|:|\?|&&|\|\||else\b|catch\b|finally\b|elif\b|elsif\b|except\b|rescue\b|case\b|default\b|then\b|end\b)/;
const SINGLE_KW_RE =
  /^(if|unless|for|foreach|while|do|loop|with|using|try|switch|match|select|return|raise|throw|yield|break|continue|pass)\b/;
const DEFINITION_RE =
  /^(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+)*(def|function|class|fn|func|interface|struct|enum|trait|impl|object|module)[\s*!]+([A-Za-z_$][\w$]*)?/;
const FLOW_KEYWORDS = new Set(['return', 'raise', 'throw', 'yield', 'break', 'continue', 'pass']);

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
    if (kw === 'if' || kw === 'unless') {
      return { kind: 'branch', name: branchName(top), detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'for' || kw === 'foreach' || kw === 'while' || kw === 'do' || kw === 'loop') {
      return { kind: 'loop', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'with' || kw === 'using') {
      return { kind: 'with', name: kw, detail: condenseHeader(first, kw, opts) };
    }
    if (kw === 'try') {
      return { kind: 'try', name: tryName(top) };
    }
    if (kw === 'switch' || kw === 'match' || kw === 'select') {
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
  if (kw === 'import' || kw === 'from' || kw === 'require' || kw === 'include') {
    return { kind: 'other', name: 'import' };
  }
  return statementSummary(top, opts);
}

/** `if`, `if/else`, `if/elif{3}/else` — elif spelling taken from the source. */
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
  const parts = ['if'];
  if (elifCount > 0) {
    parts.push(`${elifKw}${elifCount > 1 ? `{${elifCount}}` : ''}`);
  }
  if (hasElse) {
    parts.push('else');
  }
  return parts.join('/');
}

/** `try`, `try/except`, `try/catch/finally` — catch spelling taken from the source. */
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
  const parts = ['try'];
  if (catchCount > 0) {
    parts.push(`${catchKw}${catchCount > 1 ? `{${catchCount}}` : ''}`);
  }
  if (hasFinally) {
    parts.push('finally');
  }
  return parts.join('/');
}

/** Language unknown, so both signature endings count: a `{` leaving one
 *  bracket open, or a `:` with every bracket closed — whichever comes first. */
export function findBodyStart(lines: string[]): number {
  return scanSignatureEnd(
    lines,
    (trimmed, depth) =>
      (depth === 1 && trimmed.endsWith('{')) || (depth === 0 && trimmed.endsWith(':')),
  );
}

export const genericSyntax: LanguageSyntax = {
  isContinuationLine,
  isKeywordLead,
  classify,
  findBodyStart,
};
