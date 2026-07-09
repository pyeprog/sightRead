import * as vscode from 'vscode';
import { SPOTLIGHT_LEVEL_NAMES, SpotlightLevel, intersectsAny, pathToLine } from '../core/focus';
import { SegmentKind } from '../core/segmentation';
import { SpotlightRender } from './compositor';
import { DocSegmentNode, SegmentCache } from './segmentCache';
import { FunctionInfo, findFunctionAtCursor } from './symbols';

const KIND_ICONS: Record<SegmentKind, { icon: string; color?: string }> = {
  branch: { icon: 'git-branch', color: 'charts.yellow' },
  loop: { icon: 'sync', color: 'charts.green' },
  try: { icon: 'shield', color: 'charts.red' },
  with: { icon: 'link', color: 'charts.blue' },
  switch: { icon: 'list-tree', color: 'charts.yellow' },
  definition: { icon: 'symbol-class', color: 'charts.purple' },
  assignment: { icon: 'symbol-variable', color: 'charts.orange' },
  call: { icon: 'symbol-method', color: 'charts.blue' },
  flow: { icon: 'arrow-right', color: 'charts.foreground' },
  other: { icon: 'circle-small' },
};

export function segmentIcon(kind: SegmentKind): vscode.ThemeIcon {
  const spec = KIND_ICONS[kind];
  return spec.color
    ? new vscode.ThemeIcon(spec.icon, new vscode.ThemeColor(spec.color))
    : new vscode.ThemeIcon(spec.icon);
}

export interface SegmentElement {
  uriString: string;
  node: DocSegmentNode;
}

/** Deterministic per-node decoration URI. Deliberately generation-free: the
 *  dim state must survive the id churn of collapseAllTree()/expandAll(). */
function segmentUri(uriString: string, node: DocSegmentNode): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'sightread-seg',
    path: `/${node.startLine}-${node.endLine}`,
    query: uriString,
  });
}

const DIM_COLOR = new vscode.ThemeColor('list.deemphasizedForeground');

/**
 * Sidebar tree of the current function's segments, updated by the cursor
 * pipeline. This replaces the abandoned Outline injection: providing document
 * symbols while also consuming them deadlocks on VS Code's shared in-flight
 * outline computation, so segments get their own view instead.
 *
 * The view mirrors the editor's spotlight: the deepest segment under the
 * cursor gets selected (reveal) and its label highlighted, and segments
 * outside the lit set render dimmed. Tree items cannot be drawn brighter than
 * the default foreground, so "lit" is expressed by dimming everything else —
 * the same trick the editor spotlight uses.
 */
export class SegmentsViewFeature
  implements
    vscode.TreeDataProvider<SegmentElement>,
    vscode.FileDecorationProvider,
    vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<SegmentElement>;
  private current: { uriString: string; nodes: DocSegmentNode[] } | undefined;
  /** bumped by collapseAllTree()/expandAll() — new item ids force a re-render with the new default state */
  private generation = 0;
  /** default collapsible state for the current render generation */
  private defaultCollapsed = false;
  private currentKey: string | undefined;
  /** deepest segment under the cursor — reveal target and label highlight */
  private cursorNode: DocSegmentNode | undefined;
  /** lit/dim only render while the spotlight is on */
  private spotlightOn = false;
  /** decoration URIs of segments outside the spotlight's lit set */
  private dimmedUris = new Set<string>();
  /** suppresses tree→editor fold sync while reveal() expands ancestors */
  private revealing = false;
  private decoEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  private subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.view = vscode.window.createTreeView('sightread.segmentsView', {
      treeDataProvider: this,
    });
    // tree collapse/expand drives the editor's code folding (one-way: there is
    // no public event for manual code-folding changes, so the reverse relies
    // on the fold/unfold title buttons)
    this.subscriptions.push(
      this.view,
      this.view.onDidCollapseElement((e) => this.syncCodeFold(e.element, 'editor.fold')),
      this.view.onDidExpandElement((e) => this.syncCodeFold(e.element, 'editor.unfold')),
      vscode.window.registerFileDecorationProvider(this),
    );
  }

  private syncCodeFold(el: SegmentElement, command: 'editor.fold' | 'editor.unfold'): void {
    if (this.revealing) {
      return; // reveal()'s programmatic expansion is not a user fold gesture
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== el.uriString) {
      return;
    }
    void vscode.commands.executeCommand(command, { selectionLines: [el.node.startLine] });
  }

  /** Collapses all tree nodes (used by the fold-skeleton button). */
  collapseAllTree(): void {
    this.defaultCollapsed = true;
    this.generation++;
    this.emitter.fire();
  }

  /** Expands all tree nodes again (used by the unfold-skeleton button). */
  expandAll(): void {
    this.defaultCollapsed = false;
    this.generation++;
    this.emitter.fire();
  }

  /** Spotlight level shown as a number badge on the activity-bar icon. */
  setSpotlightLevel(level: SpotlightLevel): void {
    this.view.badge =
      level > 0
        ? { value: level, tooltip: `Spotlight: ${SPOTLIGHT_LEVEL_NAMES[level]}` }
        : undefined;
  }

  update(
    doc: vscode.TextDocument,
    fn: FunctionInfo | undefined,
    tree: DocSegmentNode[],
    cursorLine: number,
    spot: SpotlightRender | undefined,
  ): void {
    this.current = fn ? { uriString: doc.uri.toString(), nodes: tree } : undefined;
    const path = this.current ? pathToLine(tree, cursorLine) : [];
    this.cursorNode = path[path.length - 1];
    this.spotlightOn = spot !== undefined;
    this.dimmedUris = new Set();
    if (this.current && spot) {
      const uriString = this.current.uriString;
      const markDim = (nodes: DocSegmentNode[]): void => {
        for (const n of nodes) {
          if (!intersectsAny({ start: n.startLine, end: n.endLine }, spot.lit)) {
            this.dimmedUris.add(segmentUri(uriString, n).toString());
          }
          markDim(n.children);
        }
      };
      markDim(tree);
    }
    // moving to a different function resets a lingering collapsed-by-fold state
    const key = fn ? `${doc.uri.toString()}:${fn.range.start.line}` : undefined;
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.defaultCollapsed = false;
    }
    if (!fn) {
      this.view.message = 'Place the cursor inside a function to see its segments.';
      this.view.description = undefined;
    } else {
      this.view.message = undefined;
      this.view.description = fn.name;
    }
    this.emitter.fire();
    this.decoEmitter.fire(undefined);
  }

  /**
   * Selects the deepest segment containing the cursor, without stealing
   * focus. Skipped while the tree is fold-collapsed: reveal would re-expand
   * the ancestors it needs visible (and, through syncCodeFold, unfold the
   * very code the user just folded).
   */
  async revealCursor(): Promise<void> {
    if (!this.current || !this.cursorNode || !this.view.visible || this.defaultCollapsed) {
      return;
    }
    this.revealing = true;
    try {
      await this.view.reveal(
        { uriString: this.current.uriString, node: this.cursorNode },
        { select: true, focus: false },
      );
    } catch (_e) {
      // best-effort: the tree may have refreshed mid-reveal or the view hid
    } finally {
      this.revealing = false;
    }
  }

  /** Current tree selection (test hook). */
  get treeSelection(): readonly SegmentElement[] {
    return this.view.selection;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'sightread-seg' || !this.dimmedUris.has(uri.toString())) {
      return undefined;
    }
    return { color: DIM_COLOR };
  }

  getTreeItem(el: SegmentElement): vscode.TreeItem {
    // the cursor's segment reads as the anchor: full-label highlight
    const label: string | vscode.TreeItemLabel =
      this.spotlightOn && el.node === this.cursorNode
        ? { label: el.node.name, highlights: [[0, el.node.name.length]] }
        : el.node.name;
    const item = new vscode.TreeItem(
      label,
      el.node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : this.defaultCollapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `${el.uriString}:${el.node.startLine}-${el.node.endLine}:g${this.generation}`;
    const resourceUri = segmentUri(el.uriString, el.node);
    item.resourceUri = resourceUri; // carries the dim decoration (label color)
    item.iconPath = this.dimmedUris.has(resourceUri.toString())
      ? new vscode.ThemeIcon(KIND_ICONS[el.node.kind].icon, DIM_COLOR)
      : segmentIcon(el.node.kind);
    item.description = el.node.detail;
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === el.uriString,
    );
    if (doc && el.node.startLine < doc.lineCount) {
      item.tooltip = doc.lineAt(el.node.startLine).text.trim();
    }
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [el.uriString, el.node.startLine],
    };
    return item;
  }

  getChildren(el?: SegmentElement): SegmentElement[] {
    if (!el) {
      return (this.current?.nodes ?? []).map((node) => ({
        uriString: this.current!.uriString,
        node,
      }));
    }
    return el.node.children.map((node) => ({ uriString: el.uriString, node }));
  }

  /** Required by TreeView.reveal — resolved by node identity in the current tree. */
  getParent(el: SegmentElement): SegmentElement | undefined {
    const findParent = (nodes: DocSegmentNode[]): DocSegmentNode | undefined => {
      for (const n of nodes) {
        if (n.children.includes(el.node)) {
          return n;
        }
        const deeper = findParent(n.children);
        if (deeper) {
          return deeper;
        }
      }
      return undefined;
    };
    const parent = findParent(this.current?.nodes ?? []);
    return parent ? { uriString: el.uriString, node: parent } : undefined;
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}

/** "Go to Segment…" — QuickPick over the flattened segment tree. */
export function registerGoToSegment(
  context: vscode.ExtensionContext,
  cache: SegmentCache,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.goToSegment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const fn = await findFunctionAtCursor(editor.document, editor.selection.active);
      if (!fn) {
        void vscode.window.showInformationMessage('SightRead: cursor is not inside a function.');
        return;
      }
      const tree = cache.get(editor.document, fn.range);
      if (tree.length === 0) {
        void vscode.window.showInformationMessage('SightRead: no segments detected here.');
        return;
      }
      const flat: { node: DocSegmentNode; depth: number }[] = [];
      const flatten = (nodes: DocSegmentNode[], depth: number): void => {
        for (const node of nodes) {
          flat.push({ node, depth });
          flatten(node.children, depth + 1);
        }
      };
      flatten(tree, 0);
      const picked = await vscode.window.showQuickPick(
        flat.map((f) => ({
          label: `${' '.repeat(f.depth)}${f.node.name}`,
          description: f.node.detail,
          segment: f.node,
        })),
        { placeHolder: `Segments of ${fn.name}` },
      );
      if (picked) {
        const pos = new vscode.Position(picked.segment.startLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    }),
  );
}
