import * as vscode from 'vscode';
import {
  EditChange,
  MARKER_COLORS,
  Mark,
  MarkerColor,
  applyChangesToFile,
  colorAccent,
  emptyFileMarks,
  insertMark,
  marksAtLine,
  removeMarksInRange,
} from '../core/marks';
import { Compositor } from './compositor';
import { MarkRepository, newId } from './markRepository';
import { markerPaint, swatchIcon } from './palette';
import { findFunctionAtCursor } from './symbols';

function capitalize(color: MarkerColor): string {
  return color[0].toUpperCase() + color.slice(1);
}

export async function pickMarkerColor(): Promise<MarkerColor | undefined> {
  const picked = await vscode.window.showQuickPick(
    MARKER_COLORS.map((c) => ({
      label: capitalize(c),
      iconPath: swatchIcon(markerPaint(c)),
      color: c,
    })),
    { title: 'Marker Color' },
  );
  return picked?.color;
}

/** Esc on the note prompt resolves to no note — the note is optional. */
export async function promptMarkerNote(): Promise<string | undefined> {
  const note = await vscode.window.showInputBox({ prompt: 'Marker note' });
  return note || undefined;
}

/** Trimmed, truncated first-line snapshot shown in list views. */
export function linePreview(doc: vscode.TextDocument, line: number): string | undefined {
  const text = doc.lineAt(Math.min(line, doc.lineCount - 1)).text.trim();
  return text.length > 50 ? text.slice(0, 49) + '…' : text || undefined;
}

function selectionLineRange(editor: vscode.TextEditor): { start: number; end: number } {
  const sel = editor.selection;
  let end = sel.end.line;
  // a selection ending at column 0 of a later line doesn't visually include that line
  if (!sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line) {
    end--;
  }
  return { start: sel.start.line, end };
}

/** Creates a mark over a line range of `doc` (shared by selection and segment marking). */
export function addLineMarker(
  repo: MarkRepository,
  compositor: Compositor,
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number,
  color: MarkerColor,
  note: string | undefined,
): void {
  const start = Math.min(startLine, doc.lineCount - 1);
  const end = Math.min(endLine, doc.lineCount - 1);
  const mark: Mark = {
    id: newId(),
    accent: colorAccent(color),
    note,
    preview: linePreview(doc, start),
    startLine: start,
    endLine: end,
  };
  repo.set(doc.uri, insertMark(repo.get(doc.uri), mark));
  compositor.renderVisibleFor(doc.uri);
}

function addMarker(
  editor: vscode.TextEditor,
  repo: MarkRepository,
  compositor: Compositor,
  color: MarkerColor,
  note: string | undefined,
): void {
  const { start, end } = selectionLineRange(editor);
  addLineMarker(repo, compositor, editor.document, start, end, color, note);
}

export function registerHighlighterCommands(
  context: vscode.ExtensionContext,
  repo: MarkRepository,
  compositor: Compositor,
): void {
  const withEditor = (fn: (editor: vscode.TextEditor) => void | Promise<void>) => (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      void fn(editor);
    }
  };

  // one direct command per palette color, for user-bound shortcuts
  for (const color of MARKER_COLORS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `sightread.mark${capitalize(color)}`,
        withEditor((editor) => addMarker(editor, repo, compositor, color, undefined)),
      ),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sightread.mark',
      withEditor(async (editor) => {
        const color = await pickMarkerColor();
        if (!color) {
          return;
        }
        addMarker(editor, repo, compositor, color, await promptMarkerNote());
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.markPickColor',
      withEditor(async (editor) => {
        const color = await pickMarkerColor();
        if (color) {
          addMarker(editor, repo, compositor, color, undefined);
        }
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.editMarkerNote',
      withEditor(async (editor) => {
        const uri = editor.document.uri;
        const state = repo.get(uri);
        const hit = marksAtLine(state.marks, editor.selection.active.line)[0];
        if (!hit) {
          void vscode.window.showInformationMessage('SightRead: no mark at cursor.');
          return;
        }
        const note = await vscode.window.showInputBox({
          prompt: 'Marker note',
          value: hit.note ?? '',
        });
        if (note === undefined) {
          return; // cancelled
        }
        repo.set(uri, {
          ...state,
          marks: state.marks.map((m) =>
            m.id === hit.id ? { ...m, note: note || undefined } : m,
          ),
        });
        compositor.renderVisibleFor(uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInSelection',
      withEditor((editor) => {
        const { start, end } = selectionLineRange(editor);
        repo.set(editor.document.uri, removeMarksInRange(repo.get(editor.document.uri), start, end));
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInFunction',
      withEditor(async (editor) => {
        const fn = await findFunctionAtCursor(editor.document, editor.selection.active);
        if (!fn) {
          void vscode.window.showInformationMessage('SightRead: cursor is not inside a function.');
          return;
        }
        repo.set(
          editor.document.uri,
          removeMarksInRange(
            repo.get(editor.document.uri),
            fn.range.start.line,
            fn.range.end.line,
          ),
        );
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInFile',
      withEditor((editor) => {
        repo.set(editor.document.uri, emptyFileMarks());
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand('sightread.removeAllMarkers', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'Clear all SightRead marks and AI guides in this workspace?',
        { modal: true },
        'Clear All',
      );
      if (confirmed === 'Clear All') {
        repo.clearAll();
        compositor.renderVisible();
      }
    }),
  );
}

/**
 * Keeps marks in sync with edits: shift on edits elsewhere, delete on any
 * edit that touches marked lines (design.md §3.2, per mark — guide shells
 * die with their last mark).
 */
export function handleDocumentChange(
  e: vscode.TextDocumentChangeEvent,
  repo: MarkRepository,
  compositor: Compositor,
): void {
  if (e.contentChanges.length === 0) {
    return;
  }
  const before = repo.get(e.document.uri);
  if (before.marks.length === 0) {
    return;
  }
  const changes: EditChange[] = e.contentChanges.map((ch) => ({
    startLine: ch.range.start.line,
    startChar: ch.range.start.character,
    endLine: ch.range.end.line,
    endChar: ch.range.end.character,
    insertedNewlines: (ch.text.match(/\n/g) ?? []).length,
  }));
  const result = applyChangesToFile(before, changes);
  if (result.changed) {
    repo.set(e.document.uri, result.state);
    compositor.renderVisibleFor(e.document.uri);
  }
}
