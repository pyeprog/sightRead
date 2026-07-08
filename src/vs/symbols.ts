import * as vscode from 'vscode';
import {
  EnclosingCandidate,
  chooseEnclosingFunction,
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

/**
 * Finds the innermost function-like symbol containing `pos`, plus the
 * outermost one (the island search scope, see core/enclosing.ts). Falls back
 * to containing multi-line symbols of any kind (covers arrow functions
 * reported as Variable/Property by some language servers). A nested function
 * whose header line is the cursor line yields to its enclosing function, so
 * that a local definition and its call sites spotlight each other.
 */
export async function findEnclosingFunctions(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<EnclosingFunctions> {
  let roots: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    roots = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', doc.uri);
  } catch (_e) {
    return {};
  }
  if (!roots || roots.length === 0) {
    return {};
  }

  const containing: Candidate[] = [];
  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation): void => {
    const range = 'location' in s ? s.location.range : s.range;
    if (!range.contains(pos)) {
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
  roots.forEach(visit);

  const info = (c: Candidate | undefined): FunctionInfo | undefined =>
    c ? { name: c.name, range: c.range } : undefined;
  return {
    fn: info(chooseEnclosingFunction(containing, pos.line)),
    outermost: info(chooseOutermostFunction(containing)),
  };
}

export async function findEnclosingFunction(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<FunctionInfo | undefined> {
  return (await findEnclosingFunctions(doc, pos)).fn;
}
