/**
 * Highlighter (marker) data operations. Pure logic, no vscode dependency.
 *
 * Markers are line-granular and deliberately short-lived (design.md §3.2):
 * any edit that touches a marker's lines deletes it; edits elsewhere only
 * shift line numbers. New markers swallow existing intersecting ones.
 */

export type MarkerColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple';

export const MARKER_COLORS: MarkerColor[] = ['yellow', 'red', 'green', 'blue', 'purple'];

/** Anything occupying a whole-line range — markers, guides. */
export interface LineSpan {
  /** inclusive */
  startLine: number;
  /** inclusive */
  endLine: number;
}

export interface Marker extends LineSpan {
  id: string;
  color: MarkerColor;
  note?: string;
  /** snapshot of the first marked line's text, for list views */
  preview?: string;
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

/** Inserts a marker, swallowing any existing marker it intersects. */
export function insertMarker(
  markers: Marker[],
  marker: Marker,
): { markers: Marker[]; replaced: Marker[] } {
  const replaced = markers.filter((m) => intersectsLines(m, marker.startLine, marker.endLine));
  const kept = markers.filter((m) => !intersectsLines(m, marker.startLine, marker.endLine));
  kept.push(marker);
  kept.sort((a, b) => a.startLine - b.startLine);
  return { markers: kept, replaced };
}

export function removeInLineRange(
  markers: Marker[],
  startLine: number,
  endLine: number,
): { markers: Marker[]; removed: Marker[] } {
  const removed = markers.filter((m) => intersectsLines(m, startLine, endLine));
  return { markers: markers.filter((m) => !intersectsLines(m, startLine, endLine)), removed };
}

export function markersAtLine(markers: Marker[], line: number): Marker[] {
  return markers.filter((m) => intersectsLines(m, line, line));
}

export function markersInLineRange(
  markers: Marker[],
  startLine: number,
  endLine: number,
): Marker[] {
  return markers.filter((m) => intersectsLines(m, startLine, endLine));
}
