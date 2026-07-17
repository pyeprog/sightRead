/**
 * Spotlight focus-set computation and line-range algebra.
 * Pure logic, no vscode dependency.
 *
 * With the recursive segment tree the spotlight has FOUR brightness tiers
 * (design.md §3.5):
 *   heavy dim   — outside the function            (compositor-derived)
 *   medium dim  — non-related parts of the fn     (compositor-derived)
 *   light dim   — siblings of the cursor node     (`light` below)
 *   full        — cursor node + its descendants + related nodes
 *                 + ancestor/function header lines (`lit` below)
 */

import { SegmentNode } from './segmentation';

export interface LineRange {
  /** inclusive */
  start: number;
  /** inclusive */
  end: number;
}

export type SpotlightLevel = 0 | 1 | 2 | 3;

export const SPOTLIGHT_LEVEL_NAMES = ['Off', 'Function', 'Segment', 'Segment+Var'] as const;

export interface FocusTiers {
  /** fully lit ranges */
  lit: LineRange[];
  /** lightly dimmed ranges (siblings); disjoint from `lit` */
  light: LineRange[];
}

/** Merges overlapping or adjacent ranges. */
export function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 1) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** `container` minus `remove` (need not be merged or sorted). */
export function subtractRanges(container: LineRange, remove: LineRange[]): LineRange[] {
  const result: LineRange[] = [];
  let cursor = container.start;
  for (const r of mergeLineRanges(remove)) {
    if (r.end < container.start || r.start > container.end) {
      continue;
    }
    if (r.start > cursor) {
      result.push({ start: cursor, end: Math.min(r.start - 1, container.end) });
    }
    cursor = Math.max(cursor, r.end + 1);
    if (cursor > container.end) {
      break;
    }
  }
  if (cursor <= container.end) {
    result.push({ start: cursor, end: container.end });
  }
  return result;
}

/** every range in `ranges` minus `remove` */
export function subtractRangeList(ranges: LineRange[], remove: LineRange[]): LineRange[] {
  return ranges.flatMap((r) => subtractRanges(r, remove));
}

export function rangeContaining(ranges: LineRange[], line: number): LineRange | undefined {
  return ranges.find((r) => r.start <= line && line <= r.end);
}

export function intersectsAny(range: LineRange, ranges: LineRange[]): boolean {
  return ranges.some((r) => r.start <= range.end && r.end >= range.start);
}

/** Path of nodes from a top-level node down to the deepest node containing `line`. */
export function pathToLine(nodes: SegmentNode[], line: number): SegmentNode[] {
  for (const n of nodes) {
    if (n.startLine <= line && line <= n.endLine) {
      return [n, ...pathToLine(n.children, line)];
    }
  }
  return [];
}

/** Deepest segment containing each line; lines outside any segment are ignored. */
export function segmentsAtLines(tree: SegmentNode[], lines: number[]): LineRange[] {
  const out: LineRange[] = [];
  for (const line of lines) {
    const path = pathToLine(tree, line);
    const node = path[path.length - 1];
    if (node) {
      out.push({ start: node.startLine, end: node.endLine });
    }
  }
  return out;
}

/**
 * Computes the focus tiers. Returns empty tiers at level 0; degrades to
 * whole-function lighting when the tree is missing or the cursor sits in a
 * gap between top-level segments. Ancestor header lines (and the function
 * header) stay fully lit as context anchors.
 *
 * At level 3, occurrences OUTSIDE `fn` light their segment in `outerTree`
 * (the outermost enclosing function) as related islands — this is how a local
 * function's definition lights up from a call site inside a sibling local
 * function, and vice versa for closure variables.
 */
export function computeFocus(
  level: SpotlightLevel,
  fn: LineRange,
  tree: SegmentNode[],
  cursorLine: number,
  occurrenceLines: number[],
  outerTree: SegmentNode[] = [],
): FocusTiers {
  if (level === 0) {
    return { lit: [], light: [] };
  }
  const islands =
    level === 3
      ? segmentsAtLines(
          outerTree,
          occurrenceLines.filter((l) => l < fn.start || l > fn.end),
        )
      : [];
  if (level === 1 || tree.length === 0) {
    return { lit: mergeLineRanges([fn, ...islands]), light: [] };
  }
  const path = pathToLine(tree, cursorLine);
  if (path.length === 0) {
    return { lit: mergeLineRanges([fn, ...islands]), light: [] };
  }
  const node = path[path.length - 1];
  const lit: LineRange[] = [
    { start: fn.start, end: fn.start },
    ...path.map((n) => ({ start: n.startLine, end: n.startLine })),
    { start: node.startLine, end: node.endLine },
  ];
  if (level === 3) {
    lit.push(...segmentsAtLines(tree, occurrenceLines), ...islands);
  }
  const siblings = (path.length >= 2 ? path[path.length - 2].children : tree).filter(
    (s) => s !== node,
  );
  const litMerged = mergeLineRanges(lit);
  const light = subtractRangeList(
    mergeLineRanges(siblings.map((s) => ({ start: s.startLine, end: s.endLine }))),
    litMerged,
  );
  return { lit: litMerged, light };
}
