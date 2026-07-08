import * as vscode from 'vscode';
import { TintOccurrence } from './compositor';
import { FunctionInfo } from './symbols';

const MAX_OCCURRENCES = 500;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Computes the transient tint occurrences for the symbol under the cursor,
 * clipped to `scope` — the OUTERMOST enclosing function (design.md §3.3), so
 * that a symbol inside a nested function still reaches its definition or
 * closure uses in the outer function. Prefers the language's
 * document-highlight provider (which distinguishes read/write); falls back to
 * word-boundary text matching when no provider responds.
 */
export async function computeTint(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  scope: FunctionInfo | undefined,
): Promise<TintOccurrence[]> {
  const wordRange = doc.getWordRangeAtPosition(pos);
  if (!wordRange) {
    return [];
  }

  let occurrences: TintOccurrence[] = [];
  try {
    const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
      'vscode.executeDocumentHighlights',
      doc.uri,
      pos,
    );
    if (highlights && highlights.length > 0) {
      occurrences = highlights.map((h) => ({
        range: h.range,
        write: h.kind === vscode.DocumentHighlightKind.Write,
      }));
    }
  } catch (_e) {
    // no provider for this language — fall through to text matching
  }

  if (occurrences.length === 0 && scope) {
    const word = doc.getText(wordRange);
    if (IDENTIFIER_RE.test(word)) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
      const lastLine = Math.min(scope.range.end.line, doc.lineCount - 1);
      outer: for (let line = scope.range.start.line; line <= lastLine; line++) {
        for (const match of doc.lineAt(line).text.matchAll(re)) {
          occurrences.push({
            range: new vscode.Range(line, match.index!, line, match.index! + word.length),
            write: false,
          });
          if (occurrences.length >= MAX_OCCURRENCES) {
            break outer;
          }
        }
      }
    }
  }

  if (scope) {
    occurrences = occurrences.filter((o) => scope.range.contains(o.range.start));
  }
  return occurrences.slice(0, MAX_OCCURRENCES);
}
