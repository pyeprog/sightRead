/**
 * AI reading-guide data operations. Pure logic, no vscode dependency.
 *
 * A guide interprets one subject (function, class, or whole file): a list of
 * role-tagged steps in line order. Guides follow the markers' short-lived
 * philosophy (design.md §3.2), applied wholesale: any edit inside the
 * subject's range deletes the whole guide; edits outside only shift its
 * lines.
 */

import { EditChange, LineSpan, applyChanges } from './markers';

export type InterpretUnit = 'function' | 'class' | 'file';

export interface GuideStep extends LineSpan {
  id: string;
  note: string;
  /** short role tag from the unit's vocabulary (main/setup/fallback/special/entity, …) */
  role?: string;
  /** snapshot of the first step line's text, for list views */
  preview?: string;
}

export interface Guide extends LineSpan {
  id: string;
  /** the interpreted subject's name: function name, class name, or file basename */
  subject: string;
  unit: InterpretUnit;
  /** one-sentence overview, shown on the guide's root node and header line */
  summary?: string;
  /** always ascending by startLine (the parser normalizes) */
  steps: GuideStep[];
}

/**
 * Keeps guides in sync with edits. The guide's own span (the function range
 * at generation time) is the unit: an edit touching it removes the guide, an
 * edit above shifts the guide and all its steps by the same line delta.
 */
export function applyChangesToGuides(
  guides: Guide[],
  changes: EditChange[],
): { guides: Guide[]; changed: boolean } {
  const before = new Map(guides.map((g) => [g.id, g.startLine]));
  const r = applyChanges(guides, changes);
  const shifted = r.items.map((g) => {
    const delta = g.startLine - (before.get(g.id) ?? g.startLine);
    if (delta === 0) {
      return g;
    }
    return {
      ...g,
      steps: g.steps.map((s) => ({
        ...s,
        startLine: s.startLine + delta,
        endLine: s.endLine + delta,
      })),
    };
  });
  return { guides: shifted, changed: r.changed };
}

export function guideAtLine(guides: Guide[], line: number): Guide | undefined {
  return guides.find((g) => line >= g.startLine && line <= g.endLine);
}

/**
 * The step to jump to from `cursorLine`, following the step list. On a step,
 * the adjacent one (undefined past either end). Outside every step, next
 * enters at the first step and prev at the last.
 */
export function adjacentStep(
  guide: Guide,
  cursorLine: number,
  dir: 1 | -1,
): GuideStep | undefined {
  const idx = guide.steps.findIndex(
    (s) => cursorLine >= s.startLine && cursorLine <= s.endLine,
  );
  if (idx === -1) {
    return dir === 1 ? guide.steps[0] : guide.steps[guide.steps.length - 1];
  }
  return guide.steps[idx + dir];
}
