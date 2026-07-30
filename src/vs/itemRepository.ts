import * as vscode from 'vscode';

let idCounter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}-${idCounter++}`;
}

/**
 * Per-file item store persisted in workspaceState — deliberately not in the
 * repo (design.md §一.2). Shared by markers and guides.
 */
export class ItemRepository<T> {
  private byUri: Record<string, T[]>;
  private emitter = new vscode.EventEmitter<void>();
  /** fires after any mutation — list views subscribe to this */
  readonly onDidChange = this.emitter.event;

  constructor(
    private memento: vscode.Memento,
    private storageKey: string,
    loadFilter?: (item: T) => boolean,
  ) {
    this.byUri = { ...memento.get<Record<string, T[]>>(storageKey, {}) };
    if (loadFilter) {
      // drop persisted entries of an outdated shape instead of migrating them
      for (const [uri, items] of Object.entries(this.byUri)) {
        const kept = items.filter(loadFilter);
        if (kept.length === 0) {
          delete this.byUri[uri];
        } else if (kept.length !== items.length) {
          this.byUri[uri] = kept;
        }
      }
    }
  }

  get(uri: vscode.Uri): T[] {
    return this.byUri[uri.toString()] ?? [];
  }

  uris(): string[] {
    return Object.keys(this.byUri);
  }

  set(uri: vscode.Uri, items: T[]): void {
    if (items.length > 0) {
      this.byUri[uri.toString()] = items;
    } else {
      delete this.byUri[uri.toString()];
    }
    void this.memento.update(this.storageKey, this.byUri);
    this.emitter.fire();
  }

  clearAll(): void {
    this.byUri = {};
    void this.memento.update(this.storageKey, this.byUri);
    this.emitter.fire();
  }
}
