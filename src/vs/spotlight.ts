import * as vscode from 'vscode';
import { LineRange, SpotlightLevel, computeFocus } from '../core/focus';
import { SpotlightRender } from './compositor';
import { DocSegmentNode } from './segmentCache';
import { FunctionInfo } from './symbols';

const MODE_TO_LEVEL: Record<string, SpotlightLevel> = {
  off: 0,
  fn: 1,
  seg: 2,
  'seg+var': 3,
};

/**
 * Spotlight mode state (design.md §3.5): one mode, three levels, cursor-driven,
 * four brightness tiers over the recursive segment tree. The focus computation
 * itself lives in core/focus.ts. Level display lives on the SightRead view
 * container badge (see SegmentsViewFeature) and on the status bar item.
 */
export class SpotlightController {
  private level: SpotlightLevel;

  constructor() {
    const configured = vscode.workspace
      .getConfiguration('sightread')
      .get('spotlight.defaultMode', 'off');
    this.level = MODE_TO_LEVEL[String(configured).toLowerCase()] ?? 0;
  }

  get currentLevel(): SpotlightLevel {
    return this.level;
  }

  /** Off → Seg+Var → Seg → Fn → Off: the most detailed mode comes first. */
  cycle(): void {
    this.level = (((this.level as number) + 3) % 4) as SpotlightLevel;
  }

  off(): void {
    this.level = 0;
  }

  compute(
    fn: FunctionInfo | undefined,
    tree: DocSegmentNode[],
    cursorLine: number,
    occurrenceLines: number[],
    outerTree: DocSegmentNode[] = [],
  ): SpotlightRender | undefined {
    if (this.level === 0 || !fn) {
      return undefined;
    }
    const fnRange: LineRange = { start: fn.range.start.line, end: fn.range.end.line };
    const tiers = computeFocus(this.level, fnRange, tree, cursorLine, occurrenceLines, outerTree);
    return { fn: fnRange, lit: tiers.lit, light: tiers.light };
  }
}
