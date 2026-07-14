import * as vscode from 'vscode';
import {
  RawCursorState,
  SettledState,
  classifyJump,
  pickDeparture,
  stripParens,
} from '../core/jumpClassify';
import { markersInLineRange } from '../core/markers';
import { TrailGraph, TrailNodeInput, TrailNodeKind } from '../core/trail';
import { MarkerRepository } from './highlighter';
import { markerThemeColor } from './palette';
import { SymbolAtCursor, findEnclosingFunctions } from './symbols';

const FIRE_THROTTLE_MS = 80;
/** safety cap; precision-first recording never gets near it in normal reading */
const MAX_NODES = 300;
/** settles buffered while the view is hidden, replayed when it opens */
const PENDING_MAX = 12;
const REPLAY_WINDOW_MS = 3 * 60_000;
/** grace for the landing file's language server right after a cross-file jump */
const LANDING_SYMBOL_RETRY_MS = 600;
/** raw (undebounced) cursor trace — where fast-gesture departure points survive */
const RAW_MAX = 16;
const RAW_WINDOW_MS = 3000;

/** selection events from these editors are not code navigation */
const IGNORED_URI_SCHEMES = new Set([
  'output',
  'debug',
  'search-editor',
  'vscode-settings',
  'comment',
]);

const KIND_ICONS: Record<TrailNodeKind, string> = {
  function: 'symbol-function',
  method: 'symbol-method',
  class: 'symbol-class',
  module: 'symbol-file',
};

/** A settled cursor state, fed by the extension's cursor pipeline. */
export interface TrailSettled {
  uriString: string;
  line: number;
  character: number;
  word?: string;
  at?: SymbolAtCursor;
  lineCount: number;
  atMs: number;
}

/**
 * One occurrence of a graph node in the tree projection. The same function
 * appears once per discovered caller path; occurrences share the underlying
 * node and expand to the same children.
 */
export interface TrailElement {
  key: string;
  /** ancestor keys from the root down, this element excluded */
  path: string[];
  /** repeats inside its own ancestor chain — rendered as a ↻ leaf */
  recursive: boolean;
  /** earliest known call-site line in the parent (absent on roots) */
  callsiteLine?: number;
}

function trailKind(kind: vscode.SymbolKind): TrailNodeKind {
  switch (kind) {
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return 'method';
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Struct:
      return 'class';
    default:
      return 'function';
  }
}

function basename(uriString: string): string {
  const path = vscode.Uri.parse(uriString).path;
  return path.split('/').pop() ?? path;
}

/** Graph node for a settled state: its enclosing symbol, or the module itself. */
function nodeOf(s: TrailSettled): TrailNodeInput {
  if (s.at) {
    const name = stripParens(s.at.name);
    return {
      key: `${s.uriString}#${s.at.containerName ?? ''}#${name}`,
      name,
      containerName: s.at.containerName ? stripParens(s.at.containerName) : undefined,
      kind: trailKind(s.at.kind),
      uriString: s.uriString,
      line: s.at.range.start.line,
      endLine: s.at.range.end.line,
    };
  }
  return {
    key: `${s.uriString}#<module>`,
    name: basename(s.uriString),
    kind: 'module',
    uriString: s.uriString,
    line: 0,
    endLine: Math.max(0, s.lineCount - 1),
  };
}

function toCore(s: TrailSettled): SettledState {
  return {
    uriString: s.uriString,
    line: s.line,
    word: s.word,
    at: s.at
      ? {
          name: s.at.name,
          startLine: s.at.range.start.line,
          endLine: s.at.range.end.line,
          onName: s.at.onName,
        }
      : undefined,
  };
}

/** Carries the node's definition range so markers can tint the label. */
function trailUri(node: TrailNodeInput): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'sightread-trail',
    path: `/${node.line}-${node.endLine}`,
    query: node.uriString,
  });
}

/**
 * "Trail" sidebar: the partial call graph discovered by reading (design.md
 * §3.7). Structural jumps — drill into a definition, jump to a reference —
 * become parent-calls-child edges; everything else is ignored, and every
 * candidate is verified against the definition provider before it is
 * recorded. Recording is gated on the view being visible; a small ring of
 * settles is kept while it is hidden and replayed when it opens, so the last
 * few jumps before opening the view still materialize.
 */
export class TrailViewFeature
  implements
    vscode.TreeDataProvider<TrailElement>,
    vscode.FileDecorationProvider,
    vscode.Disposable
{
  readonly graph = new TrailGraph();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private decoEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  private view: vscode.TreeView<TrailElement>;
  private prev: TrailSettled | undefined;
  private pending: TrailSettled[] = [];
  private rawHistory: RawCursorState[] = [];
  private paused = false;
  /** bumped by clear() — invalidates in-flight verifications */
  private generation = 0;
  private fireTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingReveal: string | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(private repo: MarkerRepository) {
    this.view = vscode.window.createTreeView('sightread.trailView', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.subscriptions.push(
      this.view,
      this.view.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.replayPending();
        }
      }),
      vscode.window.registerFileDecorationProvider(this),
      this.repo.onDidChange(() => this.decoEmitter.fire(undefined)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onRawSelection(e)),
    );
    void vscode.commands.executeCommand('setContext', 'sightread.trailPaused', false);
  }

  /**
   * Raw cursor trace, ahead of the pipeline's debounce. A fast jump gesture
   * (Cmd+click, click-then-F12 inside the debounce window) never lets its
   * departure point settle — this synchronous, query-free trace is the only
   * place the departure survives. Kept tiny; consumed by tryRawDrillIn.
   */
  private onRawSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document;
    if (IGNORED_URI_SCHEMES.has(doc.uri.scheme)) {
      return;
    }
    const pos = e.selections[0]?.active ?? e.textEditor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(pos);
    const state: RawCursorState = {
      uriString: doc.uri.toString(),
      line: pos.line,
      character: pos.character,
      word: wordRange ? doc.getText(wordRange) : undefined,
      ms: Date.now(),
    };
    const last = this.rawHistory[this.rawHistory.length - 1];
    if (last && last.uriString === state.uriString && last.line === state.line) {
      this.rawHistory[this.rawHistory.length - 1] = state; // same line — keep the freshest word
      return;
    }
    this.rawHistory.push(state);
    if (this.rawHistory.length > RAW_MAX) {
      this.rawHistory.shift();
    }
  }

  onSettled(s: TrailSettled): void {
    if (this.paused) {
      this.prev = s;
      this.pending = [];
      return;
    }
    if (!this.view.visible) {
      this.pending.push(s);
      if (this.pending.length > PENDING_MAX) {
        this.pending.shift();
      }
      return;
    }
    const prev = this.prev;
    this.prev = s;
    void this.process(prev, s);
  }

  /** Replays the hidden-period ring so the jumps just made appear on open. */
  private replayPending(): void {
    const cutoff = Date.now() - REPLAY_WINDOW_MS;
    const recent = this.pending.filter((p) => p.atMs >= cutoff);
    this.pending = [];
    void (async (): Promise<void> => {
      for (const s of recent) {
        const prev = this.prev;
        this.prev = s;
        await this.process(prev, s);
      }
    })();
  }

  private async process(prev: TrailSettled | undefined, curr: TrailSettled): Promise<void> {
    const gen = this.generation;
    // arriving inside a known node keeps the view following the reader
    const here = this.graph.nodeAt(curr.uriString, curr.line);
    if (here) {
      this.graph.touch(here.key);
      void this.revealNode(here.key);
    }
    if (!prev) {
      await this.tryRawDrillIn(curr, gen);
      return;
    }
    // the landing file's symbols may not be indexed yet right after a
    // cross-file jump — give the language server one short grace period
    if (!curr.at && prev.uriString !== curr.uriString) {
      await new Promise((resolve) => setTimeout(resolve, LANDING_SYMBOL_RETRY_MS));
      if (gen !== this.generation) {
        return;
      }
      curr = { ...curr, at: await this.resolveAt(curr) };
    }
    const candidate = classifyJump(toCore(prev), toCore(curr));
    if (!candidate) {
      // the settled pair sees nothing when the departure never settled
      // (fast gestures) — fall back to the raw cursor trace
      await this.tryRawDrillIn(curr, gen);
      return;
    }
    const [query, target] = candidate.type === 'drill-in' ? [prev, curr] : [curr, prev];
    if (!(await this.verifyDefinition(query, target)) || gen !== this.generation) {
      return;
    }
    const [caller, callee] = candidate.caller === 'prev' ? [prev, curr] : [curr, prev];
    this.recordVerifiedEdge(nodeOf(caller), nodeOf(callee), candidate.callsiteLine, curr);
  }

  /**
   * Drill-in with a transient departure: the last raw state on another line
   * mentions the landed symbol's name → that state's scope calls it. Same
   * definition-provider verification as the settled path; the departure's
   * enclosing symbol is resolved retroactively (its document is still open —
   * the jump just left it), and only after the cheap checks pass.
   */
  private async tryRawDrillIn(curr: TrailSettled, gen: number): Promise<void> {
    if (!curr.at?.onName) {
      return;
    }
    const name = stripParens(curr.at.name);
    const raw = pickDeparture(
      this.rawHistory,
      { uriString: curr.uriString, line: curr.line, ms: curr.atMs },
      RAW_WINDOW_MS,
    );
    if (!raw || raw.word !== name) {
      return;
    }
    if (!(await this.verifyDefinition(raw, curr)) || gen !== this.generation) {
      return;
    }
    const depDoc = await this.docFor(raw.uriString);
    if (!depDoc || gen !== this.generation) {
      return;
    }
    const at = (
      await findEnclosingFunctions(depDoc, new vscode.Position(raw.line, raw.character))
    ).at;
    if (gen !== this.generation) {
      return;
    }
    const caller: TrailSettled = {
      uriString: raw.uriString,
      line: raw.line,
      character: raw.character,
      word: raw.word,
      at,
      lineCount: depDoc.lineCount,
      atMs: raw.ms,
    };
    this.recordVerifiedEdge(nodeOf(caller), nodeOf(curr), raw.line, curr);
  }

  private recordVerifiedEdge(
    caller: TrailNodeInput,
    callee: TrailNodeInput,
    callsiteLine: number,
    curr: TrailSettled,
  ): void {
    this.graph.recordEdge(caller, callee, callsiteLine);
    this.graph.evict(MAX_NODES);
    const landed = this.graph.nodeAt(curr.uriString, curr.line);
    this.fireSoon(landed?.key);
  }

  private async docFor(uriString: string): Promise<vscode.TextDocument | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString);
    if (open) {
      return open;
    }
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
    } catch (_e) {
      return undefined;
    }
  }

  private async resolveAt(s: TrailSettled): Promise<SymbolAtCursor | undefined> {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === s.uriString,
    );
    if (!doc) {
      return undefined;
    }
    return (await findEnclosingFunctions(doc, new vscode.Position(s.line, s.character))).at;
  }

  /**
   * One definition query settles what string heuristics cannot: for a
   * drill-in the word at the departure point must define at the landed
   * symbol; for a ref-jump the word at the landing point must define at the
   * symbol just read. The jump itself warmed the provider, so this is cheap.
   */
  private async verifyDefinition(
    query: { uriString: string; line: number; character: number },
    target: { uriString: string; at?: SymbolAtCursor },
  ): Promise<boolean> {
    const t = target.at;
    if (!t) {
      return false;
    }
    try {
      const defs =
        (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeDefinitionProvider',
          vscode.Uri.parse(query.uriString),
          new vscode.Position(query.line, query.character),
        )) ?? [];
      return defs.some((d) => {
        const uri = 'targetUri' in d ? d.targetUri : d.uri;
        const range =
          'targetSelectionRange' in d && d.targetSelectionRange
            ? d.targetSelectionRange
            : 'targetRange' in d
              ? d.targetRange
              : d.range;
        return (
          uri.toString() === target.uriString &&
          range.start.line >= t.range.start.line &&
          range.start.line <= t.range.end.line
        );
      });
    } catch (_e) {
      return false; // no provider — precision first, drop the candidate
    }
  }

  /** Selects the node's first occurrence in the projection, without focus. */
  private async revealNode(key: string): Promise<void> {
    if (!this.view.visible) {
      return;
    }
    const path = this.pathTo(key);
    if (!path) {
      return;
    }
    try {
      await this.view.reveal({ key, path, recursive: false }, { select: true, focus: false });
    } catch (_e) {
      // best-effort: the tree may have refreshed mid-reveal
    }
  }

  private pathTo(key: string): string[] | undefined {
    const dfs = (k: string, path: string[]): string[] | undefined => {
      if (k === key) {
        return path;
      }
      if (path.includes(k)) {
        return undefined; // recursion leaf — the projection cuts here
      }
      for (const child of this.graph.children(k)) {
        const hit = dfs(child.node.key, [...path, k]);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    };
    for (const root of this.graph.roots()) {
      const hit = dfs(root.key, []);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.view.description = paused ? 'paused' : undefined;
    void vscode.commands.executeCommand('setContext', 'sightread.trailPaused', paused);
    if (paused) {
      this.pending = [];
    }
  }

  clear(): void {
    this.generation++;
    this.graph.clear();
    this.pendingReveal = undefined;
    this.fireSoon();
  }

  /** Explicit recall fallback: seed the current function (or module) as a root. */
  async pinCurrent(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const pos = editor.selection.active;
    const { at } = await findEnclosingFunctions(editor.document, pos);
    const node = nodeOf({
      uriString: editor.document.uri.toString(),
      line: pos.line,
      character: pos.character,
      at,
      lineCount: editor.document.lineCount,
      atMs: Date.now(),
    });
    this.graph.upsert(node, true);
    this.fireSoon(node.key);
    void vscode.commands.executeCommand('sightread.trailView.focus');
  }

  removeElement(el?: TrailElement): void {
    if (!el) {
      return;
    }
    this.graph.remove(el.key);
    this.fireSoon();
  }

  getTreeItem(el: TrailElement): vscode.TreeItem {
    const node = this.graph.node(el.key);
    if (!node) {
      return new vscode.TreeItem('…'); // stale element during a refresh
    }
    const hasChildren = !el.recursive && this.graph.children(el.key).length > 0;
    // ownership is primary reading information — it lives on the label
    // (and joins type-to-filter); the file is click-reachable, tooltip only
    const item = new vscode.TreeItem(
      node.containerName ? `${node.containerName}.${node.name}` : node.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = [...el.path, el.key].join('→');
    item.contextValue = 'trailNode';
    item.iconPath = new vscode.ThemeIcon(KIND_ICONS[node.kind]);
    const callers = this.graph.inDegree(el.key);
    const parts: string[] = [];
    if (el.recursive) {
      parts.push('↻');
    }
    if (callers >= 2) {
      parts.push(`↗ ${callers} callers`);
    }
    item.description = parts.join(' · ');
    item.resourceUri = trailUri(node); // markers tint the label (importance is human judgment)
    const rel = vscode.workspace.asRelativePath(vscode.Uri.parse(node.uriString), false);
    item.tooltip =
      `${rel}:${node.line + 1}` +
      (el.callsiteLine !== undefined ? `\ncalled at line ${el.callsiteLine + 1}` : '') +
      (el.recursive ? '\nrecursive — already on this path' : '');
    item.command = {
      command: 'sightread.revealLocation',
      title: 'Reveal',
      arguments: [node.uriString, node.line],
    };
    return item;
  }

  getChildren(el?: TrailElement): TrailElement[] {
    if (!el) {
      return this.graph.roots().map((n) => ({ key: n.key, path: [], recursive: false }));
    }
    if (el.recursive) {
      return [];
    }
    const path = [...el.path, el.key];
    return this.graph.children(el.key).map((c) => ({
      key: c.node.key,
      path,
      recursive: path.includes(c.node.key),
      callsiteLine: c.callsiteLine,
    }));
  }

  /** Required by TreeView.reveal. */
  getParent(el: TrailElement): TrailElement | undefined {
    if (el.path.length === 0) {
      return undefined;
    }
    return {
      key: el.path[el.path.length - 1],
      path: el.path.slice(0, -1),
      recursive: false,
    };
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'sightread-trail') {
      return undefined;
    }
    const range = /^\/(\d+)-(\d+)$/.exec(uri.path);
    const marker = range
      ? markersInLineRange(
          this.repo.get(vscode.Uri.parse(uri.query)),
          Number(range[1]),
          Number(range[2]),
        )[0]
      : undefined;
    return marker ? { color: markerThemeColor(marker.color) } : undefined;
  }

  private fireSoon(revealKey?: string): void {
    if (revealKey) {
      this.pendingReveal = revealKey;
    }
    if (this.fireTimer) {
      return;
    }
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      this.emitter.fire();
      this.decoEmitter.fire(undefined);
      const key = this.pendingReveal;
      this.pendingReveal = undefined;
      if (key) {
        void this.revealNode(key);
      }
    }, FIRE_THROTTLE_MS);
  }

  dispose(): void {
    if (this.fireTimer) {
      clearTimeout(this.fireTimer);
    }
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}

export function registerTrailCommands(
  context: vscode.ExtensionContext,
  trail: TrailViewFeature,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.trailPin', () => trail.pinCurrent()),
    vscode.commands.registerCommand('sightread.trailClear', () => trail.clear()),
    vscode.commands.registerCommand('sightread.trailPause', () => trail.setPaused(true)),
    vscode.commands.registerCommand('sightread.trailResume', () => trail.setPaused(false)),
    vscode.commands.registerCommand('sightread.trailRemove', (el?: TrailElement) =>
      trail.removeElement(el),
    ),
  );
}
