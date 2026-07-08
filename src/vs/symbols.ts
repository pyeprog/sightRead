import * as vscode from 'vscode';

const FUNCTION_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

export interface FunctionInfo {
  name: string;
  range: vscode.Range;
}

/**
 * Finds the innermost function-like symbol containing `pos`. Falls back to the
 * smallest containing multi-line symbol of any kind (covers arrow functions
 * reported as Variable/Property by some language servers).
 */
export async function findEnclosingFunction(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<FunctionInfo | undefined> {
  let roots: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    roots = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', doc.uri);
  } catch (_e) {
    return undefined;
  }
  if (!roots || roots.length === 0) {
    return undefined;
  }

  let bestFn: FunctionInfo | undefined;
  let bestFnSize = Number.MAX_SAFE_INTEGER;
  let bestAny: FunctionInfo | undefined;
  let bestAnySize = Number.MAX_SAFE_INTEGER;

  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation): void => {
    const range = 'location' in s ? s.location.range : s.range;
    if (!range.contains(pos)) {
      return;
    }
    const size = range.end.line - range.start.line;
    if (size >= 1) {
      if (FUNCTION_KINDS.has(s.kind) && size < bestFnSize) {
        bestFn = { name: s.name, range };
        bestFnSize = size;
      }
      if (size < bestAnySize) {
        bestAny = { name: s.name, range };
        bestAnySize = size;
      }
    }
    if ('children' in s) {
      s.children.forEach(visit);
    }
  };
  roots.forEach(visit);
  return bestFn ?? bestAny;
}
