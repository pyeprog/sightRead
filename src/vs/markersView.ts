import * as vscode from 'vscode';
import {
  Guide,
  Mark,
  guideEnvelope,
  guideMarks,
  markVisible,
  marksAtLine,
  removeMark,
} from '../core/marks';
import { Compositor } from './compositor';
import { MarkRepository } from './markRepository';
import { accentPaint, guidePaint, swatchIcon } from './palette';

export interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
}
export interface GuideNode {
  kind: 'guide';
  uri: vscode.Uri;
  guide: Guide;
}
export interface MarkNode {
  kind: 'mark';
  uri: vscode.Uri;
  /** a loose manual mark, or a guide step (mark.guideId set) */
  mark: Mark;
}
export type MarksNode = FileNode | GuideNode | MarkNode;

/**
 * Sidebar list of every mark in the workspace, grouped by file. AI guides
 * sit as one node each with their steps beneath; loose manual marks list
 * beside them in line order. Marks of a hidden accent (color or role)
 * disappear here too — the filter applies everywhere, not just to editor
 * decorations.
 */
export class MarkersViewFeature
  implements vscode.TreeDataProvider<MarksNode>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<MarksNode>;
  /** bumped by collapseAllTree()/expandAll() — new item ids force a re-render with the new default state */
  private generation = 0;
  /** default collapsible state for the current render generation */
  private defaultCollapsed = false;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private repo: MarkRepository,
    private compositor: Compositor,
  ) {
    this.view = vscode.window.createTreeView('sightread.markersView', {
      treeDataProvider: this,
    });
    // an active filter silently hides marks — flag it above the tree with the
    // real hidden count. A set message also suppresses the welcome view, so it
    // must clear whenever nothing is actually hidden (e.g. after Clear All).
    const syncFilterMessage = (): void => {
      const hidden = compositor.getHiddenAccents();
      let count = 0;
      if (hidden.size > 0) {
        for (const u of repo.uris()) {
          count += repo
            .get(vscode.Uri.parse(u))
            .marks.filter((m) => !markVisible(m.accent, hidden)).length;
        }
      }
      this.view.message = count === 0 ? undefined : `🚫 ${count} hidden`;
    };
    syncFilterMessage();
    void vscode.commands.executeCommand('setContext', 'sightread.markersFolded', false);
    this.subscriptions.push(
      this.view,
      repo.onDidChange(() => {
        syncFilterMessage();
        this.emitter.fire();
      }),
      compositor.onDidChangeHiddenAccents(() => {
        syncFilterMessage();
        this.emitter.fire();
      }),
      vscode.commands.registerCommand('sightread.markersCollapseAll', () =>
        this.setFolded(true),
      ),
      vscode.commands.registerCommand('sightread.markersExpandAll', () => this.setFolded(false)),
      vscode.commands.registerCommand('sightread.removeMarker', (node: MarksNode) => {
        if (node?.kind !== 'mark') {
          return;
        }
        repo.set(node.uri, removeMark(repo.get(node.uri), node.mark.id));
        compositor.renderVisibleFor(node.uri);
      }),
      vscode.commands.registerCommand(
        'sightread.editMarkerNoteItem',
        async (node: MarksNode) => {
          if (node?.kind !== 'mark') {
            return;
          }
          const note = await vscode.window.showInputBox({
            prompt: 'Marker note',
            value: node.mark.note ?? '',
          });
          if (note === undefined) {
            return; // cancelled
          }
          const state = repo.get(node.uri);
          repo.set(node.uri, {
            ...state,
            marks: state.marks.map((m) =>
              m.id === node.mark.id ? { ...m, note: note || undefined } : m,
            ),
          });
          compositor.renderVisibleFor(node.uri);
        },
      ),
    );
  }

  /** Current view message (test hook). */
  get viewMessage(): string | undefined {
    return this.view.message;
  }

  /** Re-renders all items (palette change: swatch icons are built per item). */
  refresh(): void {
    this.emitter.fire();
  }

  /** Tree-only collapse/expand-all, mirrored into the when-clause context
   *  that swaps the title button. Never touches editor folding. */
  private setFolded(folded: boolean): void {
    if (this.defaultCollapsed === folded) {
      return;
    }
    this.defaultCollapsed = folded;
    this.generation++;
    void vscode.commands.executeCommand('setContext', 'sightread.markersFolded', folded);
    this.emitter.fire();
  }

  private parentState(): vscode.TreeItemCollapsibleState {
    return this.defaultCollapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
  }

  getTreeItem(node: MarksNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.uri, this.parentState());
      item.id = `file:${node.uri.toString()}:g${this.generation}`;
      item.contextValue = 'file';
      item.description = String(this.repo.get(node.uri).marks.length);
      return item;
    }
    if (node.kind === 'guide') {
      const g = node.guide;
      const state = this.repo.get(node.uri);
      const steps = guideMarks(state, g.id);
      const item = new vscode.TreeItem(`✦ ${g.subject}`, this.parentState());
      item.id = `guide:${node.uri.toString()}:${g.id}:g${this.generation}`;
      item.description = g.summary ?? `${steps.length} steps`;
      item.iconPath = swatchIcon(guidePaint());
      item.contextValue = 'guide';
      item.tooltip = g.summary;
      const envelope = guideEnvelope(state, g.id);
      if (envelope) {
        item.command = {
          command: 'sightread.revealLocation',
          title: 'Reveal',
          arguments: [node.uri.toString(), envelope.startLine],
        };
      }
      return item;
    }
    const m = node.mark;
    const lines =
      m.startLine === m.endLine
        ? `L${m.startLine + 1}`
        : `L${m.startLine + 1}–${m.endLine + 1}`;
    const item = new vscode.TreeItem(
      m.guideId !== undefined
        ? `${(m.order ?? 0) + 1}. ${
            m.accent.kind === 'role' && m.accent.role ? `[${m.accent.role}] ` : ''
          }${m.note ?? ''}`
        : m.note ?? m.preview ?? lines,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `mark:${node.uri.toString()}:${m.id}:g${this.generation}`;
    const withPreview =
      m.preview && (m.guideId !== undefined || m.note) ? `${lines} · ${m.preview}` : lines;
    item.description = withPreview;
    item.iconPath = swatchIcon(accentPaint(m.accent));
    item.contextValue = 'mark';
    item.tooltip = m.note && m.guideId === undefined ? `${m.note}\n${m.preview ?? ''}` : m.note ?? m.preview;
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [node.uri.toString(), m.startLine],
    };
    return item;
  }

  /** Required by TreeView.reveal — items live under their file group. */
  getParent(node: MarksNode): MarksNode | undefined {
    if (node.kind === 'mark' && node.mark.guideId !== undefined) {
      const guide = this.repo
        .get(node.uri)
        .guides.find((g) => g.id === node.mark.guideId);
      return guide ? { kind: 'guide', uri: node.uri, guide } : undefined;
    }
    if (node.kind === 'mark' || node.kind === 'guide') {
      return { kind: 'file', uri: node.uri };
    }
    return undefined;
  }

  /** Follows the cursor: selects the mark under it, without stealing focus.
   *  Skipped while the tree is collapsed — reveal would re-expand it. */
  async revealCursor(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    if (!this.view.visible || this.defaultCollapsed) {
      return;
    }
    const hidden = this.compositor.getHiddenAccents();
    const hits = marksAtLine(this.repo.get(doc.uri).marks, pos.line).filter((m) =>
      markVisible(m.accent, hidden),
    );
    // a loose mark outranks a step: human judgment before the AI's
    const mark = hits.find((m) => m.guideId === undefined) ?? hits[0];
    if (!mark) {
      return;
    }
    try {
      await this.view.reveal(
        { kind: 'mark', uri: doc.uri, mark },
        { select: true, focus: false },
      );
    } catch (_e) {
      // best-effort: the repo may have changed mid-reveal
    }
  }

  getChildren(node?: MarksNode): MarksNode[] {
    if (!node) {
      // the empty state is the viewsWelcome contribution (package.json);
      // a file whose every entry is filtered out drops with its marks
      return this.repo
        .uris()
        .map((u) => ({ kind: 'file' as const, uri: vscode.Uri.parse(u) }))
        .filter((f) => this.getChildren(f).length > 0);
    }
    if (node.kind === 'file') {
      const state = this.repo.get(node.uri);
      const hidden = this.compositor.getHiddenAccents();
      // line order, not creation order — the list mirrors the file top-down
      const entries: { line: number; node: MarksNode }[] = [];
      for (const guide of state.guides) {
        const envelope = guideEnvelope(state, guide.id);
        entries.push({
          line: envelope?.startLine ?? 0,
          node: { kind: 'guide', uri: node.uri, guide },
        });
      }
      for (const mark of state.marks) {
        if (mark.guideId === undefined && markVisible(mark.accent, hidden)) {
          entries.push({ line: mark.startLine, node: { kind: 'mark', uri: node.uri, mark } });
        }
      }
      return entries.sort((a, b) => a.line - b.line).map((e) => e.node);
    }
    if (node.kind === 'guide') {
      // order stays the original reading-order position so numbering matches
      // the editor's step badges (which also skip hidden steps without renumbering)
      const state = this.repo.get(node.uri);
      const hidden = this.compositor.getHiddenAccents();
      return guideMarks(state, node.guide.id)
        .filter((m) => markVisible(m.accent, hidden))
        .map((mark) => ({ kind: 'mark' as const, uri: node.uri, mark }));
    }
    return [];
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
