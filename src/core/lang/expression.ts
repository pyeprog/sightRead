/**
 * Language-neutral expression utilities shared by the per-language syntax
 * modules. Everything here condenses or summarizes expressions mechanically;
 * deciding what a keyword means in a concrete language is the language
 * modules' job, not this one's.
 */

import { SegmentKind, SegmentationOptions, Summary } from './types';

export const STRING_LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

// ---------------------------------------------------------------------------
// statement summary — `a=f(...)` dataflow edges
// ---------------------------------------------------------------------------

/** `related,seed_rows=_expand(...) _trace(...) …` — one token per top-level
 *  line. Each token is a dataflow edge: the names produced and the call that
 *  produced them. A call-free assignment keeps the bare `a=..` form, a bare
 *  call keeps its callee. */
export function statementSummary(top: string[], opts: SegmentationOptions): Summary {
  const tokens: string[] = [];
  let assigns = 0;
  for (const t of top) {
    if (tokens.length > opts.maxSummaryTokens) {
      break;
    }
    const names = matchAssignment(t);
    if (names) {
      const call = findCall(stripLhs(t));
      if (call) {
        tokens.push(`${names.join(',')}=${call}`);
      } else {
        for (const n of names) {
          tokens.push(`${n}=..`);
        }
      }
      assigns++;
      continue;
    }
    const call = findCall(t);
    if (call) {
      tokens.push(call);
    }
  }
  if (tokens.length === 0) {
    return { kind: 'other', name: top[0] };
  }
  const name =
    tokens.length > opts.maxSummaryTokens
      ? tokens.slice(0, opts.maxSummaryTokens).join(' ') + ' …'
      : tokens.join(' ');
  // a segment that assigns reads as producing values, even when it also calls
  const kind: SegmentKind = assigns > 0 ? 'assignment' : 'call';
  return { kind, name };
}

const ASSIGNMENT_RE =
  /^(?:(?:const|let|var|final|local|global|nonlocal|my|our)\s+)?([A-Za-z_$][\w$.]*(?:\[[^\]]*\])?(?:\s*,\s*[A-Za-z_$][\w$.]*(?:\[[^\]]*\])?)*)\s*(?::\s*[^=]+?)?\s*(?:[-+*/%&|^]|<<|>>|\*\*|\/\/|\?\?)?=(?![=>])/;

function matchAssignment(t: string): string[] | undefined {
  const m = t.match(ASSIGNMENT_RE);
  if (!m) {
    return undefined;
  }
  return m[1].split(',').map((s) => s.trim());
}

/** Drops the `a, b =` prefix so call detection starts at the right-hand side. */
function stripLhs(t: string): string {
  const m = t.match(ASSIGNMENT_RE);
  return m ? t.slice(m[0].length) : t;
}

/** Keywords that read like a call when followed by `(` but name no operation. */
const NON_CALL_WORDS = new Set([
  'if', 'unless', 'elif', 'elsif', 'else', 'for', 'foreach', 'while', 'switch',
  'match', 'case', 'when', 'catch', 'except', 'in', 'and', 'or', 'not',
  'return', 'yield', 'await', 'new', 'typeof', 'lambda', 'function',
]);

/** An operator right before the call demotes it to an operand: `total / len(xs)`. */
const PRECEDING_OPERATOR_RE = /[+\-*/%<>&|^~!?:=]\s*$/;

/**
 * First call anywhere in the expression (string literals masked out first),
 * skipping keyword pseudo-calls and operator-fed operands. A conditional
 * expression yields nothing — its branches disagree on what the verb is.
 */
function findCall(raw: string): string | undefined {
  const expr = raw.replace(STRING_LITERAL_RE, "''");
  if (isConditional(expr)) {
    return undefined;
  }
  const re = /([A-Za-z_$][\w$.]*)\s*\(\s*(\))?/g;
  for (let m = re.exec(expr); m; m = re.exec(expr)) {
    const path = m[1];
    if (NON_CALL_WORDS.has(path.split('.')[0])) {
      continue;
    }
    if (PRECEDING_OPERATOR_RE.test(expr.slice(0, m.index))) {
      continue;
    }
    return `${shortenPath(path)}${m[2] ? '()' : '(...)'}`;
  }
  return undefined;
}

/** Top-level ternary / Python `x if c else y`; `?.` and `??` are not ternaries. */
function isConditional(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (depth === 0 && ch === '?') {
      if (expr[i + 1] === '.' || expr[i + 1] === '?') {
        i++;
        continue;
      }
      return true;
    }
  }
  return / if .+ else /.test(expr);
}

/** `vscode.workspace.textDocuments.find` → `textDocuments.find`; `self._gate` → `_gate`. */
export function shortenPath(path: string): string {
  const parts = path.split('.').filter((p) => p !== 'self' && p !== 'this' && p !== 'cls');
  return parts.slice(-2).join('.') || path;
}

export function truncate(s: string, maxLength: number): string {
  return s.length > maxLength ? s.slice(0, maxLength - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// header-expression condensation (the node `detail`)
// ---------------------------------------------------------------------------
// `if (user.role === 'admin' && flags.isEnabled(ctx, 'x')) {`
//   → `user.role === '…' && …`
// Purely mechanical: string literals and depth-2+ bracket groups collapse to
// `…`, then a hard token/char budget cuts at a token boundary.

// trailing block openers carry no information: `{`, `:`, `;`, `then`/`do`/`begin`
const TRAILING_OPENER_RE = /\s*(?:\{|;|:|\bthen|\bdo|\bbegin)\s*$/;
const BRACKET_CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

export function condenseHeader(
  first: string,
  kw: string,
  opts: SegmentationOptions,
): string | undefined {
  let rest = first.slice(kw.length).replace(STRING_LITERAL_RE, "'…'").trim();
  for (let prev = ''; prev !== rest; ) {
    prev = rest;
    rest = rest.replace(TRAILING_OPENER_RE, '');
  }
  // a condition that is exactly one paren group loses its wrapper
  while (rest.startsWith('(') && matchingBracket(rest, 0) === rest.length - 1) {
    rest = rest.slice(1, -1).trim();
  }
  rest = collapseNested(rest).replace(/\s+/g, ' ').trim();
  const tokens = rest.split(' ');
  if (tokens.length > opts.maxSummaryTokens) {
    rest = tokens.slice(0, opts.maxSummaryTokens).join(' ') + ' …';
  }
  rest = truncate(rest, opts.maxDetailLength);
  return rest === '' || rest === '…' ? undefined : rest;
}

function matchingBracket(s: string, open: number): number {
  const opener = s[open];
  const closer = BRACKET_CLOSER[opener];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === opener) {
      depth++;
    } else if (s[i] === closer) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Keeps depth-0/1 text; deeper bracket groups collapse to `(…)`. */
function collapseNested(s: string): string {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 2) {
        out += ch + '…' + BRACKET_CLOSER[ch];
      } else if (depth === 1) {
        out += ch;
      }
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth <= 1) {
        out += ch;
      }
      depth = Math.max(0, depth - 1);
    } else if (depth < 2) {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// signature-end scanning
// ---------------------------------------------------------------------------

/**
 * Scans for the end of a definition's signature. Bracket depth is accumulated
 * line by line (string literals masked out) and each line's trimmed tail is
 * offered to `isBodyOpener` together with the depth so far; the language
 * module supplies the opener semantics (`{` at depth 1, `:` at depth 0, …).
 * Returns the index of the first body line, 1 when nothing matches. The scan
 * window is 8 lines, extended while brackets stay open — an unclosed bracket
 * proves the signature continues.
 */
export function scanSignatureEnd(
  lines: string[],
  isBodyOpener: (trimmedLine: string, depth: number) => boolean,
): number {
  const scanLimit = Math.min(lines.length - 1, 8);
  let depth = 0;
  for (let i = 0; i < lines.length - 1 && (i < scanLimit || depth > 0); i++) {
    const masked = lines[i].replace(STRING_LITERAL_RE, "''");
    depth += bracketDelta(masked);
    if (isBodyOpener(masked.trimEnd(), depth)) {
      return i + 1;
    }
  }
  return 1;
}

function bracketDelta(s: string): number {
  let d = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      d++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      d--;
    }
  }
  return d;
}
