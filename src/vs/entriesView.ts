import * as vscode from 'vscode';
import { isModuleEntry } from '../core/entries';
import { EntriesFeature, EntrySymbol, KIND_ICONS, dirOf } from './entries';

/** module scans walk every sibling file — cap the walk, say so in the group row */
const MAX_MODULE_FILES = 40;
const MODULE_RESCAN_DEBOUNCE_MS = 1200;

export interface ModuleEntry {
  uriString: string;
  name: string;
  kind: vscode.SymbolKind;
  /** selectionRange start — reveal / peek target */
  line: number;
  character: number;
  outsideModuleRefs: number;
  /** barrel re-export (a name index.ts / __init__.py re-publishes) */
  reExported: boolean;
}

/** current-file entry / the module group header / one module-level entry */
export type EntriesNode =
  | { kind: 'symbol'; sym: EntrySymbol }
  | { kind: 'module' }
  | { kind: 'moduleEntry'; entry: ModuleEntry };

function basename(uriString: string): string {
  return uriString.split('/').pop() ?? uriString;
}

/**
 * Sidebar consumer of the entries engine, for the review question "where do
 * I enter this code?". Two tiers: the current file's entries flat at the
 * root (same ordering as the CodeLens), and a Module group last — symbols
 * anywhere in the file's directory that the outside world enters through
 * (isModuleEntry: referenced from outside the directory, or barrel
 * re-exported). The module tier is expensive — a per-file scan of every
 * sibling — so it only scans while its group is expanded, streams results
 * in file by file, and re-scans on saves in the directory (unchanged
 * siblings hit the version cache).
 */
export class EntriesViewFeature
  implements vscode.TreeDataProvider<EntriesNode>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<EntriesNode>;
  private subscriptions: vscode.Disposable[] = [];
  /** directory the cached module entries belong to */
  private moduleDir: string | undefined;
  private moduleEntries: ModuleEntry[] = [];
  private moduleScanning = false;
  /** a file in the scanned directory changed — re-scan on next expand/query */
  private moduleDirty = false;
  private moduleFileCount = 0;
  private moduleSkipped = 0;
  private scanDone: Promise<void> | undefined;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private feature: EntriesFeature) {
    this.view = vscode.window.createTreeView('sightread.entriesView', {
      treeDataProvider: this,
    });
    this.subscriptions.push(
      this.view,
      // current-file evidence streams in through the engine's own emitter
      feature.onDidChangeCodeLenses(() => this.emitter.fire()),
      vscode.window.onDidChangeActiveTextEditor(() => this.emitter.fire()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (dirOf(doc.uri.toString()) === this.moduleDir) {
          this.moduleDirty = true;
          this.fireRescanSoon();
        }
      }),
      vscode.commands.registerCommand('sightread.entriesRefresh', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          this.feature.ensureScan(editor.document, true);
        }
        this.moduleDirty = true;
        this.emitter.fire();
      }),
      vscode.commands.registerCommand('sightread.peekEntryItem', (node: EntriesNode) => {
        if (node?.kind === 'symbol') {
          const s = node.sym;
          return vscode.commands.executeCommand(
            'sightread.peekEntryReferences',
            s.scan.uriString,
            s.selectionRange.start.line,
            s.selectionRange.start.character,
          );
        }
        if (node?.kind === 'moduleEntry') {
          const e = node.entry;
          return vscode.commands.executeCommand(
            'sightread.peekEntryReferences',
            e.uriString,
            e.line,
            e.character,
          );
        }
        return undefined;
      }),
    );
  }

  /** test hook: resolves when the running module scan settles */
  get moduleScanDone(): Promise<void> | undefined {
    return this.scanDone;
  }

  getTreeItem(node: EntriesNode): vscode.TreeItem {
    if (node.kind === 'module') {
      const dir = this.currentDir();
      const item = new vscode.TreeItem(
        `Module · ${basename(dir ?? '')}/`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      // per-directory id: switching to another module resets expansion state
      item.id = `module:${dir}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'moduleGroup';
      item.tooltip = 'Symbols in this directory that the outside world enters through';
      if (this.moduleScanning) {
        item.description = 'scanning…';
      } else if (this.moduleDir === dir && this.moduleFileCount > 0) {
        item.description =
          this.moduleSkipped > 0
            ? `first ${this.moduleFileCount} of ${this.moduleFileCount + this.moduleSkipped} files`
            : `${this.moduleFileCount} files`;
      }
      return item;
    }
    if (node.kind === 'moduleEntry') {
      const e = node.entry;
      const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);
      item.id = `mod:${e.uriString}:${e.name}:${e.line}`;
      item.iconPath = new vscode.ThemeIcon(KIND_ICONS[e.kind] ?? 'symbol-misc');
      const refs = `${e.outsideModuleRefs} ref${e.outsideModuleRefs === 1 ? '' : 's'} outside module`;
      item.description = `${basename(e.uriString)} · ${e.reExported ? 're-exported' : refs}`;
      item.contextValue = 'entry';
      item.command = {
        command: 'sightread.revealLocation',
        title: 'Reveal',
        arguments: [e.uriString, e.line],
      };
      return item;
    }
    const s = node.sym;
    const verdict = this.feature.verdictOf(s);
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = `sym:${s.scan.uriString}:${s.name}:${s.selectionRange.start.line}`;
    item.iconPath = new vscode.ThemeIcon(KIND_ICONS[s.kind] ?? 'symbol-misc');
    const detail = this.feature.describe(s, verdict);
    item.description = verdict === 'suspected' ? `suspected — ${detail}` : detail;
    item.contextValue = 'entry';
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [s.scan.uriString, s.selectionRange.start.line],
    };
    return item;
  }

  getChildren(node?: EntriesNode): EntriesNode[] {
    if (!node) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return []; // the welcome contribution takes over
      }
      const scan = this.feature.ensureScan(editor.document);
      const roots: EntriesNode[] = this.feature
        .visibleSymbols(scan.symbols)
        .filter((s) => s.evidence)
        .map((s) => ({ kind: 'symbol' as const, sym: s }));
      if (this.currentDir() !== undefined) {
        roots.push({ kind: 'module' });
      }
      return roots;
    }
    if (node.kind === 'module') {
      // lazy: VS Code only asks for these children while the group is
      // expanded, so collapsed = no directory walk at all
      const dir = this.currentDir();
      if (dir !== undefined && (this.moduleDir !== dir || this.moduleDirty)) {
        this.startModuleScan(dir);
      }
      return this.moduleEntries.map((entry) => ({ kind: 'moduleEntry' as const, entry }));
    }
    return [];
  }

  /** directory of the active editor's file; undefined when there is no module (untitled) */
  private currentDir(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? dirOf(uri.toString()) : undefined;
  }

  /** saves in the scanned directory re-scan, debounced; unchanged files hit the cache */
  private fireRescanSoon(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.emitter.fire();
    }, MODULE_RESCAN_DEBOUNCE_MS);
  }

  private startModuleScan(dir: string): void {
    if (this.moduleScanning) {
      return; // the running scan re-checks dirty/dir when it finishes
    }
    this.moduleScanning = true;
    this.moduleDirty = false;
    this.moduleDir = dir;
    this.scanDone = this.runModuleScan(dir).finally(() => {
      this.moduleScanning = false;
      this.emitter.fire();
    });
  }

  private async runModuleScan(dir: string): Promise<void> {
    const files = await this.listModuleFiles(dir);
    const collected: ModuleEntry[] = [];
    this.moduleEntries = [];
    for (const uri of files) {
      if (this.moduleDir !== dir) {
        return; // the active editor moved to another directory mid-scan
      }
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch (_e) {
        continue; // binary or unreadable — not code
      }
      if (doc.languageId === 'plaintext') {
        continue; // no symbol provider will have anything to say
      }
      const scan = this.feature.ensureScan(doc);
      await scan.done;
      if (this.moduleDir !== dir) {
        return;
      }
      for (const s of scan.symbols) {
        if (!s.evidence) {
          continue;
        }
        if (
          isModuleEntry({ ...s.evidence, alias: s.alias, declaredPublic: s.declaredPublic })
        ) {
          collected.push({
            uriString: scan.uriString,
            name: s.name,
            kind: s.kind,
            line: s.selectionRange.start.line,
            character: s.selectionRange.start.character,
            outsideModuleRefs: s.evidence.outsideModuleRefs,
            reExported: s.alias === true,
          });
        }
      }
      // strongest ways in first; re-exports (no ref counts of their own) sink
      this.moduleEntries = collected
        .slice()
        .sort(
          (a, b) =>
            b.outsideModuleRefs - a.outsideModuleRefs ||
            a.uriString.localeCompare(b.uriString) ||
            a.line - b.line,
        );
      this.emitter.fire();
    }
  }

  private async listModuleFiles(dir: string): Promise<vscode.Uri[]> {
    let listing: [string, vscode.FileType][] = [];
    try {
      listing = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(dir));
    } catch (_e) {
      return [];
    }
    const files = listing
      .filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.'))
      .map(([name]) => name)
      .sort();
    this.moduleSkipped = Math.max(0, files.length - MAX_MODULE_FILES);
    const kept = files.slice(0, MAX_MODULE_FILES);
    this.moduleFileCount = kept.length;
    // joinPath re-encodes the raw directory-listing name; plain string
    // concatenation would break on spaces and friends
    return kept.map((name) => vscode.Uri.joinPath(vscode.Uri.parse(dir), name));
  }

  dispose(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
