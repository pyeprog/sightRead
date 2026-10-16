import * as vscode from 'vscode';
import { FunctionDeclaration, SpotlightLevel, SpotlightOptions, computeSpotlightFocus, spotlightPreset } from '../core/focus';
import { SpotlightRender } from './compositor';
import { DocSegmentNode } from './segmentCache';
import { FunctionInfo } from './symbols';

const MODE_TO_LEVEL: Record<string, SpotlightLevel> = { off: 0, fn: 1, seg: 2, 'seg+var': 3 };

/** Persist the master switch separately from the user's chosen combination. */
export class SpotlightController {
  private options: SpotlightOptions;

  constructor(private readonly storage: vscode.Memento) {
    const mode = vscode.workspace.getConfiguration('sightread').get<string>('spotlight.defaultMode', 'off');
    const { keepAllFunctionDeclarations, ...saved } = storage.get<Partial<SpotlightOptions> & {
      keepAllFunctionDeclarations?: boolean;
    }>('spotlight.options') ?? {};
    this.options = {
      ...spotlightPreset(MODE_TO_LEVEL[mode.toLowerCase()] ?? 0),
      ...saved,
      keepInnerFunctionDeclarations: saved.keepInnerFunctionDeclarations ?? keepAllFunctionDeclarations ?? false,
    };
  }

  get currentOptions(): SpotlightOptions {
    return { ...this.options };
  }

  async setOptions(options: SpotlightOptions): Promise<void> {
    this.options = { ...options };
    await this.storage.update('spotlight.options', this.options);
  }

  async setLevel(level: SpotlightLevel): Promise<void> {
    await this.setOptions(level === 0 ? { ...this.options, enabled: false } : spotlightPreset(level));
  }

  compute(
    fn: FunctionInfo | undefined,
    tree: DocSegmentNode[],
    cursorLine: number,
    occurrenceLines: number[],
    outerTree: DocSegmentNode[] = [],
    declarations: FunctionDeclaration[] = [],
    lastLine = fn?.range.end.line ?? 0,
  ): SpotlightRender | undefined {
    if (!this.options.enabled || !fn) { return undefined; }
    const fnRange = { start: fn.range.start.line, end: fn.range.end.line };
    const tiers = computeSpotlightFocus(this.options, fnRange, tree, cursorLine,
      occurrenceLines, declarations, lastLine, outerTree);
    return { fn: fnRange, lit: tiers.lit, light: tiers.light };
  }
}

type SpotlightPick = vscode.QuickPickItem & { option?: keyof SpotlightOptions };

/** Enter commits all checkboxes together; hiding the picker cancels the draft. */
export function pickSpotlightOptions(options: SpotlightOptions): Promise<SpotlightOptions | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<SpotlightPick>();
    picker.title = 'Spotlight: Configure Effects';
    picker.placeholder = 'Check effects, then press Enter to apply';
    picker.canSelectMany = true;
    picker.ignoreFocusOut = true;
    picker.items = [
      { label: 'Enable Spotlight', option: 'enabled', alwaysShow: true },
      { label: 'Dim', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Code outside the current function', option: 'dimOutsideFunction' },
      { label: 'Other segments inside the current function', option: 'dimUnrelatedSegments' },
      { label: 'Keep bright', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Other function declarations', description: 'outside the current function', option: 'keepFunctionDeclarations' },
      { label: 'Inner function declarations', description: 'nested inside the current function', option: 'keepInnerFunctionDeclarations' },
      { label: 'Related function declarations', option: 'keepRelatedFunctionDeclarations' },
      { label: 'Segments related to the symbol under the cursor', option: 'keepRelatedSegments' },
    ];
    picker.selectedItems = picker.items.filter((item) => item.option && options[item.option]);
    picker.activeItems = [picker.items[0]];
    picker.onDidAccept(() => {
      const selected = new Set(picker.selectedItems.map((item) => item.option));
      const next = { ...options };
      for (const key of Object.keys(next) as (keyof SpotlightOptions)[]) {
        next[key] = selected.has(key);
      }
      resolve(next);
      picker.hide();
    });
    picker.onDidHide(() => { resolve(undefined); picker.dispose(); });
    picker.show();
  });
}
