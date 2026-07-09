/**
 * Choice of the enclosing function among the symbols containing the cursor.
 * Pure logic, no vscode dependency.
 */

export interface EnclosingCandidate {
  /** first line of the symbol range, inclusive */
  startLine: number;
  /** last line of the symbol range, inclusive */
  endLine: number;
  /** reported as a function-like symbol (Function/Method/Constructor) */
  fnKind: boolean;
}

function innermost<T extends EnclosingCandidate>(pool: T[]): T | undefined {
  let best: T | undefined;
  let bestSize = Number.MAX_SAFE_INTEGER;
  for (const c of pool) {
    const size = c.endLine - c.startLine;
    if (size < bestSize) {
      best = c;
      bestSize = size;
    }
  }
  return best;
}

/**
 * Picks the innermost function-kind candidate, falling back to the innermost
 * candidate of any kind (arrow functions surface as Variable/Property in some
 * language servers). `containing` must hold only symbols whose range contains
 * the cursor.
 *
 * This is the target of explicit "current function" commands (fold/unfold
 * skeleton, remove markers in function, go to segment): with the cursor
 * anywhere on a nested function — its header line included — the command
 * targets the nested function itself, never the one around it.
 */
export function chooseInnermostFunction<T extends EnclosingCandidate>(
  containing: T[],
): T | undefined {
  return innermost(containing.filter((c) => c.fnKind)) ?? innermost(containing);
}

/**
 * Like `chooseInnermostFunction`, but reads a nested definition's header line
 * as part of the OUTER scope. This is the spotlight anchor: the header line
 * belongs to both scopes, and scoping it to the outer function keeps a local
 * definition and its call sites in one spotlight — so a candidate whose
 * header line is the cursor line yields to its enclosing candidates. With
 * nothing to yield to (a top-level header) the candidate keeps itself.
 */
export function chooseEnclosingFunction<T extends EnclosingCandidate>(
  containing: T[],
  cursorLine: number,
): T | undefined {
  const first = chooseInnermostFunction(containing);
  if (!first || first.startLine !== cursorLine) {
    return first;
  }
  return (
    chooseInnermostFunction(containing.filter((c) => c.startLine !== cursorLine)) ?? first
  );
}

function widest<T extends EnclosingCandidate>(pool: T[]): T | undefined {
  let best: T | undefined;
  let bestSize = -1;
  for (const c of pool) {
    const size = c.endLine - c.startLine;
    if (size > bestSize) {
      best = c;
      bestSize = size;
    }
  }
  return best;
}

/**
 * Picks the widest function-kind candidate, falling back to the widest
 * candidate of any kind. This is the search scope for spotlight islands —
 * related segments of the symbol under the cursor that live outside the
 * innermost function (a sibling local function's definition, a closure
 * variable's declaration). Deliberately never widens past a function: a class
 * or namespace wrapper is not a reading scope.
 */
export function chooseOutermostFunction<T extends EnclosingCandidate>(
  containing: T[],
): T | undefined {
  return widest(containing.filter((c) => c.fnKind)) ?? widest(containing);
}
