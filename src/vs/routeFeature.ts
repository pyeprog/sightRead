import * as path from 'path';
import * as vscode from 'vscode';
import { BUILTIN_HARNESSES } from '../core/harness';
import { stripParens } from '../core/jumpClassify';
import { RouteHop, parseRouteResponse } from '../core/routeParse';
import {
  RoutePromptOptions,
  TraceContext,
  buildRoutePrompt,
  buildTracePrompt,
} from '../core/routePrompt';
import { recordDuration, typicalMs } from '../core/runStats';
import { RouteHopInput, TrailNodeInput } from '../core/trail';
import { HarnessRunner, pickHarness } from './agentCli';
import { DURATIONS_KEY, showHarnessNotFound } from './guideFeature';
import { findEnclosingFunctions, findSymbolByName, resolveInterpretTarget } from './symbols';
import { TrailViewFeature, moduleNodeOf, trailKind, trailNodeKey } from './trailView';

/** exploration is many tool calls, not one shot — a wider bound than the guide's */
const ROUTE_TIMEOUT_MS = 300_000;
/** empirical prior for explore runs until the first one is recorded */
const ROUTE_TYPICAL_PRIOR_MS = 120_000;

/**
 * AI reading routes (design.md §3.7): a headless agent explores the repo
 * read-only and lays out a route — scenario A from a typed goal, scenario B
 * from the code under the cursor up to its entries. The result seeds the
 * Trail graph as planned nodes/edges via TrailViewFeature.applyRoute; this
 * class owns only the run itself, mirroring GuideFeature's flow.
 */
export class RouteFeature implements vscode.Disposable {
  private subscriptions: vscode.Disposable[] = [];
  /** silent run log: raw responses plus every dropped/re-rooted/fallback hop —
   *  the only way to tell a bad AI answer from a good one we mangled */
  private channel = vscode.window.createOutputChannel('SightRead');

  constructor(
    private trail: TrailViewFeature,
    /** globalState — typical durations belong to the machine's harness */
    private stats: vscode.Memento,
  ) {
    this.subscriptions.push(
      this.channel,
      vscode.commands.registerCommand('sightread.planRoute', () => this.planRoute()),
      vscode.commands.registerCommand('sightread.traceEntries', () => this.traceEntries()),
    );
  }

  /** Scenario A: a typed reading goal becomes a route from an entry down. */
  private async planRoute(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      return;
    }
    const runner = await this.pickExploreRunner();
    if (!runner) {
      return;
    }
    // the goal is the query itself — empty or Esc means nothing to plan
    const goal = await vscode.window.showInputBox({
      title: 'Plan Reading Route (AI)',
      prompt: `Prompt = built-in rules + promptTemplate.route setting + this goal. The ${runner.name} agent explores the repository read-only.`,
      placeHolder: 'e.g. how does a highlight survive edits?',
    });
    if (!goal?.trim()) {
      return;
    }
    const prompt = buildRoutePrompt(goal.trim(), this.promptOptions('route'));
    await this.runRoute(runner, root, prompt, 'route', goal.trim());
  }

  /** Scenario B: the code under the cursor, traced back to its entries. */
  private async traceEntries(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const root = this.workspaceRoot();
    if (!root) {
      return;
    }
    const runner = await this.pickExploreRunner();
    if (!runner) {
      return;
    }
    const doc = editor.document;
    const { at } = await findEnclosingFunctions(doc, editor.selection.active);
    const target = at
      ? { name: stripParens(at.name), range: at.range }
      : await resolveInterpretTarget(doc, editor.selection);
    const ctx: TraceContext = {
      filePath: vscode.workspace.asRelativePath(doc.uri),
      subjectName: target.name,
      startLine: target.range.start.line + 1,
      endLine: target.range.end.line + 1,
    };
    const prompt = buildTracePrompt(ctx, this.promptOptions('trace'));
    await this.runRoute(runner, root, prompt, 'trace', `entries → ${target.name}`);
  }

  private workspaceRoot(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage(
        'SightRead: open a folder first — route planning explores the workspace.',
      );
    }
    return root;
  }

  private promptOptions(unit: 'route' | 'trace'): RoutePromptOptions {
    const cfg = vscode.workspace.getConfiguration('sightread');
    return {
      template: cfg.get<string>(`guide.promptTemplate.${unit}`, '') || undefined,
      language: cfg.get<string>('guide.language', '') || undefined,
    };
  }

  /** pickHarness plus the explore gate — route planning needs read-only tools. */
  private async pickExploreRunner(): Promise<HarnessRunner | undefined> {
    const runner = await pickHarness();
    if (!runner) {
      void showHarnessNotFound(vscode.workspace.getConfiguration('sightread'));
      return undefined;
    }
    if (!runner.supportsExplore()) {
      const capable = Object.entries(BUILTIN_HARNESSES)
        .filter(([, p]) => p.exploreArgs !== undefined)
        .map(([name]) => name)
        .join(', ');
      void vscode.window.showErrorMessage(
        `SightRead: harness '${runner.name}' cannot explore the repository — route planning needs read-only tools. ` +
          `Supported: ${capable}, or a custom harness declaring "exploreArgs".`,
      );
      return undefined;
    }
    return runner;
  }

  /** Shared run: focus view → progress + stats → parse → resolve → seed. */
  private async runRoute(
    runner: HarnessRunner,
    root: vscode.Uri,
    prompt: string,
    statsUnit: 'route' | 'trace',
    label: string,
  ): Promise<void> {
    void vscode.commands.executeCommand('sightread.trailView.focus');
    const durations = this.stats.get<Record<string, number[]>>(DURATIONS_KEY, {});
    const statsKey = `${runner.name}/${statsUnit}`;
    const typicalS = Math.round(
      typicalMs(durations[statsKey] ?? [], ROUTE_TYPICAL_PRIOR_MS) / 1000,
    );
    const model =
      vscode.workspace.getConfiguration('sightread').get<string>('guide.model', '').trim() ||
      undefined;

    let raw: string;
    const startMs = Date.now();
    try {
      raw = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          // the title names the model so an unset setting is visible as such
          title: `SightRead: planning a route via ${runner.name}${model ? ` · ${model}` : ' (default model)'}`,
          cancellable: true,
        },
        (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const limitS = Math.round(ROUTE_TIMEOUT_MS / 1000);
          // constant text first, the growing counter last — a changing prefix
          // makes the notification re-wrap and the whole line jitter
          const prefix = `typically ~${typicalS}s · limit ${limitS}s · elapsed `;
          const ticker = setInterval(() => {
            const elapsedS = Math.round((Date.now() - startMs) / 1000);
            progress.report({ message: `${prefix}${elapsedS}s` });
          }, 1000);
          return runner
            .run({
              prompt,
              cwd: root.fsPath,
              timeoutMs: ROUTE_TIMEOUT_MS,
              signal: abort.signal,
              explore: true,
              model,
            })
            .finally(() => clearInterval(ticker));
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== 'cancelled') {
        void vscode.window.showErrorMessage(`SightRead: ${message}`);
      }
      return;
    }
    void this.stats.update(DURATIONS_KEY, {
      ...durations,
      [statsKey]: recordDuration(durations[statsKey] ?? [], Date.now() - startMs),
    });

    this.channel.appendLine(
      `\n[${new Date().toISOString()}] ${statsUnit} via ${runner.name}: ${label}`,
    );
    this.channel.appendLine('--- raw response ---');
    this.channel.appendLine(raw.trim());
    this.channel.appendLine('--- end raw response ---');

    const parsed = parseRouteResponse(raw);
    if (!parsed.ok) {
      this.channel.appendLine(`parse: no route — ${parsed.error}`);
      // covers the contract's no-route escape, where the error is the agent's summary
      void vscode.window.showWarningMessage(`SightRead: no route — ${parsed.error}`);
      return;
    }
    for (const d of parsed.route.dropped) {
      this.channel.appendLine(`parse: ${d}`);
    }
    const inputs = await this.resolveHops(parsed.route.hops, root);
    if (inputs.length === 0) {
      void vscode.window.showErrorMessage(
        'SightRead: no route hop could be located in this workspace.',
      );
      return;
    }
    await this.trail.applyRoute(inputs, label);
    if (parsed.route.summary) {
      void vscode.window.showInformationMessage(`SightRead: route planned — ${parsed.route.summary}`);
    }
  }

  /**
   * Resolves parsed hops to graph inputs. An unreadable or out-of-workspace
   * file drops the hop (hops that referenced it re-root); a symbol the
   * provider cannot find falls back to the AI's line hint.
   */
  private async resolveHops(hops: RouteHop[], root: vscode.Uri): Promise<RouteHopInput[]> {
    const nodes: (TrailNodeInput | undefined)[] = [];
    for (const hop of hops) {
      nodes.push(await this.hopNode(hop, root));
    }
    const surviving = new Map<number, number>();
    nodes.forEach((node, i) => {
      if (node) {
        surviving.set(i, surviving.size);
      }
    });
    const out: RouteHopInput[] = [];
    nodes.forEach((node, i) => {
      if (!node) {
        return;
      }
      const calledFrom =
        hops[i].calledFrom === undefined ? undefined : surviving.get(hops[i].calledFrom);
      out.push({
        node,
        calledFrom,
        callsiteLine: calledFrom === undefined ? undefined : hops[i].callsiteLine,
        note: hops[i].note,
        core: hops[i].core,
      });
    });
    return out;
  }

  private async hopNode(hop: RouteHop, root: vscode.Uri): Promise<TrailNodeInput | undefined> {
    if (path.isAbsolute(hop.file) || hop.file.split(/[\\/]/).includes('..')) {
      this.channel.appendLine(
        `resolve: hop "${hop.symbol}" dropped: path escapes the workspace (${hop.file})`,
      );
      return undefined; // the agent must stay inside the workspace
    }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, hop.file));
    } catch (_e) {
      this.channel.appendLine(
        `resolve: hop "${hop.symbol}" dropped: cannot open ${hop.file}`,
      );
      return undefined;
    }
    const uriString = doc.uri.toString();
    if (hop.kind === 'module') {
      return moduleNodeOf(uriString, doc.lineCount);
    }
    const found = await findSymbolByName(doc, hop.symbol, hop.containerName, hop.line);
    if (found) {
      return {
        key: trailNodeKey(uriString, found.name, found.containerName),
        name: stripParens(found.name),
        containerName: found.containerName ? stripParens(found.containerName) : undefined,
        kind: trailKind(found.kind),
        uriString,
        line: found.range.start.line,
        endLine: found.range.end.line,
      };
    }
    // fall back to the AI's line hint; the node lights up only if a real walk
    // produces the same key — otherwise it stays dim until Clear Routes
    this.channel.appendLine(
      `resolve: symbol "${hop.symbol}" not found in ${hop.file} — using the AI line hint`,
    );
    const line = Math.min(hop.line ?? 0, Math.max(0, doc.lineCount - 1));
    return {
      key: trailNodeKey(uriString, hop.symbol, hop.containerName),
      name: stripParens(hop.symbol),
      containerName: hop.containerName ? stripParens(hop.containerName) : undefined,
      kind: hop.kind,
      uriString,
      line,
      endLine: line,
    };
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
