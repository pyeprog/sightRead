import * as vscode from 'vscode';
import { extractBody } from '../core/segmentation';
import { DocSegmentNode, SegmentCache } from './segmentCache';
import { FunctionInfo, findFunctionAtCursor } from './symbols';

/**
 * Skeleton fold (design.md §3.1).
 *
 * Folding is driven by explicit line lists and always passes `levels: 1`:
 * without `levels`/`direction`, `editor.fold` takes the interactive
 * "fold parent when already collapsed" path (`setCollapseStateUp`), which is
 * how earlier versions ended up folding the enclosing method or even the
 * whole class.
 *
 * The fold lines come from the language's folding-range provider when
 * available (exact match with the editor's folding model), restricted to
 * regions fully inside the function BODY — the signature, decorators and the
 * function's own region are filtered out. The segment tree's heuristic
 * `headerLines` are only a fallback.
 */
export interface SkeletonFoldHooks {
  /** called after the code was folded — used to collapse the segments tree */
  afterFold?: () => void;
  /** called after the code was unfolded — used to re-expand the segments tree */
  afterUnfold?: () => void;
}

function collectHeaderLines(nodes: DocSegmentNode[]): number[] {
  const lines: number[] = [];
  const walk = (ns: DocSegmentNode[]): void => {
    for (const n of ns) {
      lines.push(...(n.headerLines ?? []));
      walk(n.children);
    }
  };
  walk(nodes);
  return lines;
}

/** First line of the function body (after signature/decorators), absolute. */
function bodyStartLine(doc: vscode.TextDocument, fn: FunctionInfo): number {
  const lastLine = Math.min(fn.range.end.line, doc.lineCount - 1);
  const lines: string[] = [];
  for (let i = fn.range.start.line; i <= lastLine; i++) {
    lines.push(doc.lineAt(i).text);
  }
  const body = extractBody(lines);
  return Math.min(fn.range.start.line + body.offset, lastLine);
}

async function foldableLines(
  doc: vscode.TextDocument,
  fn: FunctionInfo,
  cache: SegmentCache,
): Promise<number[]> {
  const bodyStart = bodyStartLine(doc, fn);
  try {
    const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      doc.uri,
    );
    if (ranges && ranges.length > 0) {
      return ranges
        .filter((r) => r.start >= bodyStart && r.end <= fn.range.end.line)
        .map((r) => r.start);
    }
  } catch (_e) {
    // command or provider unavailable — fall back to the segment-tree heuristic
  }
  return collectHeaderLines(cache.get(doc, fn.range));
}

async function withEnclosingFunction(
  action: (editor: vscode.TextEditor, fn: FunctionInfo) => Promise<void>,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const fn = await findFunctionAtCursor(editor.document, editor.selection.active);
  if (!fn) {
    void vscode.window.showInformationMessage('SightRead: cursor is not inside a function.');
    return;
  }
  await action(editor, fn);
}

export function registerSkeletonFoldCommands(
  context: vscode.ExtensionContext,
  cache: SegmentCache,
  hooks: SkeletonFoldHooks = {},
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.foldSkeleton', () =>
      withEnclosingFunction(async (editor, fn) => {
        const lines = await foldableLines(editor.document, fn, cache);
        if (lines.length === 0) {
          void vscode.window.showInformationMessage('SightRead: nothing to fold here.');
          return;
        }
        await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: lines });
        hooks.afterFold?.();
      }),
    ),
    vscode.commands.registerCommand('sightread.unfoldSkeleton', () =>
      withEnclosingFunction(async (editor, fn) => {
        // First reveal the function itself: if the enclosing method/class got
        // folded (by hand or by older buggy folds), unfolding only the inner
        // regions would change nothing on screen.
        await vscode.commands.executeCommand('editor.unfold', {
          direction: 'up',
          levels: 32,
          selectionLines: [bodyStartLine(editor.document, fn)],
        });
        const lines = await foldableLines(editor.document, fn, cache);
        if (lines.length > 0) {
          await vscode.commands.executeCommand('editor.unfold', {
            levels: 1,
            selectionLines: lines,
          });
        }
        hooks.afterUnfold?.();
      }),
    ),
  );
}
