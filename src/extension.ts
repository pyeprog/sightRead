import * as vscode from 'vscode';
import { Compositor } from './vs/compositor';
import {
  MarkerRepository,
  handleDocumentChange,
  registerHighlighterCommands,
} from './vs/highlighter';
import { EntriesViewFeature, registerEntryCommands } from './vs/entriesView';
import { MarkersViewFeature } from './vs/markersView';
import { SegmentCache } from './vs/segmentCache';
import {
  SegmentsViewFeature,
  registerGoToSegment,
  registerSegmentFoldCommands,
  registerSegmentMarkCommands,
} from './vs/segmentsView';
import { registerSkeletonFoldCommands } from './vs/skeletonFold';
import { SpotlightController } from './vs/spotlight';
import { TrailViewFeature, registerTrailCommands } from './vs/trailView';
import { computeTint } from './vs/variableTint';
import { findEnclosingFunctions } from './vs/symbols';
import { SPOTLIGHT_LEVEL_NAMES, SpotlightLevel } from './core/focus';

const REFRESH_DEBOUNCE_MS = 120;

/** One QuickPick row per spotlight level, in order of increasing focus. */
const SPOTLIGHT_PICK_ITEMS: { level: SpotlightLevel; label: string; description: string }[] = [
  { level: 0, label: 'Off', description: 'no dimming' },
  { level: 1, label: 'Function', description: 'current function stays lit' },
  { level: 2, label: 'Segment', description: 'only the cursor block stays lit' },
  {
    level: 3,
    label: 'Segment + Variables (recommended)',
    description: 'cursor block + related blocks stay lit',
  },
];

export function activate(context: vscode.ExtensionContext): unknown {
  const repo = new MarkerRepository(context.workspaceState);
  const segmentCache = new SegmentCache();
  const compositor = new Compositor((uri) => repo.get(uri));
  const spotlight = new SpotlightController();
  const markersView = new MarkersViewFeature(repo, compositor);
  const segmentsView = new SegmentsViewFeature(repo);
  const entriesView = new EntriesViewFeature();
  const trailView = new TrailViewFeature(repo);
  context.subscriptions.push(compositor, markersView, segmentsView, entriesView, trailView);
  const spotlightStatus = vscode.window.createStatusBarItem(
    'sightread.spotlight',
    vscode.StatusBarAlignment.Right,
    100,
  );
  spotlightStatus.name = 'SightRead Spotlight';
  spotlightStatus.command = 'sightread.spotlightSelect';
  spotlightStatus.tooltip = 'SightRead spotlight — click to choose a level';
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

    const { fn, outermost, at } = await findEnclosingFunctions(doc, pos);
    // the trail is fed even when this refresh is already superseded: the
    // state remains a valid observation of the position it was computed for,
    // and a superseded refresh is exactly what a jump's departure looks like
    const wordRange = doc.getWordRangeAtPosition(pos);
    trailView.onSettled({
      uriString: doc.uri.toString(),
      line: pos.line,
      character: pos.character,
      word: wordRange ? doc.getText(wordRange) : undefined,
      at,
      lineCount: doc.lineCount,
      atMs: Date.now(),
    });
    if (token !== pipelineToken) {
      return;
    }
    void entriesView.revealCursor(doc, pos);
    void markersView.revealCursor(doc, pos);
    const tintEnabled = vscode.workspace
      .getConfiguration('sightread')
      .get('variableTint.enabled', true);
    const tint =
      tintEnabled && editor.selection.isEmpty
        ? await computeTint(doc, pos, outermost ?? fn)
        : [];
    if (token !== pipelineToken) {
      return;
    }
    const segments = fn ? segmentCache.get(doc, fn.range) : [];
    // occurrences outside fn light their segment of the outermost function as islands
    const outerTree =
      fn && outermost && !outermost.range.isEqual(fn.range)
        ? segmentCache.get(doc, outermost.range)
        : [];
    const spot = spotlight.compute(
      fn,
      segments,
      pos.line,
      tint.map((t) => t.range.start.line),
      outerTree,
    );
    segmentsView.update(doc, fn, segments, pos.line, spot);
    void segmentsView.revealCursor();
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
  registerSegmentMarkCommands(context, repo, compositor);
  registerSegmentFoldCommands(context);
  registerEntryCommands(context, entriesView);
  registerTrailCommands(context, trailView);
  const setSpotlight = (level: SpotlightLevel): void => {
    spotlight.setLevel(level);
    syncSpotlightUi();
    scheduleRefresh();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('sightread.spotlightSelect', async () => {
      const picked = await vscode.window.showQuickPick(
        SPOTLIGHT_PICK_ITEMS.map((item) => ({
          ...item,
          description:
            item.level === spotlight.currentLevel
              ? `${item.description} — current`
              : item.description,
        })),
        { title: 'Spotlight Level', placeHolder: 'What stays lit — everything else is dimmed' },
      );
      if (picked) {
        setSpotlight(picked.level);
      }
    }),
    vscode.commands.registerCommand('sightread.spotlightOff', () => setSpotlight(0)),
    vscode.commands.registerCommand('sightread.spotlightFunction', () => setSpotlight(1)),
    vscode.commands.registerCommand('sightread.spotlightSegment', () => setSpotlight(2)),
    vscode.commands.registerCommand('sightread.spotlightSegmentVar', () => setSpotlight(3)),
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
  return {
    _test: {
      repo,
      segmentCache,
      compositor,
      spotlight,
      markersView,
      entriesView,
      segmentsView,
      trailView,
    },
  };
}

export function deactivate(): void {}
