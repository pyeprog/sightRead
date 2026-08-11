/**
 * Unified mark data operations. Pure logic, no vscode dependency.
 *
 * A mark is one painted line range. Manual highlighter marks carry a color
 * accent; AI guide steps carry a role accent and belong to a guide shell —
 * beyond that the two are the same thing: they render alike, filter alike,
 * and follow the same edit-sync rules (design.md §3.2): any edit touching a
 * mark's lines deletes that mark, edits elsewhere only shift line numbers.
 * A guide shell holds no lines of its own; its extent derives from its
 * surviving marks, and it dies with the last of them.
 */

export type MarkerColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple';

export const MARKER_COLORS: MarkerColor[] = ['yellow', 'red', 'green', 'blue', 'purple'];

export type InterpretUnit = 'function' | 'class' | 'file';

/** What paints a mark: a manual palette color, or an AI role tag. */
export type Accent =
  | { kind: 'color'; color: MarkerColor }
  | { kind: 'role'; role?: string };

export function colorAccent(color: MarkerColor): Accent {
  return { kind: 'color', color };
}

export function roleAccent(role: string | undefined): Accent {
  return { kind: 'role', role };
}

/**
 * Normalized filter key of an accent: 'color:yellow' | 'role:main' | 'role:'
 * (untagged step). The role vocabulary is open (custom templates may define
 * new tags), so visibility filtering is data-driven over these keys, never
 * over a fixed list.
 */
export function accentKey(a: Accent): string {
  return a.kind === 'color' ? `color:${a.color}` : `role:${a.role?.trim().toLowerCase() ?? ''}`;
}

export function markVisible(a: Accent, hidden: ReadonlySet<string>): boolean {
  return !hidden.has(accentKey(a));
}

/** Inverse of accentKey — used by the filter UI to render swatches for keys
 *  that are hidden but no longer present in the file. */
export function accentFromKey(key: string): Accent {
  return key.startsWith('color:')
    ? { kind: 'color', color: key.slice('color:'.length) as MarkerColor }
    : { kind: 'role', role: key.slice('role:'.length) || undefined };
}

/** Anything occupying a whole-line range. */
export interface LineSpan {
  /** inclusive */
  startLine: number;
  /** inclusive */
  endLine: number;
}

export interface Mark extends LineSpan {
  id: string;
  accent: Accent;
  /** manual note, or the AI step's signpost */
  note?: string;
  /** snapshot of the first marked line's text, for list views */
  preview?: string;
  /** owned by a guide = an AI step */
  guideId?: string;
  /** 0-based reading-order position within the guide */
  order?: number;
}

/** Pure metadata shell — no line span; its extent derives from its marks. */
export interface Guide {
  id: string;
  /** the interpreted subject's name: function name, class name, or file basename */
  subject: string;
  unit: InterpretUnit;
  /** one-sentence overview, rendered at the guide's first surviving mark */
  summary?: string;
}

export interface FileMarks {
  marks: Mark[];
  guides: Guide[];
}

export function emptyFileMarks(): FileMarks {
  return { marks: [], guides: [] };
}

export function isEmptyFileMarks(state: FileMarks): boolean {
  return state.marks.length === 0 && state.guides.length === 0;
}

/** A single content change, in pre-change document coordinates. */
export interface EditChange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  /** number of newline characters in the inserted text */
  insertedNewlines: number;
}

export interface ApplyResult<T extends LineSpan> {
  items: T[];
  removed: T[];
  changed: boolean;
}

function cmpPos(aLine: number, aChar: number, bLine: number, bChar: number): number {
  return aLine !== bLine ? aLine - bLine : aChar - bChar;
}

export function applyChange<T extends LineSpan>(items: T[], c: EditChange): ApplyResult<T> {
  const kept: T[] = [];
  const removed: T[] = [];
  let changed = false;
  const delta = c.insertedNewlines - (c.endLine - c.startLine);
  for (const m of items) {
    // the item occupies [(startLine, 0), (endLine + 1, 0)) — whole lines
    const changeBeforeItem = cmpPos(c.endLine, c.endChar, m.startLine, 0) <= 0;
    const changeAfterItem = cmpPos(c.startLine, c.startChar, m.endLine + 1, 0) >= 0;
    if (changeBeforeItem) {
      if (delta === 0) {
        kept.push(m);
      } else {
        kept.push({ ...m, startLine: m.startLine + delta, endLine: m.endLine + delta });
        changed = true;
      }
    } else if (changeAfterItem) {
      kept.push(m);
    } else {
      removed.push(m);
      changed = true;
    }
  }
  return { items: kept, removed, changed };
}

/** Applies multiple changes of one edit event, bottom-up. */
export function applyChanges<T extends LineSpan>(
  items: T[],
  changes: EditChange[],
): ApplyResult<T> {
  const sorted = [...changes].sort(
    (a, b) => cmpPos(b.startLine, b.startChar, a.startLine, a.startChar),
  );
  let current = items;
  const removed: T[] = [];
  let changed = false;
  for (const c of sorted) {
    const r = applyChange(current, c);
    current = r.items;
    removed.push(...r.removed);
    changed = changed || r.changed;
  }
  return { items: current, removed, changed };
}

function intersectsLines(m: LineSpan, startLine: number, endLine: number): boolean {
  return m.startLine <= endLine && m.endLine >= startLine;
}

function byLine(a: Mark, b: Mark): number {
  return a.startLine - b.startLine;
}

/** Drops guide shells whose marks are all gone. */
function pruneShells(marks: Mark[], guides: Guide[]): Guide[] {
  return guides.filter((g) => marks.some((m) => m.guideId === g.id));
}

export function looseMarks(state: FileMarks): Mark[] {
  return state.marks.filter((m) => !m.guideId);
}

/** The guide's marks in reading order. */
export function guideMarks(state: FileMarks, guideId: string): Mark[] {
  return state.marks
    .filter((m) => m.guideId === guideId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Line extent of a guide's surviving marks; undefined once they are gone. */
export function guideEnvelope(state: FileMarks, guideId: string): LineSpan | undefined {
  const marks = state.marks.filter((m) => m.guideId === guideId);
  if (marks.length === 0) {
    return undefined;
  }
  return {
    startLine: Math.min(...marks.map((m) => m.startLine)),
    endLine: Math.max(...marks.map((m) => m.endLine)),
  };
}

/**
 * Inserts a manual mark, swallowing intersecting loose marks (same-range
 * backgrounds compose into mud). Guide-owned marks are never swallowed: they
 * belong to the guide, and a manual mark over a step means "my judgment on
 * top of the AI's" — both render, color wins where they overlap.
 */
export function insertMark(state: FileMarks, mark: Mark): FileMarks {
  const marks = state.marks.filter(
    (m) => m.guideId !== undefined || !intersectsLines(m, mark.startLine, mark.endLine),
  );
  marks.push(mark);
  marks.sort(byLine);
  return { marks, guides: state.guides };
}

/** Removes one mark by id, pruning its shell if it was the guide's last. */
export function removeMark(state: FileMarks, id: string): FileMarks {
  const marks = state.marks.filter((m) => m.id !== id);
  return { marks, guides: pruneShells(marks, state.guides) };
}

/** Removes every mark intersecting the range — steps included — and prunes
 *  emptied guide shells. */
export function removeMarksInRange(
  state: FileMarks,
  startLine: number,
  endLine: number,
): FileMarks {
  const marks = state.marks.filter((m) => !intersectsLines(m, startLine, endLine));
  return { marks, guides: pruneShells(marks, state.guides) };
}

/**
 * Adds a guide and its step marks, replacing any guide whose envelope
 * intersects the new one (a function interpretation supersedes the file
 * overview covering it). Loose marks survive.
 */
export function addGuide(state: FileMarks, guide: Guide, steps: Mark[]): FileMarks {
  const owned = steps.map((s, i) => ({ ...s, guideId: guide.id, order: s.order ?? i }));
  const envelope = {
    startLine: Math.min(...owned.map((m) => m.startLine)),
    endLine: Math.max(...owned.map((m) => m.endLine)),
  };
  const superseded = new Set(
    state.guides
      .filter((g) => {
        const e = guideEnvelope(state, g.id);
        return e !== undefined && intersectsLines(e, envelope.startLine, envelope.endLine);
      })
      .map((g) => g.id),
  );
  const marks = state.marks.filter((m) => !m.guideId || !superseded.has(m.guideId));
  marks.push(...owned);
  marks.sort(byLine);
  const guides = state.guides.filter((g) => !superseded.has(g.id));
  guides.push(guide);
  return { marks, guides };
}

export function removeGuide(state: FileMarks, guideId: string): FileMarks {
  return {
    marks: state.marks.filter((m) => m.guideId !== guideId),
    guides: state.guides.filter((g) => g.id !== guideId),
  };
}

/**
 * Keeps a file's marks in sync with edits: per mark, shift on edits
 * elsewhere, delete on any edit that touches its lines; guide shells die
 * with their last mark.
 */
export function applyChangesToFile(
  state: FileMarks,
  changes: EditChange[],
): { state: FileMarks; changed: boolean } {
  const r = applyChanges(state.marks, changes);
  if (!r.changed) {
    return { state, changed: false };
  }
  return {
    state: { marks: r.items, guides: pruneShells(r.items, state.guides) },
    changed: true,
  };
}

export function marksAtLine(marks: Mark[], line: number): Mark[] {
  return marks.filter((m) => intersectsLines(m, line, line));
}

export function marksInLineRange(marks: Mark[], startLine: number, endLine: number): Mark[] {
  return marks.filter((m) => intersectsLines(m, startLine, endLine));
}
