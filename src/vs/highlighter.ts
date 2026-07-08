import * as vscode from 'vscode';
import {
  EditChange,
  MARKER_COLORS,
  Marker,
  MarkerColor,
  applyChanges,
  insertMarker,
  markersAtLine,
  removeInLineRange,
} from '../core/markers';
import { Compositor } from './compositor';
import { findEnclosingFunction } from './symbols';

const STORAGE_KEY = 'sightread.markers';

const COLOR_LABELS: Record<MarkerColor, string> = {
  yellow: '🟡 Yellow — key point',
  red: '🔴 Red — doubt / question',
  green: '🟢 Green — verified',
  blue: '🔵 Blue',
  purple: '🟣 Purple',
};

let idCounter = 0;
function newId(): string {
  return `${Date.now().toString(36)}-${idCounter++}`;
}

/** Markers persisted in workspaceState — deliberately not in the repo (design.md §一.2). */
export class MarkerRepository {
  private byUri: Record<string, Marker[]>;
  private emitter = new vscode.EventEmitter<void>();
  /** fires after any mutation — list views subscribe to this */
  readonly onDidChange = this.emitter.event;

  constructor(private memento: vscode.Memento) {
    this.byUri = { ...memento.get<Record<string, Marker[]>>(STORAGE_KEY, {}) };
  }

  get(uri: vscode.Uri): Marker[] {
    return this.byUri[uri.toString()] ?? [];
  }

  uris(): string[] {
    return Object.keys(this.byUri);
  }

  set(uri: vscode.Uri, markers: Marker[]): void {
    if (markers.length > 0) {
      this.byUri[uri.toString()] = markers;
    } else {
      delete this.byUri[uri.toString()];
    }
    void this.memento.update(STORAGE_KEY, this.byUri);
    this.emitter.fire();
  }

  clearAll(): void {
    this.byUri = {};
    void this.memento.update(STORAGE_KEY, this.byUri);
    this.emitter.fire();
  }
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

async function addMarker(
  editor: vscode.TextEditor,
  repo: MarkerRepository,
  compositor: Compositor,
  color: MarkerColor,
  note: string | undefined,
): Promise<void> {
  const { start, end } = selectionLineRange(editor);
  const firstLine = editor.document.lineAt(start).text.trim();
  const preview =
    firstLine.length > 50 ? firstLine.slice(0, 49) + '…' : firstLine || undefined;
  const marker: Marker = { id: newId(), color, note, preview, startLine: start, endLine: end };
  const { markers } = insertMarker(repo.get(editor.document.uri), marker);
  repo.set(editor.document.uri, markers);
  compositor.renderVisibleFor(editor.document.uri);
}

export function registerHighlighterCommands(
  context: vscode.ExtensionContext,
  repo: MarkerRepository,
  compositor: Compositor,
): void {
  const withEditor = (fn: (editor: vscode.TextEditor) => void | Promise<void>) => (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      void fn(editor);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sightread.mark',
      withEditor(async (editor) => {
        const picked = await vscode.window.showQuickPick(
          MARKER_COLORS.map((c) => ({ label: COLOR_LABELS[c], color: c })),
          { placeHolder: 'Marker color' },
        );
        if (!picked) {
          return;
        }
        // Esc on the note prompt still creates the marker — the note is optional.
        const note = await vscode.window.showInputBox({
          prompt: 'Note (optional, shown at the end of the first marked line)',
          placeHolder: 'leave empty for no note',
        });
        await addMarker(editor, repo, compositor, picked.color, note || undefined);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.markYellow',
      withEditor((editor) => addMarker(editor, repo, compositor, 'yellow', undefined)),
    ),
    vscode.commands.registerCommand(
      'sightread.markRed',
      withEditor((editor) => addMarker(editor, repo, compositor, 'red', undefined)),
    ),
    vscode.commands.registerCommand(
      'sightread.markGreen',
      withEditor((editor) => addMarker(editor, repo, compositor, 'green', undefined)),
    ),
    vscode.commands.registerCommand(
      'sightread.editMarkerNote',
      withEditor(async (editor) => {
        const uri = editor.document.uri;
        const markers = repo.get(uri);
        const hit = markersAtLine(markers, editor.selection.active.line)[0];
        if (!hit) {
          void vscode.window.showInformationMessage('SightRead: no marker at cursor.');
          return;
        }
        const note = await vscode.window.showInputBox({
          prompt: 'Marker note (empty to remove the note)',
          value: hit.note ?? '',
        });
        if (note === undefined) {
          return; // cancelled
        }
        repo.set(
          uri,
          markers.map((m) => (m.id === hit.id ? { ...m, note: note || undefined } : m)),
        );
        compositor.renderVisibleFor(uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInSelection',
      withEditor((editor) => {
        const { start, end } = selectionLineRange(editor);
        const { markers } = removeInLineRange(repo.get(editor.document.uri), start, end);
        repo.set(editor.document.uri, markers);
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInFunction',
      withEditor(async (editor) => {
        const fn = await findEnclosingFunction(editor.document, editor.selection.active);
        if (!fn) {
          void vscode.window.showInformationMessage('SightRead: cursor is not inside a function.');
          return;
        }
        const { markers } = removeInLineRange(
          repo.get(editor.document.uri),
          fn.range.start.line,
          fn.range.end.line,
        );
        repo.set(editor.document.uri, markers);
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand(
      'sightread.removeMarkersInFile',
      withEditor((editor) => {
        repo.set(editor.document.uri, []);
        compositor.renderVisibleFor(editor.document.uri);
      }),
    ),
    vscode.commands.registerCommand('sightread.removeAllMarkers', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'Remove all SightRead markers in this workspace?',
        { modal: true },
        'Remove All',
      );
      if (confirmed === 'Remove All') {
        repo.clearAll();
        compositor.renderVisible();
      }
    }),
  );
}

/**
 * Keeps markers in sync with edits: shift on edits elsewhere, delete on any
 * edit that touches marked lines (design.md §3.2).
 */
export function handleDocumentChange(
  e: vscode.TextDocumentChangeEvent,
  repo: MarkerRepository,
  compositor: Compositor,
): void {
  if (e.contentChanges.length === 0) {
    return;
  }
  const before = repo.get(e.document.uri);
  if (before.length === 0) {
    return;
  }
  const changes: EditChange[] = e.contentChanges.map((ch) => ({
    startLine: ch.range.start.line,
    startChar: ch.range.start.character,
    endLine: ch.range.end.line,
    endChar: ch.range.end.character,
    insertedNewlines: (ch.text.match(/\n/g) ?? []).length,
  }));
  const result = applyChanges(before, changes);
  if (result.changed) {
    repo.set(e.document.uri, result.markers);
    compositor.renderVisibleFor(e.document.uri);
  }
}
