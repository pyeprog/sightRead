import * as vscode from 'vscode';
import { SPOTLIGHT_LEVEL_SHORT, SpotlightLevel, intersectsAny, pathToLine } from '../core/focus';
import { Mark, markVisible, marksInLineRange, removeMarksInRange } from '../core/marks';
import { SegmentKind } from '../core/segmentation';
import { Compositor, SpotlightRender } from './compositor';
import { addLineMarker, pickMarkerColor, promptMarkerNote } from './highlighter';
import { MarkRepository } from './markRepository';
import { accentThemeColor } from './palette';
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

const TOOLTIP_MAX_LINES = 20;

/** Full segment source (dedented, line-capped) — the overflow channel for
 *  whatever the one-line label could not carry. */
function segmentTooltip(doc: vscode.TextDocument, node: DocSegmentNode): vscode.MarkdownString {
  const lastLine = Math.min(node.endLine, doc.lineCount - 1);
  const capped = Math.min(lastLine, node.startLine + TOOLTIP_MAX_LINES - 1);
  const lines: string[] = [];
  for (let i = node.startLine; i <= capped; i++) {
    lines.push(doc.lineAt(i).text);
  }
  const indents = lines
    .filter((l) => l.trim() !== '')
    .map((l) => l.length - l.trimStart().length);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  const text = lines.map((l) => l.slice(cut)).join('\n') + (capped < lastLine ? '\n…' : '');
  return new vscode.MarkdownString().appendCodeblock(text, doc.languageId);
}

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

  /** current spotlight level — always shown in the view message */
  private spotlightLevel: SpotlightLevel = 0;

  constructor(
    private repo: MarkRepository,
    private compositor: Compositor,
  ) {
    this.view = vscode.window.createTreeView('sightread.segmentsView', {
      treeDataProvider: this,
    });
    // mark mutations and filter changes re-tint labels (decorations) and
    // icons (tree items)
    const retint = (): void => {
      this.emitter.fire();
      this.decoEmitter.fire(undefined);
    };
    // tree collapse/expand drives the editor's code folding (one-way: there is
    // no public event for manual code-folding changes, so the reverse relies
    // on the fold/unfold title buttons)
    this.subscriptions.push(
      this.view,
      this.view.onDidCollapseElement((e) => this.syncCodeFold(e.element, 'editor.fold')),
      this.view.onDidExpandElement((e) => this.syncCodeFold(e.element, 'editor.unfold')),
      vscode.window.registerFileDecorationProvider(this),
      repo.onDidChange(retint),
      compositor.onDidChangeHiddenAccents(retint),
    );
    void vscode.commands.executeCommand('setContext', 'sightread.skeletonFolded', false);
    this.syncMessage();
  }

  /** Tracks defaultCollapsed and mirrors it into the when-clause context that
   *  swaps the fold/unfold title button. */
  private setFolded(folded: boolean): void {
    if (this.defaultCollapsed === folded) {
      return;
    }
    this.defaultCollapsed = folded;
    void vscode.commands.executeCommand('setContext', 'sightread.skeletonFolded', folded);
  }

  /** Whether any visible mark intersects the segment's line range ("相交即染"). */
  private isMarked(uriString: string, node: DocSegmentNode): boolean {
    return this.visibleMarksIn(vscode.Uri.parse(uriString), node.startLine, node.endLine).length > 0;
  }

  /** Marks intersecting the range, minus filtered accents (hidden everywhere). */
  private visibleMarksIn(uri: vscode.Uri, startLine: number, endLine: number): Mark[] {
    return marksInLineRange(this.repo.get(uri).marks, startLine, endLine).filter((m) =>
      markVisible(m.accent, this.compositor.getHiddenAccents()),
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
    this.setFolded(true);
    this.generation++;
    this.emitter.fire();
  }

  /** Expands all tree nodes again (used by the unfold-skeleton button). */
  expandAll(): void {
    this.setFolded(false);
    this.generation++;
    this.emitter.fire();
  }

  /** Spotlight level lives in the view message — the always-visible mode line. */
  setSpotlightLevel(level: SpotlightLevel): void {
    this.spotlightLevel = level;
    this.syncMessage();
  }

  /** One message line, two glyph-led fields: ◎ (lens — the spotlight level)
   *  and ↖ (cursor) in/outside function. Codicons don't render in tree-view
   *  messages (plain string only); the eye emoji ignores U+FE0E on some font
   *  chains and comes out colored, so the lens ring stands in for it. */
  private syncMessage(): void {
    const level = SPOTLIGHT_LEVEL_SHORT[this.spotlightLevel];
    this.view.message = `◎ ${level} · ↖ ${this.current ? 'in function' : 'outside function'}`;
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
      this.setFolded(false);
    }
    this.view.description = fn ? fn.name : undefined;
    this.syncMessage();
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
    if (uri.scheme !== 'sightread-seg') {
      return undefined;
    }
    // the segment's line range travels in the URI (path `/start-end`, query = doc uri)
    const range = /^\/(\d+)-(\d+)$/.exec(uri.path);
    if (range) {
      const marks = this.visibleMarksIn(
        vscode.Uri.parse(uri.query),
        Number(range[1]),
        Number(range[2]),
      );
      // manual color wins over a role accent on overlap (human judgment first)
      const mark = marks.find((m) => m.accent.kind === 'color') ?? marks[0];
      if (mark) {
        return { color: accentThemeColor(mark.accent) }; // mark tint wins over dim
      }
    }
    return this.dimmedUris.has(uri.toString()) ? { color: DIM_COLOR } : undefined;
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
    item.contextValue = 'segment';
    const resourceUri = segmentUri(el.uriString, el.node);
    item.resourceUri = resourceUri; // carries the dim/marker decoration (label color)
    // a marked segment keeps its normal icon even while dimmed, matching its tinted label
    item.iconPath =
      this.dimmedUris.has(resourceUri.toString()) && !this.isMarked(el.uriString, el.node)
        ? new vscode.ThemeIcon(KIND_ICONS[el.node.kind].icon, DIM_COLOR)
        : segmentIcon(el.node.kind);
    item.description = el.node.detail;
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === el.uriString,
    );
    if (doc && el.node.startLine < doc.lineCount) {
      item.tooltip = segmentTooltip(doc, el.node);
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

/** Right-click mark/unmark on Segments-view items (menus in package.json). */
export function registerSegmentMarkCommands(
  context: vscode.ExtensionContext,
  repo: MarkRepository,
  compositor: Compositor,
): void {
  const docFor = async (el: SegmentElement): Promise<vscode.TextDocument> =>
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === el.uriString) ??
    (await vscode.workspace.openTextDocument(vscode.Uri.parse(el.uriString)));
  const markSegment = async (
    el: SegmentElement | undefined,
    withNote: boolean,
  ): Promise<void> => {
    if (!el) {
      return;
    }
    const color = await pickMarkerColor();
    if (!color) {
      return;
    }
    const note = withNote ? await promptMarkerNote() : undefined;
    addLineMarker(
      repo,
      compositor,
      await docFor(el),
      el.node.startLine,
      el.node.endLine,
      color,
      note,
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.markSegment', (el?: SegmentElement) =>
      markSegment(el, false),
    ),
    vscode.commands.registerCommand('sightread.markSegmentWithNote', (el?: SegmentElement) =>
      markSegment(el, true),
    ),
    vscode.commands.registerCommand('sightread.removeSegmentMarkers', (el?: SegmentElement) => {
      if (!el) {
        return;
      }
      const uri = vscode.Uri.parse(el.uriString);
      repo.set(uri, removeMarksInRange(repo.get(uri), el.node.startLine, el.node.endLine));
      compositor.renderVisibleFor(uri);
    }),
  );
}

/**
 * Right-click deep fold/unfold on Segments-view items: every folding region
 * INSIDE the segment (its own region excluded — folding it would hide the
 * very structure being inspected). Regions come from the language's folding
 * provider when available, falling back to the segment tree's heuristic
 * header lines, mirroring skeleton fold (design.md §3.1).
 */
export function registerSegmentFoldCommands(context: vscode.ExtensionContext): void {
  const linesInside = async (el: SegmentElement): Promise<number[]> => {
    try {
      const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
        'vscode.executeFoldingRangeProvider',
        vscode.Uri.parse(el.uriString),
      );
      if (ranges && ranges.length > 0) {
        return ranges
          .filter((r) => r.start > el.node.startLine && r.end <= el.node.endLine)
          .map((r) => r.start);
      }
    } catch (_e) {
      // command or provider unavailable — fall back to the heuristic headers
    }
    const lines: number[] = [];
    const walk = (ns: DocSegmentNode[]): void => {
      for (const n of ns) {
        lines.push(...(n.headerLines ?? []));
        walk(n.children);
      }
    };
    walk([el.node]);
    return lines.filter((l) => l > el.node.startLine);
  };
  // editor.fold/unfold act on the active editor only
  const activeMatches = (el: SegmentElement): boolean =>
    vscode.window.activeTextEditor?.document.uri.toString() === el.uriString;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sightread.foldSegmentDeep',
      async (el?: SegmentElement) => {
        if (!el || !activeMatches(el)) {
          return;
        }
        const lines = await linesInside(el);
        if (lines.length > 0) {
          await vscode.commands.executeCommand('editor.fold', {
            levels: 1,
            selectionLines: lines,
          });
        }
      },
    ),
    vscode.commands.registerCommand(
      'sightread.unfoldSegmentDeep',
      async (el?: SegmentElement) => {
        if (!el || !activeMatches(el)) {
          return;
        }
        // reveal the segment itself first: unfolding only the inner regions
        // of a collapsed segment changes nothing on screen (skeleton-fold lesson)
        await vscode.commands.executeCommand('editor.unfold', {
          direction: 'up',
          levels: 32,
          selectionLines: [el.node.startLine],
        });
        const lines = await linesInside(el);
        if (lines.length > 0) {
          await vscode.commands.executeCommand('editor.unfold', {
            levels: 1,
            selectionLines: lines,
          });
        }
      },
    ),
  );
}

/**
 * "Go to Segment…" — QuickPick over the flattened segment tree, opened on the
 * cursor's segment. Moving the highlight previews the segment in the editor
 * (range highlight + scroll), the native Go to Symbol behavior; Esc restores
 * the viewport. The preview never touches the selection, so the cursor
 * pipeline (spotlight, trail) stays out of it.
 */
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
      type SegmentPick = vscode.QuickPickItem & { segment: DocSegmentNode };
      const items: SegmentPick[] = [];
      const flatten = (nodes: DocSegmentNode[], depth: number): void => {
        for (const node of nodes) {
          items.push({
            // em-space indentation (plain spaces vanish in the proportional
            // quick-pick font); icons match the Segments view
            label: `${'\u2003'.repeat(depth)}$(${KIND_ICONS[node.kind].icon}) ${node.name}`,
            description: node.detail,
            segment: node,
          });
          flatten(node.children, depth + 1);
        }
      };
      flatten(tree, 0);
      const previewDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        isWholeLine: true,
      });
      const origin = editor.visibleRanges[0];
      const qp = vscode.window.createQuickPick<SegmentPick>();
      qp.placeholder = `Segments of ${fn.name}`;
      qp.matchOnDescription = true;
      qp.items = items;
      // open on the cursor's segment
      const cursorPath = pathToLine(tree, editor.selection.active.line);
      const atCursor = items.find((item) => item.segment === cursorPath[cursorPath.length - 1]);
      if (atCursor) {
        qp.activeItems = [atCursor];
      }
      let accepted = false;
      qp.onDidChangeActive((active) => {
        const seg = active[0]?.segment;
        if (!seg) {
          return;
        }
        const range = new vscode.Range(seg.startLine, 0, seg.endLine, 0);
        editor.setDecorations(previewDeco, [range]);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      });
      qp.onDidAccept(() => {
        accepted = true;
        const seg = qp.selectedItems[0]?.segment;
        qp.hide();
        if (seg) {
          const pos = new vscode.Position(seg.startLine, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        }
      });
      qp.onDidHide(() => {
        previewDeco.dispose();
        if (!accepted && origin) {
          // Esc — put the viewport back where the preview found it
          editor.revealRange(
            new vscode.Range(origin.start, origin.start),
            vscode.TextEditorRevealType.AtTop,
          );
        }
        qp.dispose();
      });
      qp.show();
    }),
  );
}
