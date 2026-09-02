import * as vscode from 'vscode';
import {
  EntryVerdict,
  classifyEntry,
  detectDeclaredPublic,
  isExportClauseLine,
  isImportLine,
  isMainGuardRef,
  parseExportedNames,
} from '../core/entries';

const SCAN_DEBOUNCE_MS = 1200;
const FIRE_THROTTLE_MS = 80;
const MAX_CONCURRENT_REF_QUERIES = 6;
// large enough to hold a whole directory of per-file scans (the entries
// view's module tier walks every sibling file); a scan is just symbol metadata
const MAX_CACHED_SCANS = 64;

/** documents the lens runs on — editors, not output panes or settings */
const LENS_SELECTOR: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];

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

/** the members worth classifying: callable ones, plus nested containers (expandable in turn) */
const MEMBER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
]);

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
  /** declaredPublic came from a `__main__` guard — described as "script entry" */
  scriptEntry?: boolean;
  /**
   * function-like children of a container symbol (CONTAINER_KINDS ×
   * MEMBER_KINDS); empty for leaves. Collected with the scan but classified
   * only on demand — see EntriesFeature.classifyMembers.
   */
  members: EntrySymbol[];
  /** memoized lazy classification of `members`; dies with the scan version */
  membersScan?: Promise<void>;
  /** undefined while the reference query is pending */
  evidence?: {
    externalRefs: number;
    wrappedRefs: number;
    scriptRefs: number;
    /** external refs from outside the file's directory (⊆ externalRefs) */
    outsideModuleRefs: number;
  };
}

interface Scan {
  uriString: string;
  version: number;
  languageId: string;
  /** top-level symbols; populated once document symbols arrive */
  symbols: EntrySymbol[];
  /** resolves when every symbol has evidence */
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

const NO_EXPORTED_NAMES: Set<string> = new Set();

/**
 * The symbols plus every member beneath them that has been classified
 * (depth-first) — the surface the CodeLens draws on. Members still pending
 * are left out; they have no verdict to show yet.
 */
function withClassifiedMembers(symbols: EntrySymbol[]): EntrySymbol[] {
  const out: EntrySymbol[] = [];
  const walk = (list: EntrySymbol[]): void => {
    for (const s of list) {
      out.push(s);
      walk(s.members.filter((m) => m.evidence));
    }
  };
  walk(symbols);
  return out;
}

/** parent of the last path segment — the module boundary the entries view groups by */
export function dirOf(uriString: string): string {
  const i = uriString.lastIndexOf('/');
  return i < 0 ? uriString : uriString.slice(0, i);
}

export const KIND_ICONS: Partial<Record<vscode.SymbolKind, string>> = {
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

/**
 * The entry-points engine: the file's top-level symbols classified by where
 * their references live (core/entries.ts). Three consumers: a CodeLens above
 * each entry declaration (`» entry — 3 external refs`, click peeks the
 * references), the `Go to Entry Point…` quick pick, and the Entry Points
 * sidebar view (entriesView.ts, which adds a module tier on top). Scans are
 * version-cached per document; results stream in as the reference queries
 * complete. A container's members are classified only when the view expands
 * it (classifyMembers) — from then on they carry lenses like any other
 * classified symbol; the quick pick stays top-level.
 */
export class EntriesFeature implements vscode.CodeLensProvider, vscode.Disposable {
  /** refires quick-pick refills and codelens refreshes as evidence streams in */
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private scans = new Map<string, Scan>();
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private fireTimer: ReturnType<typeof setTimeout> | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.languages.registerCodeLensProvider(LENS_SELECTOR, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sightread.entries')) {
          this.fireSoon();
        }
      }),
    );
  }

  private cfg<T>(key: string, dflt: T): T {
    return vscode.workspace.getConfiguration('sightread').get(`entries.${key}`, dflt);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.cfg('codeLens', true)) {
      return [];
    }
    const cached = this.scans.get(doc.uri.toString());
    if (!cached) {
      this.ensureScan(doc);
    } else if (cached.version !== doc.version) {
      // keep showing the stale lenses; rescan once the typing settles
      this.scheduleRescan(doc);
    }
    const scan = this.scans.get(doc.uri.toString());
    if (!scan) {
      return [];
    }
    return this.visibleSymbols(withClassifiedMembers(scan.symbols))
      .filter((s) => s.evidence)
      .map((s) => {
        const line = s.selectionRange.start.line;
        return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: this.lensTitle(s),
          command: 'sightread.peekEntryReferences',
          arguments: [scan.uriString, line, s.selectionRange.start.character],
        });
      });
  }

  private lensTitle(s: EntrySymbol): string {
    const verdict = this.verdictOf(s);
    return verdict === 'suspected'
      ? `» suspected entry — ${this.describe(s, verdict)}`
      : `» entry — ${this.describe(s, verdict)}`;
  }

  private scheduleRescan(doc: vscode.TextDocument): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.ensureScan(doc);
    }, SCAN_DEBOUNCE_MS);
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
        s.evidence = { externalRefs: 0, wrappedRefs: 0, scriptRefs: 0, outsideModuleRefs: 0 };
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
    // export clauses / __all__ name top-level symbols only — a member sharing
    // such a name is a coincidence, so members get an empty set
    const members =
      CONTAINER_KINDS.has(s.kind) && 'children' in s
        ? s.children
            .filter((c) => MEMBER_KINDS.has(c.kind))
            .map((c) => this.toEntrySymbol(doc, scan, NO_EXPORTED_NAMES, c))
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

  /**
   * Classifies a container's members on demand — one pooled reference query
   * each, the same rules as top-level symbols (a call from a sibling method
   * lands inside the container's range, so it counts as wrapped). Memoized
   * on the symbol, hence per scan version; a superseded scan stops early and
   * the view re-asks against the fresh one.
   */
  classifyMembers(sym: EntrySymbol): Promise<void> {
    if (!sym.membersScan) {
      sym.membersScan = (async (): Promise<void> => {
        const pending = sym.members.filter((m) => !m.evidence);
        if (pending.length === 0) {
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sym.scan.uriString));
        await runPool(pending, MAX_CONCURRENT_REF_QUERIES, async (m) => {
          if (this.scans.get(sym.scan.uriString) !== sym.scan) {
            return;
          }
          await this.collectEvidence(doc, sym.scan, m);
        });
        this.fireSoon();
      })();
    }
    return sym.membersScan;
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
    let wrappedRefs = 0;
    let scriptRefs = 0;
    let outsideModuleRefs = 0;
    const moduleDir = dirOf(scan.uriString);
    for (const loc of locs) {
      if (loc.uri.toString() !== scan.uriString) {
        externalRefs++;
        if (dirOf(loc.uri.toString()) !== moduleDir) {
          outsideModuleRefs++;
        }
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
      if (
        scan.symbols.some((other) => other !== sym && other.range.contains(loc.range.start))
      ) {
        wrappedRefs++; // a more abstract same-file symbol wraps this one
        continue;
      }
      // module top-level code — the caller is the script itself, not a
      // symbol the reader could start from instead (relies on the symbol
      // provider reporting full body ranges, as the own-range check does)
      if (isMainGuardRef(scan.languageId, (i) => doc.lineAt(i).text, loc.range.start.line)) {
        sym.declaredPublic = true; // the `__main__` guard publishes the script entry
        sym.scriptEntry = true;
        continue;
      }
      scriptRefs++;
    }
    sym.evidence = { externalRefs, wrappedRefs, scriptRefs, outsideModuleRefs };
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

  verdictOf(sym: EntrySymbol): EntryVerdict | undefined {
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
  visibleSymbols(symbols: EntrySymbol[]): EntrySymbol[] {
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

  describe(el: EntrySymbol, verdict: EntryVerdict | undefined): string {
    if (!el.evidence) {
      return '…';
    }
    if (verdict === 'suspected') {
      return el.evidence.scriptRefs > 0 ? 'called at top level' : 'no refs found';
    }
    if (el.alias) {
      return 're-exported';
    }
    const n = el.evidence.externalRefs;
    if (n > 0) {
      return `${n} external ref${n === 1 ? '' : 's'}`;
    }
    return el.scriptEntry ? 'script entry' : 'exported';
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
      this.emitter.fire();
    }, FIRE_THROTTLE_MS);
  }

  dispose(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }
    if (this.fireTimer) {
      clearTimeout(this.fireTimer);
    }
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}

export function registerEntryCommands(
  context: vscode.ExtensionContext,
  feature: EntriesFeature,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.goToEntry', () => feature.quickPick()),
    // the lens's click action: peek the references that made it an entry
    vscode.commands.registerCommand(
      'sightread.peekEntryReferences',
      async (uriString: string, line: number, character: number) => {
        const uri = vscode.Uri.parse(uriString);
        const pos = new vscode.Position(line, character);
        const locs =
          (await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            uri,
            pos,
          )) ?? [];
        await vscode.commands.executeCommand('editor.action.showReferences', uri, pos, locs);
      },
    ),
  );
}
