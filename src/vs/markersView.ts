import * as vscode from 'vscode';
import { Guide, GuideStep, stepVisible } from '../core/guide';
import { Marker, markersAtLine } from '../core/markers';
import { Compositor } from './compositor';
import type { GuideRepository } from './guideFeature';
import { MarkerRepository } from './highlighter';
import { GUIDE_RGB, PALETTE, circleIcon, guideRoleRgb } from './palette';

export interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
}
export interface MarkerNode {
  kind: 'marker';
  uri: vscode.Uri;
  marker: Marker;
}
export interface GuideNode {
  kind: 'guide';
  uri: vscode.Uri;
  guide: Guide;
}
export interface GuideStepNode {
  kind: 'step';
  uri: vscode.Uri;
  guide: Guide;
  step: GuideStep;
  /** 0-based position in the reading order */
  index: number;
}
export type MarkersNode = FileNode | MarkerNode | GuideNode | GuideStepNode;

/**
 * Sidebar list of every marker and guide in the workspace, grouped by file.
 * AI guides sit under their own node — never mixed into the manual markers.
 * Steps of a role hidden by the guide filter disappear here too — the filter
 * applies everywhere, not just to editor decorations.
 */
export class MarkersViewFeature
  implements vscode.TreeDataProvider<MarkersNode>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<MarkersNode>;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private repo: MarkerRepository,
    private guideRepo: GuideRepository,
    private compositor: Compositor,
  ) {
    this.view = vscode.window.createTreeView('sightread.markersView', {
      treeDataProvider: this,
    });
    this.subscriptions.push(
      this.view,
      repo.onDidChange(() => this.emitter.fire()),
      guideRepo.onDidChange(() => this.emitter.fire()),
      compositor.onDidChangeHiddenGuideRoles(() => this.emitter.fire()),
      vscode.commands.registerCommand('sightread.removeMarker', (node: MarkersNode) => {
        if (node?.kind !== 'marker') {
          return;
        }
        repo.set(
          node.uri,
          repo.get(node.uri).filter((m) => m.id !== node.marker.id),
        );
        compositor.renderVisibleFor(node.uri);
      }),
      vscode.commands.registerCommand(
        'sightread.editMarkerNoteItem',
        async (node: MarkersNode) => {
          if (node?.kind !== 'marker') {
            return;
          }
          const note = await vscode.window.showInputBox({
            prompt: 'Marker note (empty to remove the note)',
            value: node.marker.note ?? '',
          });
          if (note === undefined) {
            return; // cancelled
          }
          repo.set(
            node.uri,
            repo
              .get(node.uri)
              .map((m) => (m.id === node.marker.id ? { ...m, note: note || undefined } : m)),
          );
          compositor.renderVisibleFor(node.uri);
        },
      ),
    );
  }

  getTreeItem(node: MarkersNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `file:${node.uri.toString()}`;
      item.contextValue = 'file';
      item.description = String(
        this.repo.get(node.uri).length + this.guideRepo.get(node.uri).length,
      );
      return item;
    }
    if (node.kind === 'guide') {
      const g = node.guide;
      const item = new vscode.TreeItem(
        `✦ ${g.subject}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `guide:${node.uri.toString()}:${g.id}`;
      item.description = g.summary ?? `${g.steps.length} steps`;
      item.iconPath = circleIcon(GUIDE_RGB);
      item.contextValue = 'guide';
      item.tooltip = g.summary;
      item.command = {
        command: 'sightread.revealLocation',
        title: 'Reveal',
        arguments: [node.uri.toString(), g.startLine],
      };
      return item;
    }
    if (node.kind === 'step') {
      const s = node.step;
      const item = new vscode.TreeItem(
        `${node.index + 1}. ${s.role ? `[${s.role}] ` : ''}${s.note}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `step:${node.uri.toString()}:${s.id}`;
      const lines = `L${s.startLine + 1}–${s.endLine + 1}`;
      item.description = s.preview ? `${lines} · ${s.preview}` : lines;
      item.iconPath = circleIcon(guideRoleRgb(s.role));
      item.contextValue = 'step';
      item.tooltip = s.note;
      item.command = {
        command: 'sightread.revealLocation',
        title: 'Reveal',
        arguments: [node.uri.toString(), s.startLine],
      };
      return item;
    }
    const m = node.marker;
    const item = new vscode.TreeItem(
      m.note ?? m.preview ?? `L${m.startLine + 1}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `marker:${node.uri.toString()}:${m.id}`;
    const lines = `L${m.startLine + 1}–${m.endLine + 1}`;
    item.description = m.note && m.preview ? `${lines} · ${m.preview}` : lines;
    item.iconPath = circleIcon(PALETTE[m.color]);
    item.contextValue = 'marker';
    item.tooltip = m.note ? `${m.note}\n${m.preview ?? ''}` : m.preview;
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [node.uri.toString(), m.startLine],
    };
    return item;
  }

  /** Required by TreeView.reveal — items live under their file group. */
  getParent(node: MarkersNode): MarkersNode | undefined {
    if (node.kind === 'step') {
      return { kind: 'guide', uri: node.uri, guide: node.guide };
    }
    if (node.kind === 'marker' || node.kind === 'guide') {
      return { kind: 'file', uri: node.uri };
    }
    return undefined;
  }

  /** Follows the cursor: selects the item under it, without stealing focus. */
  async revealCursor(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    if (!this.view.visible) {
      return;
    }
    let target: MarkersNode | undefined;
    const marker = markersAtLine(this.repo.get(doc.uri), pos.line)[0];
    if (marker) {
      target = { kind: 'marker', uri: doc.uri, marker };
    } else {
      const hidden = this.compositor.getHiddenGuideRoles();
      for (const guide of this.guideRepo.get(doc.uri)) {
        const index = guide.steps.findIndex(
          (s) => pos.line >= s.startLine && pos.line <= s.endLine && stepVisible(s.role, hidden),
        );
        if (index !== -1) {
          target = { kind: 'step', uri: doc.uri, guide, step: guide.steps[index], index };
          break;
        }
      }
    }
    if (!target) {
      return;
    }
    try {
      await this.view.reveal(target, { select: true, focus: false });
    } catch (_e) {
      // best-effort: the repo may have changed mid-reveal
    }
  }

  getChildren(node?: MarkersNode): MarkersNode[] {
    if (!node) {
      const uris = [
        ...new Set([...this.repo.uris(), ...this.guideRepo.uris()]),
      ];
      const roots: FileNode[] = uris.map((u) => ({
        kind: 'file' as const,
        uri: vscode.Uri.parse(u),
      }));
      this.view.message = roots.length
        ? undefined
        : 'No markers yet — select lines and run "SightRead: Mark Selection", ' +
          'or run "SightRead: Interpret Current (AI)".';
      return roots;
    }
    if (node.kind === 'file') {
      const guides: MarkersNode[] = this.guideRepo
        .get(node.uri)
        .map((guide) => ({ kind: 'guide' as const, uri: node.uri, guide }));
      const markers: MarkersNode[] = this.repo
        .get(node.uri)
        .map((marker) => ({ kind: 'marker' as const, uri: node.uri, marker }));
      return [...guides, ...markers];
    }
    if (node.kind === 'guide') {
      // index stays the original reading-order position so numbering matches
      // the editor's step badges (which also skip hidden steps without renumbering)
      const hidden = this.compositor.getHiddenGuideRoles();
      return node.guide.steps
        .map((step, index) => ({
          kind: 'step' as const,
          uri: node.uri,
          guide: node.guide,
          step,
          index,
        }))
        .filter((n) => stepVisible(n.step.role, hidden));
    }
    return [];
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
