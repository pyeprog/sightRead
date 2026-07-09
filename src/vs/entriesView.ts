import * as vscode from 'vscode';
import {
  EntryVerdict,
  classifyEntry,
  detectDeclaredPublic,
  isExportClauseLine,
  isImportLine,
  parseExportedNames,
} from '../core/entries';

const SCAN_DEBOUNCE_MS = 1200;
const FIRE_THROTTLE_MS = 80;
const MAX_CONCURRENT_REF_QUERIES = 6;
const MAX_CACHED_SCANS = 8;

const DEFAULT_ICON_COLOR = '#8C8C8C';
const SUSPECTED_ICON_OPACITY = 0.55;

/** double chevron » — "enter here"; suspected entries reuse it dimmed */
function chevronSvg(color: string, opacity: number): string {
  const chevron = (x1: number, x2: number): string =>
    `<path d="M${x1} 3.8 ${x2} 8l-4.2 4.2" fill="none" stroke="${color}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;
  const dim = opacity < 1 ? ` opacity="${opacity}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"${dim}>${chevron(3.5, 7.7)}${chevron(8.6, 12.8)}</svg>`;
}

/** any plain CSS color is fine; reject anything that could break out of the SVG attribute */
function sanitizeColor(color: string): string {
  return /^[-#a-zA-Z0-9(),.%\s]+$/.test(color.trim()) ? color.trim() : DEFAULT_ICON_COLOR;
}

/** container symbols whose function-like members are classified lazily on expand */
const CONTAINER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Object,
  vscode.SymbolKind.Enum,
]);

const MEMBER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
]);

const KIND_ICONS: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Module]: 'symbol-namespace',
  [vscode.SymbolKind.Namespace]: 'symbol-namespace',
  [vscode.SymbolKind.Package]: 'symbol-package',
  [vscode.SymbolKind.Class]: 'symbol-class',
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Property]: 'symbol-property',
  [vscode.SymbolKind.Field]: 'symbol-field',
  [vscode.SymbolKind.Constructor]: 'symbol-method',
  [vscode.SymbolKind.Enum]: 'symbol-enum',
  [vscode.SymbolKind.Interface]: 'symbol-interface',
  [vscode.SymbolKind.Function]: 'symbol-function',
  [vscode.SymbolKind.Variable]: 'symbol-variable',
  [vscode.SymbolKind.Constant]: 'symbol-constant',
  [vscode.SymbolKind.Struct]: 'symbol-structure',
  [vscode.SymbolKind.Event]: 'symbol-event',
  [vscode.SymbolKind.Object]: 'symbol-namespace',
};

export interface EntrySymbol {
  scan: Scan;
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
  declLine: string;
  declaredPublic?: boolean;
  /** an imported name — see EntryEvidence.alias */
  alias?: boolean;
  /** function-like children of a container symbol, classified on expand */
  members: EntrySymbol[];
  /** undefined while the reference query is pending */
  evidence?: { externalRefs: number; internalRefs: number };
  /** in-flight lazy classification of `members` */
  membersScan?: Promise<void>;
}

interface Scan {
  uriString: string;
  version: number;
  languageId: string;
  /** top-level symbols; populated once document symbols arrive */
  symbols: EntrySymbol[];
  /** resolves when every top-level symbol has evidence */
  done: Promise<void>;
  finished: boolean;
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  });
  await Promise.all(lanes);
}

function basename(uriString: string): string {
  const path = vscode.Uri.parse(uriString).path;
  return path.split('/').pop() ?? path;
}

/**
 * "Entry Points" sidebar: the file's top-level symbols classified by where
 * their references live (core/entries.ts). Scans are version-cached per
 * document and run only while the view is visible or gutter icons are on;
 * the symbol list renders immediately and verdicts stream in as the
 * reference queries complete.
 */
export class EntriesViewFeature
  implements vscode.TreeDataProvider<EntrySymbol>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<EntrySymbol | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<EntrySymbol>;
  private scans = new Map<string, Scan>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private fireTimer: ReturnType<typeof setTimeout> | undefined;
  private entryDeco: vscode.TextEditorDecorationType;
  private suspectedDeco: vscode.TextEditorDecorationType;
  private subscriptions: vscode.Disposable[] = [];

  constructor() {
    [this.entryDeco, this.suspectedDeco] = this.buildDecoTypes();
    this.view = vscode.window.createTreeView('sightread.entriesView', {
      treeDataProvider: this,
    });
    this.subscriptions.push(
      this.view,
      this.view.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.scheduleScan(0);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleScan(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const active = vscode.window.activeTextEditor;
        if (active && active.document.uri.toString() === e.document.uri.toString()) {
          this.scheduleScan(SCAN_DEBOUNCE_MS);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sightread.entries')) {
          this.rebuildDecoTypes();
          this.scheduleScan(0);
        }
      }),
    );
    this.scheduleScan(0);
  }

  private cfg<T>(key: string, dflt: T): T {
    return vscode.workspace.getConfiguration('sightread').get(`entries.${key}`, dflt);
  }

  private buildDecoTypes(): [vscode.TextEditorDecorationType, vscode.TextEditorDecorationType] {
    const color = sanitizeColor(this.cfg('iconColor', DEFAULT_ICON_COLOR));
    const make = (opacity: number): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(
          `data:image/svg+xml;base64,${Buffer.from(chevronSvg(color, opacity)).toString('base64')}`,
        ),
        gutterIconSize: 'contain',
      });
    return [make(1), make(SUSPECTED_ICON_OPACITY)];
  }

  /** disposing a decoration type clears it from every editor — safe to swap live */
  private rebuildDecoTypes(): void {
    this.entryDeco.dispose();
    this.suspectedDeco.dispose();
    [this.entryDeco, this.suspectedDeco] = this.buildDecoTypes();
    this.renderDecorations();
  }

  /** scanning is gated on someone actually consuming the result */
  private get watching(): boolean {
    return this.view.visible || this.cfg('gutterIcons', true);
  }

  private scheduleScan(delayMs: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const editor = vscode.window.activeTextEditor;
      if (editor && this.watching) {
        this.ensureScan(editor.document);
      }
      this.fireSoon();
    }, delayMs);
  }

  /** Returns the cached scan for the document's current version, starting one if needed. */
  ensureScan(doc: vscode.TextDocument, force = false): Scan {
    const key = doc.uri.toString();
    const existing = this.scans.get(key);
    if (!force && existing && existing.version === doc.version) {
      return existing;
    }
    const scan: Scan = {
      uriString: key,
      version: doc.version,
      languageId: doc.languageId,
      symbols: [],
      done: Promise.resolve(),
      finished: false,
    };
    scan.done = this.runScan(doc, scan);
    this.scans.set(key, scan);
    for (const cached of this.scans.keys()) {
      if (this.scans.size <= MAX_CACHED_SCANS) {
        break;
      }
      if (cached !== key) {
        this.scans.delete(cached);
      }
    }
    return scan;
  }

  private async runScan(doc: vscode.TextDocument, scan: Scan): Promise<void> {
    let roots: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
    try {
      roots = await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[]
      >('vscode.executeDocumentSymbolProvider', doc.uri);
    } catch (_e) {
      roots = undefined;
    }
    if (this.scans.get(scan.uriString) !== scan) {
      return; // superseded by a newer scan of this document
    }
    const exported = parseExportedNames(scan.languageId, doc.getText());
    const mapped = (roots ?? []).map((s) => this.toEntrySymbol(doc, scan, exported, s));
    // imported names: re-published ones are entries with no queries to run,
    // the rest are dropped outright (their references describe the original
    // symbol, and skipping them skips a workspace-wide reference query)
    for (const s of mapped) {
      if (s.alias && s.declaredPublic === true) {
        s.evidence = { externalRefs: 0, internalRefs: 0 };
      }
    }
    scan.symbols = mapped.filter((s) => !s.alias || s.declaredPublic === true);
    this.fireSoon();
    await runPool(scan.symbols.filter((s) => !s.evidence), MAX_CONCURRENT_REF_QUERIES, async (sym) => {
      if (this.scans.get(scan.uriString) !== scan) {
        return;
      }
      await this.collectEvidence(doc, scan, sym);
      this.fireSoon();
    });
    scan.finished = true;
    this.fireSoon();
  }

  private toEntrySymbol(
    doc: vscode.TextDocument,
    scan: Scan,
    exported: Set<string>,
    s: vscode.DocumentSymbol | vscode.SymbolInformation,
  ): EntrySymbol {
    const range = 'location' in s ? s.location.range : s.range;
    const selectionRange = 'selectionRange' in s ? s.selectionRange : range;
    const declLine = range.start.line < doc.lineCount ? doc.lineAt(range.start.line).text : '';
    const members =
      CONTAINER_KINDS.has(s.kind) && 'children' in s
        ? s.children
            .filter((c) => MEMBER_KINDS.has(c.kind))
            .map((c) => this.toEntrySymbol(doc, scan, exported, c))
        : [];
    return {
      scan,
      name: s.name,
      kind: s.kind,
      range,
      selectionRange,
      declLine,
      declaredPublic:
        detectDeclaredPublic(doc.languageId, declLine, s.name) ??
        (exported.has(s.name) ? true : undefined),
      alias: isImportLine(doc.languageId, declLine) || undefined,
      members,
    };
  }

  private async collectEvidence(
    doc: vscode.TextDocument,
    scan: Scan,
    sym: EntrySymbol,
  ): Promise<void> {
    let locs: vscode.Location[] = [];
    try {
      locs =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          doc.uri,
          sym.selectionRange.start,
        )) ?? [];
    } catch (_e) {
      // no provider / provider error — classify on zeros
    }
    let externalRefs = 0;
    let internalRefs = 0;
    for (const loc of locs) {
      if (loc.uri.toString() !== scan.uriString) {
        externalRefs++;
        continue;
      }
      if (sym.range.contains(loc.range.start)) {
        continue; // the declaration itself, or self-recursion
      }
      const lineText =
        loc.range.start.line < doc.lineCount ? doc.lineAt(loc.range.start.line).text : '';
      if (isExportClauseLine(scan.languageId, lineText)) {
        sym.declaredPublic = true; // `export { foo }` / `__all__` publishes, not calls
        continue;
      }
      internalRefs++;
    }
    sym.evidence = { externalRefs, internalRefs };
    await this.detectAlias(doc, scan, sym);
  }

  /**
   * Language-agnostic net behind isImportLine: a symbol about to be shown
   * whose definition resolves only outside this file is an import alias the
   * line regex missed (multi-line imports, other languages) — its reference
   * counts belong to the original symbol. One cheap definition query, spent
   * only on symbols that would actually surface.
   */
  private async detectAlias(
    doc: vscode.TextDocument,
    scan: Scan,
    sym: EntrySymbol,
  ): Promise<void> {
    if (!sym.evidence || classifyEntry({ ...sym.evidence, declaredPublic: sym.declaredPublic }) === 'hidden') {
      return;
    }
    let defs: (vscode.Location | vscode.LocationLink)[] = [];
    try {
      defs =
        (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeDefinitionProvider',
          doc.uri,
          sym.selectionRange.start,
        )) ?? [];
    } catch (_e) {
      return; // no provider — trust the evidence we have
    }
    if (
      defs.length > 0 &&
      !defs.some(
        (d) => ('targetUri' in d ? d.targetUri : d.uri).toString() === scan.uriString,
      )
    ) {
      sym.alias = true;
    }
  }

  private verdictOf(sym: EntrySymbol): EntryVerdict | undefined {
    if (!sym.evidence) {
      return undefined;
    }
    return classifyEntry({
      ...sym.evidence,
      alias: sym.alias,
      declaredPublic: this.cfg('languageHints', true) ? sym.declaredPublic : undefined,
    });
  }

  /** entries first, then still-pending, then suspected; hidden filtered out */
  private visibleSymbols(symbols: EntrySymbol[]): EntrySymbol[] {
    const showSuspected = this.cfg('showSuspected', true);
    const order = (v: EntryVerdict | undefined): number =>
      v === 'entry' ? 0 : v === undefined ? 1 : 2;
    return symbols
      .filter((s) => {
        const v = this.verdictOf(s);
        return v !== 'hidden' && (v !== 'suspected' || showSuspected);
      })
      .sort((a, b) => {
        const byVerdict = order(this.verdictOf(a)) - order(this.verdictOf(b));
        return byVerdict !== 0 ? byVerdict : a.range.start.line - b.range.start.line;
      });
  }

  getTreeItem(el: EntrySymbol): vscode.TreeItem {
    const verdict = this.verdictOf(el);
    const item = new vscode.TreeItem(
      el.name,
      el.members.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${el.scan.uriString}@${el.scan.version}:${el.range.start.line}.${el.range.start.character}:${el.name}`;
    item.iconPath = new vscode.ThemeIcon(
      KIND_ICONS[el.kind] ?? 'symbol-misc',
      verdict === 'suspected' ? new vscode.ThemeColor('disabledForeground') : undefined,
    );
    item.description = this.describe(el, verdict);
    item.tooltip = el.declLine.trim();
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [el.scan.uriString, el.selectionRange.start.line],
    };
    return item;
  }

  private describe(el: EntrySymbol, verdict: EntryVerdict | undefined): string {
    if (!el.evidence) {
      return '…';
    }
    if (verdict === 'suspected') {
      return 'no refs found';
    }
    if (el.alias) {
      return 're-exported';
    }
    const n = el.evidence.externalRefs;
    return n > 0 ? `${n} external ref${n === 1 ? '' : 's'}` : 'exported';
  }

  getChildren(el?: EntrySymbol): EntrySymbol[] | Promise<EntrySymbol[]> {
    if (el) {
      return this.memberChildren(el);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.view.message = 'Open a file to see its entry points.';
      this.view.description = undefined;
      return [];
    }
    this.view.description = basename(editor.document.uri.toString());
    const scan = this.watching
      ? this.ensureScan(editor.document)
      : this.scans.get(editor.document.uri.toString());
    if (!scan) {
      this.view.message = undefined;
      return [];
    }
    const visible = this.visibleSymbols(scan.symbols);
    this.view.message = !scan.finished
      ? undefined
      : scan.symbols.length === 0
        ? 'No symbols here — the language server may still be warming up.'
        : visible.length === 0
          ? 'No entry points — nothing in this file is referenced from outside.'
          : undefined;
    return visible;
  }

  private async memberChildren(el: EntrySymbol): Promise<EntrySymbol[]> {
    if (!el.membersScan) {
      el.membersScan = (async (): Promise<void> => {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(el.scan.uriString),
        );
        await runPool(
          el.members.filter((m) => !m.evidence),
          MAX_CONCURRENT_REF_QUERIES,
          (m) => this.collectEvidence(doc, el.scan, m),
        );
        this.fireSoon();
      })();
    }
    await el.membersScan;
    return this.visibleSymbols(el.members);
  }

  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.ensureScan(editor.document, true);
    }
    this.fireSoon();
  }

  async quickPick(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const scan = this.ensureScan(editor.document);
    type PickItem = vscode.QuickPickItem & { sym?: EntrySymbol };
    const qp = vscode.window.createQuickPick<PickItem>();
    qp.placeholder = `Entry points of ${basename(scan.uriString)}`;
    qp.matchOnDescription = true;
    qp.busy = !scan.finished;
    const toPick = (s: EntrySymbol): PickItem => ({
      label: `$(${KIND_ICONS[s.kind] ?? 'symbol-misc'}) ${s.name}`,
      description: this.describe(s, this.verdictOf(s)),
      sym: s,
    });
    const refill = (): void => {
      const visible = this.visibleSymbols(scan.symbols).filter((s) => s.evidence);
      const entries = visible.filter((s) => this.verdictOf(s) === 'entry');
      const suspected = visible.filter((s) => this.verdictOf(s) === 'suspected');
      const items: PickItem[] = entries.map(toPick);
      if (suspected.length > 0) {
        items.push(
          {
            label: 'Suspected (no references found)',
            kind: vscode.QuickPickItemKind.Separator,
          },
          ...suspected.map(toPick),
        );
      }
      qp.items = items;
    };
    const sub = this.emitter.event(refill);
    qp.onDidAccept(() => {
      const sym = qp.selectedItems[0]?.sym;
      qp.hide();
      if (sym) {
        void vscode.commands.executeCommand(
          'sightread.revealLocation',
          sym.scan.uriString,
          sym.selectionRange.start.line,
        );
      }
    });
    let hidden = false;
    qp.onDidHide(() => {
      hidden = true;
      sub.dispose();
      qp.dispose();
    });
    refill();
    qp.show();
    await scan.done;
    if (!hidden) {
      qp.busy = false;
      refill();
    }
  }

  private fireSoon(): void {
    if (this.fireTimer) {
      return;
    }
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      this.emitter.fire(undefined);
      this.renderDecorations();
    }, FIRE_THROTTLE_MS);
  }

  private renderDecorations(): void {
    const on = this.cfg('gutterIcons', true);
    const showSuspected = this.cfg('showSuspected', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const scan = this.scans.get(editor.document.uri.toString());
      if (!on || !scan) {
        editor.setDecorations(this.entryDeco, []);
        editor.setDecorations(this.suspectedDeco, []);
        continue;
      }
      const entries: vscode.Range[] = [];
      const suspected: vscode.Range[] = [];
      const collect = (syms: EntrySymbol[]): void => {
        for (const s of syms) {
          const v = this.verdictOf(s);
          const line = s.selectionRange.start.line;
          if (v === 'entry') {
            entries.push(new vscode.Range(line, 0, line, 0));
          } else if (v === 'suspected' && showSuspected) {
            suspected.push(new vscode.Range(line, 0, line, 0));
          }
          collect(s.members); // unclassified members have no verdict yet
        }
      };
      collect(scan.symbols);
      editor.setDecorations(this.entryDeco, entries);
      editor.setDecorations(this.suspectedDeco, suspected);
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.fireTimer) {
      clearTimeout(this.fireTimer);
    }
    this.entryDeco.dispose();
    this.suspectedDeco.dispose();
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}

export function registerEntryCommands(
  context: vscode.ExtensionContext,
  feature: EntriesViewFeature,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.refreshEntries', () => feature.refresh()),
    vscode.commands.registerCommand('sightread.goToEntry', () => feature.quickPick()),
  );
}
