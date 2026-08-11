import * as vscode from 'vscode';
import {
  Accent,
  FileMarks,
  Guide,
  InterpretUnit,
  MARKER_COLORS,
  Mark,
  MarkerColor,
  isEmptyFileMarks,
} from '../core/marks';

let idCounter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${idCounter++}`;
}

const STORAGE_KEY = 'sightread.marks';
const LEGACY_MARKERS_KEY = 'sightread.markers';
const LEGACY_GUIDES_KEY = 'sightread.guides';

interface LegacyMarker {
  id: string;
  color: MarkerColor;
  note?: string;
  preview?: string;
  startLine: number;
  endLine: number;
}

interface LegacyGuide {
  id: string;
  subject: string;
  unit: InterpretUnit;
  summary?: string;
  startLine: number;
  endLine: number;
  steps: { id: string; note: string; role?: string; preview?: string; startLine: number; endLine: number }[];
}

function isSpan(v: { startLine?: unknown; endLine?: unknown }): boolean {
  return typeof v.startLine === 'number' && typeof v.endLine === 'number';
}

function isStoredMark(m: Mark): boolean {
  const a = m.accent as Accent | undefined;
  const accentOk =
    !!a &&
    ((a.kind === 'color' && (MARKER_COLORS as string[]).includes(a.color)) || a.kind === 'role');
  return typeof m.id === 'string' && accentOk && isSpan(m);
}

function isStoredGuide(g: Guide): boolean {
  return (
    typeof g.id === 'string' &&
    typeof g.subject === 'string' &&
    (g.unit === 'function' || g.unit === 'class' || g.unit === 'file')
  );
}

/**
 * One-time conversion of the pre-merge stores ('sightread.markers' +
 * 'sightread.guides') into the unified key: manual markers become
 * color-accent marks, guide steps become role-accent marks owned by a shell.
 * Legacy keys are deleted afterwards, so this runs once per workspace.
 */
export function migrateLegacyStorage(memento: vscode.Memento): void {
  const legacyMarkers = memento.get<Record<string, LegacyMarker[]>>(LEGACY_MARKERS_KEY);
  const legacyGuides = memento.get<Record<string, LegacyGuide[]>>(LEGACY_GUIDES_KEY);
  if (!legacyMarkers && !legacyGuides) {
    return;
  }
  const merged: Record<string, FileMarks> = {
    ...memento.get<Record<string, FileMarks>>(STORAGE_KEY, {}),
  };
  const stateOf = (uri: string): FileMarks => {
    merged[uri] = merged[uri] ?? { marks: [], guides: [] };
    return merged[uri];
  };
  for (const [uri, markers] of Object.entries(legacyMarkers ?? {})) {
    const state = stateOf(uri);
    for (const m of markers) {
      if (!isSpan(m) || typeof m.id !== 'string') {
        continue;
      }
      state.marks.push({
        id: m.id,
        accent: { kind: 'color', color: m.color },
        note: m.note,
        preview: m.preview,
        startLine: m.startLine,
        endLine: m.endLine,
      });
    }
  }
  for (const [uri, guides] of Object.entries(legacyGuides ?? {})) {
    const state = stateOf(uri);
    for (const g of guides) {
      if (typeof g.id !== 'string' || !Array.isArray(g.steps) || g.steps.length === 0) {
        continue;
      }
      state.guides.push({ id: g.id, subject: g.subject, unit: g.unit, summary: g.summary });
      g.steps.forEach((s, order) => {
        if (isSpan(s)) {
          state.marks.push({
            id: s.id,
            accent: { kind: 'role', role: s.role },
            note: s.note,
            preview: s.preview,
            guideId: g.id,
            order,
            startLine: s.startLine,
            endLine: s.endLine,
          });
        }
      });
    }
  }
  for (const state of Object.values(merged)) {
    state.marks.sort((a, b) => a.startLine - b.startLine);
  }
  void memento.update(STORAGE_KEY, merged);
  void memento.update(LEGACY_MARKERS_KEY, undefined);
  void memento.update(LEGACY_GUIDES_KEY, undefined);
}

/**
 * Per-file mark store persisted in workspaceState — deliberately not in the
 * repo (design.md §一.2). The single home of both manual marks and AI
 * guides since the model merge.
 */
export class MarkRepository {
  private byUri: Record<string, FileMarks>;
  private emitter = new vscode.EventEmitter<void>();
  /** fires after any mutation — list views subscribe to this */
  readonly onDidChange = this.emitter.event;

  constructor(private memento: vscode.Memento) {
    migrateLegacyStorage(memento);
    this.byUri = { ...memento.get<Record<string, FileMarks>>(STORAGE_KEY, {}) };
    // drop persisted entries of an outdated shape instead of migrating them
    for (const [uri, state] of Object.entries(this.byUri)) {
      const marks = (state.marks ?? []).filter(isStoredMark);
      const guides = (state.guides ?? [])
        .filter(isStoredGuide)
        .filter((g) => marks.some((m) => m.guideId === g.id));
      if (marks.length === 0) {
        delete this.byUri[uri];
      } else {
        this.byUri[uri] = { marks, guides };
      }
    }
  }

  get(uri: vscode.Uri): FileMarks {
    return this.byUri[uri.toString()] ?? { marks: [], guides: [] };
  }

  uris(): string[] {
    return Object.keys(this.byUri);
  }

  set(uri: vscode.Uri, state: FileMarks): void {
    if (!isEmptyFileMarks(state)) {
      this.byUri[uri.toString()] = state;
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
