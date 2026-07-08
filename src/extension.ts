import * as vscode from 'vscode';
import { Compositor } from './vs/compositor';
import {
  MarkerRepository,
  handleDocumentChange,
  registerHighlighterCommands,
} from './vs/highlighter';
import { MarkersViewFeature } from './vs/markersView';
import { SegmentCache } from './vs/segmentCache';
import { SegmentsViewFeature, registerGoToSegment } from './vs/segmentsView';
import { registerSkeletonFoldCommands } from './vs/skeletonFold';
import { SpotlightController } from './vs/spotlight';
import { computeTint } from './vs/variableTint';
import { findEnclosingFunction } from './vs/symbols';
import { SPOTLIGHT_LEVEL_NAMES } from './core/focus';

const REFRESH_DEBOUNCE_MS = 120;

export function activate(context: vscode.ExtensionContext): unknown {
  const repo = new MarkerRepository(context.workspaceState);
  const segmentCache = new SegmentCache();
  const compositor = new Compositor((uri) => repo.get(uri));
  const spotlight = new SpotlightController();
  const markersView = new MarkersViewFeature(repo, compositor);
  const segmentsView = new SegmentsViewFeature();
  context.subscriptions.push(compositor, markersView, segmentsView);
  const spotlightStatus = vscode.window.createStatusBarItem(
    'sightread.spotlight',
    vscode.StatusBarAlignment.Right,
    100,
  );
  spotlightStatus.name = 'SightRead Spotlight';
  spotlightStatus.command = 'sightread.spotlightCycle';
  spotlightStatus.tooltip = 'SightRead spotlight — click to cycle (Off → Seg+Var → Seg → Fn)';
  context.subscriptions.push(spotlightStatus);
  const syncSpotlightUi = (): void => {
    const level = spotlight.currentLevel;
    segmentsView.setSpotlightLevel(level);
    spotlightStatus.text = `$(${level === 0 ? 'eye-closed' : 'eye'}) ${SPOTLIGHT_LEVEL_NAMES[level]}`;
  };
  spotlightStatus.show();

  // ---- the single cursor pipeline (design.md §四) ----------------------------
  // selection change → enclosing function → tint → segments → focus → render.
  // A token invalidates in-flight runs when the cursor/document moves on.
  let pipelineToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(editor: vscode.TextEditor): Promise<void> {
    const token = ++pipelineToken;
    const doc = editor.document;
    const pos = editor.selection.active;

    const fn = await findEnclosingFunction(doc, pos);
    if (token !== pipelineToken) {
      return;
    }
    const tintEnabled = vscode.workspace
      .getConfiguration('sightread')
      .get('variableTint.enabled', true);
    const tint =
      tintEnabled && editor.selection.isEmpty ? await computeTint(doc, pos, fn) : [];
    if (token !== pipelineToken) {
      return;
    }
    const segments = fn ? segmentCache.get(doc, fn.range) : [];
    segmentsView.update(doc, fn, segments);
    const spot = spotlight.compute(
      fn,
      segments,
      pos.line,
      tint.map((t) => t.range.start.line),
    );
    compositor.setTransient(doc.uri, { tint, spotlight: spot });
    compositor.clearTransientExcept(doc.uri);
    compositor.renderVisible();
  }

  function scheduleRefresh(editor?: vscode.TextEditor): void {
    const target = editor ?? vscode.window.activeTextEditor;
    if (!target) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => void refresh(target), REFRESH_DEBOUNCE_MS);
  }

  // ---- commands --------------------------------------------------------------
  registerHighlighterCommands(context, repo, compositor);
  registerSkeletonFoldCommands(context, segmentCache, {
    afterFold: () => segmentsView.collapseAllTree(),
    afterUnfold: () => segmentsView.expandAll(),
  });
  registerGoToSegment(context, segmentCache);
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.spotlightCycle', () => {
      spotlight.cycle();
      syncSpotlightUi();
      scheduleRefresh();
    }),
    vscode.commands.registerCommand('sightread.spotlightOff', () => {
      spotlight.off();
      syncSpotlightUi();
      scheduleRefresh();
    }),
    vscode.commands.registerCommand('sightread.toggleVariableTint', async () => {
      const cfg = vscode.workspace.getConfiguration('sightread');
      const current = cfg.get('variableTint.enabled', true);
      await cfg.update('variableTint.enabled', !current, vscode.ConfigurationTarget.Global);
      scheduleRefresh();
    }),
    // internal: shared jump target for the sidebar views
    vscode.commands.registerCommand(
      'sightread.revealLocation',
      async (uriString: string, line: number) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      },
    ),
  );

  // ---- events ----------------------------------------------------------------
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleRefresh(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        compositor.render(editor);
        scheduleRefresh(editor);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        compositor.render(editor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      handleDocumentChange(e, repo, compositor);
      const active = vscode.window.activeTextEditor;
      if (active && active.document.uri.toString() === e.document.uri.toString()) {
        scheduleRefresh(active);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sightread')) {
        compositor.refreshDimTypes();
        compositor.renderVisible();
        scheduleRefresh();
      }
    }),
  );

  syncSpotlightUi();
  compositor.renderVisible();
  scheduleRefresh();

  // exposed for integration tests only
  return { _test: { repo, segmentCache, compositor, spotlight, markersView } };
}

export function deactivate(): void {}
