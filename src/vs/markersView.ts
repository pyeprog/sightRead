import * as vscode from 'vscode';
import { Marker } from '../core/markers';
import { Compositor } from './compositor';
import { MarkerRepository } from './highlighter';
import { circleIcon } from './palette';

export interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
}
export interface MarkerNode {
  kind: 'marker';
  uri: vscode.Uri;
  marker: Marker;
}
export type MarkersNode = FileNode | MarkerNode;

/** Sidebar list of every marker in the workspace, grouped by file. */
export class MarkersViewFeature
  implements vscode.TreeDataProvider<MarkersNode>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<MarkersNode>;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private repo: MarkerRepository,
    compositor: Compositor,
  ) {
    this.view = vscode.window.createTreeView('sightread.markersView', {
      treeDataProvider: this,
    });
    this.subscriptions.push(
      this.view,
      repo.onDidChange(() => this.emitter.fire()),
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
    );
  }

  getTreeItem(node: MarkersNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'file';
      item.description = String(this.repo.get(node.uri).length);
      return item;
    }
    const m = node.marker;
    const item = new vscode.TreeItem(
      m.note ?? m.preview ?? `L${m.startLine + 1}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const lines = `L${m.startLine + 1}–${m.endLine + 1}`;
    item.description = m.note && m.preview ? `${lines} · ${m.preview}` : lines;
    item.iconPath = circleIcon(m.color);
    item.contextValue = 'marker';
    item.tooltip = m.note ? `${m.note}\n${m.preview ?? ''}` : m.preview;
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [node.uri.toString(), m.startLine],
    };
    return item;
  }

  getChildren(node?: MarkersNode): MarkersNode[] {
    if (!node) {
      const roots: FileNode[] = this.repo
        .uris()
        .map((u) => ({ kind: 'file' as const, uri: vscode.Uri.parse(u) }));
      this.view.message = roots.length
        ? undefined
        : 'No markers yet — select lines and run "SightRead: Mark Selection".';
      return roots;
    }
    if (node.kind === 'file') {
      return this.repo.get(node.uri).map((marker) => ({ kind: 'marker', uri: node.uri, marker }));
    }
    return [];
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
