/**
 * Highlighter (marker) data operations. Pure logic, no vscode dependency.
 *
 * Markers are line-granular and deliberately short-lived (design.md §3.2):
 * any edit that touches a marker's lines deletes it; edits elsewhere only
 * shift line numbers. New markers swallow existing intersecting ones.
 */

export type MarkerColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple';

export const MARKER_COLORS: MarkerColor[] = ['yellow', 'red', 'green', 'blue', 'purple'];

export interface Marker {
  id: string;
  color: MarkerColor;
  note?: string;
  /** snapshot of the first marked line's text, for list views */
  preview?: string;
  /** inclusive */
  startLine: number;
  /** inclusive */
  endLine: number;
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

export interface ApplyResult {
  markers: Marker[];
  removed: Marker[];
  changed: boolean;
}

function cmpPos(aLine: number, aChar: number, bLine: number, bChar: number): number {
  return aLine !== bLine ? aLine - bLine : aChar - bChar;
}

export function applyChange(markers: Marker[], c: EditChange): ApplyResult {
  const kept: Marker[] = [];
  const removed: Marker[] = [];
  let changed = false;
  const delta = c.insertedNewlines - (c.endLine - c.startLine);
  for (const m of markers) {
    // marker occupies [(startLine, 0), (endLine + 1, 0)) — whole lines
    const changeBeforeMarker = cmpPos(c.endLine, c.endChar, m.startLine, 0) <= 0;
    const changeAfterMarker = cmpPos(c.startLine, c.startChar, m.endLine + 1, 0) >= 0;
    if (changeBeforeMarker) {
      if (delta === 0) {
        kept.push(m);
      } else {
        kept.push({ ...m, startLine: m.startLine + delta, endLine: m.endLine + delta });
        changed = true;
      }
    } else if (changeAfterMarker) {
      kept.push(m);
    } else {
      removed.push(m);
      changed = true;
    }
  }
  return { markers: kept, removed, changed };
}

/** Applies multiple changes of one edit event, bottom-up. */
export function applyChanges(markers: Marker[], changes: EditChange[]): ApplyResult {
  const sorted = [...changes].sort(
    (a, b) => cmpPos(b.startLine, b.startChar, a.startLine, a.startChar),
  );
  let current = markers;
  const removed: Marker[] = [];
  let changed = false;
  for (const c of sorted) {
    const r = applyChange(current, c);
    current = r.markers;
    removed.push(...r.removed);
    changed = changed || r.changed;
  }
  return { markers: current, removed, changed };
}

function intersectsLines(m: Marker, startLine: number, endLine: number): boolean {
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
