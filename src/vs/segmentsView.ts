import * as vscode from 'vscode';
import { SPOTLIGHT_LEVEL_NAMES, SpotlightLevel } from '../core/focus';
import { SegmentKind } from '../core/segmentation';
import { DocSegmentNode, SegmentCache } from './segmentCache';
import { FunctionInfo, findEnclosingFunction } from './symbols';

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

interface SegmentElement {
  uriString: string;
  node: DocSegmentNode;
}

/**
 * Sidebar tree of the current function's segments, updated by the cursor
 * pipeline. This replaces the abandoned Outline injection: providing document
 * symbols while also consuming them deadlocks on VS Code's shared in-flight
 * outline computation, so segments get their own view instead.
 */
export class SegmentsViewFeature
  implements vscode.TreeDataProvider<SegmentElement>, vscode.Disposable
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
    );
  }

  private syncCodeFold(el: SegmentElement, command: 'editor.fold' | 'editor.unfold'): void {
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

  update(doc: vscode.TextDocument, fn: FunctionInfo | undefined, tree: DocSegmentNode[]): void {
    this.current = fn ? { uriString: doc.uri.toString(), nodes: tree } : undefined;
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
  }

  getTreeItem(el: SegmentElement): vscode.TreeItem {
    const item = new vscode.TreeItem(
      el.node.name,
      el.node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : this.defaultCollapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `${el.uriString}:${el.node.startLine}-${el.node.endLine}:g${this.generation}`;
    item.iconPath = segmentIcon(el.node.kind);
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
      const fn = await findEnclosingFunction(editor.document, editor.selection.active);
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
