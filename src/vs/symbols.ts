import * as vscode from 'vscode';
import {
  EnclosingCandidate,
  chooseEnclosingFunction,
  chooseInnermostFunction,
  chooseOutermostFunction,
} from '../core/enclosing';

const FUNCTION_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

export interface FunctionInfo {
  name: string;
  range: vscode.Range;
}

interface Candidate extends EnclosingCandidate {
  name: string;
  range: vscode.Range;
}

export interface EnclosingFunctions {
  /** the spotlight anchor — the innermost function-like symbol */
  fn?: FunctionInfo;
  /** the widest function-like symbol containing the cursor (`fn` itself when nothing wraps it) */
  outermost?: FunctionInfo;
}

/** Multi-line symbols whose line span contains `pos` (line-based, so the
 *  header's indentation and the closing brace's tail count as inside). */
async function collectContaining(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<Candidate[]> {
  let roots: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    roots = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', doc.uri);
  } catch (_e) {
    return [];
  }

  const containing: Candidate[] = [];
  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation): void => {
    const range = 'location' in s ? s.location.range : s.range;
    if (pos.line < range.start.line || pos.line > range.end.line) {
      return;
    }
    if (range.end.line - range.start.line >= 1) {
      containing.push({
        startLine: range.start.line,
        endLine: range.end.line,
        fnKind: FUNCTION_KINDS.has(s.kind),
        name: s.name,
        range,
      });
    }
    if ('children' in s) {
      s.children.forEach(visit);
    }
  };
  (roots ?? []).forEach(visit);
  return containing;
}

const info = (c: Candidate | undefined): FunctionInfo | undefined =>
  c ? { name: c.name, range: c.range } : undefined;

/**
 * Finds the spotlight anchor function containing `pos`, plus the outermost
 * one (the island search scope, see core/enclosing.ts). Falls back to
 * containing multi-line symbols of any kind (covers arrow functions reported
 * as Variable/Property by some language servers). A nested function whose
 * header line is the cursor line yields to its enclosing function, so that a
 * local definition and its call sites spotlight each other.
 */
export async function findEnclosingFunctions(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<EnclosingFunctions> {
  const containing = await collectContaining(doc, pos);
  return {
    fn: info(chooseEnclosingFunction(containing, pos.line)),
    outermost: info(chooseOutermostFunction(containing)),
  };
}

/**
 * The target of explicit "current function" commands: the innermost
 * function-like symbol containing `pos`. Unlike the spotlight anchor of
 * `findEnclosingFunctions`, a nested function's header line counts as the
 * nested function itself — folding on `function inner(…)` must fold `inner`,
 * not the function around it.
 */
export async function findFunctionAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<FunctionInfo | undefined> {
  return info(chooseInnermostFunction(await collectContaining(doc, pos)));
}
