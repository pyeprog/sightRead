import * as path from 'path';
import * as vscode from 'vscode';
import {
  Guide,
  InterpretUnit,
  applyChangesToGuides,
  roleKey,
} from '../core/guide';
import { parseGuideResponse } from '../core/guideParse';
import { SubjectContext, buildGuidePrompt } from '../core/guidePrompt';
import { BUILTIN_HARNESSES, HarnessProfile, resolveHarness } from '../core/harness';
import { EditChange } from '../core/markers';
import { autoDetectionOrder, pickHarness } from './agentCli';
import { Compositor } from './compositor';
import { linePreview } from './highlighter';
import { ItemRepository, newId } from './itemRepository';
import { circleIcon, guideRoleRank, guideRoleRgb } from './palette';
import type { GuideNode } from './markersView';
import { InterpretTarget, resolveInterpretTarget } from './symbols';

const RUN_TIMEOUT_MS = 180_000;
/** argv-size / token-cost guards for the one-shot prompt */
const MAX_UNIT_LINES: Record<InterpretUnit, number> = { function: 1200, class: 1200, file: 2000 };
const MAX_HEADER_LINES = 40;

function isStoredGuide(g: Guide): boolean {
  return (
    typeof g.subject === 'string' &&
    (g.unit === 'function' || g.unit === 'class' || g.unit === 'file') &&
    Array.isArray(g.steps)
  );
}

export class GuideRepository extends ItemRepository<Guide> {
  constructor(memento: vscode.Memento) {
    super(memento, 'sightread.guides', isStoredGuide);
  }
}

/** The one-shot request's raw material, gathered without any agent help. */
export async function collectSubjectContext(
  doc: vscode.TextDocument,
  target: InterpretTarget,
): Promise<SubjectContext> {
  const start = target.range.start.line;
  const end = target.range.end.line;
  const numbered: string[] = [];
  for (let line = start; line <= end; line++) {
    numbered.push(`${line + 1}\t${doc.lineAt(line).text}`);
  }
  const fileHeader =
    target.unit === 'file' || start === 0
      ? ''
      : doc.getText(new vscode.Range(0, 0, Math.min(start, MAX_HEADER_LINES), 0));
  return {
    filePath: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    unit: target.unit,
    subjectName: target.name,
    subjectText: numbered.join('\n'),
    fileHeader,
  };
}

/**
 * A readable, actionable message for each way the harness can be missing:
 * auto probed everything and found nothing; a named harness whose command is
 * not on PATH; a name that is neither builtin nor a customHarnesses key.
 */
async function showHarnessNotFound(cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const name = cfg.get<string>('guide.harness', 'auto');
  const custom = cfg.get<Record<string, HarnessProfile>>('guide.customHarnesses', {});
  let message: string;
  if (name === 'auto') {
    message =
      `SightRead: no coding-agent CLI found on PATH — probed ${autoDetectionOrder().join(', ')}. ` +
      'Install one (e.g. Claude Code) and sign in, or launch VS Code from a terminal so it inherits your shell PATH.';
  } else {
    const resolved = resolveHarness(name, custom);
    message = resolved
      ? `SightRead: harness '${name}' needs '${resolved.profile.command}' on PATH — install it, or launch VS Code from a terminal so it inherits your shell PATH.`
      : `SightRead: '${name}' is not a harness — neither a builtin (${Object.keys(BUILTIN_HARNESSES).join(', ')}) nor a key in sightread.guide.customHarnesses.`;
  }
  const pick = await vscode.window.showErrorMessage(message, 'Open Settings');
  if (pick === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'sightread.guide');
  }
}

/** Mirrors highlighter.handleDocumentChange for the guide layer. */
export function handleGuideDocumentChange(
  e: vscode.TextDocumentChangeEvent,
  repo: GuideRepository,
  compositor: Compositor,
): void {
  if (e.contentChanges.length === 0) {
    return;
  }
  const before = repo.get(e.document.uri);
  if (before.length === 0) {
    return;
  }
  const changes: EditChange[] = e.contentChanges.map((ch) => ({
    startLine: ch.range.start.line,
    startChar: ch.range.start.character,
    endLine: ch.range.end.line,
    endChar: ch.range.end.character,
    insertedNewlines: (ch.text.match(/\n/g) ?? []).length,
  }));
  const result = applyChangesToGuides(before, changes);
  if (result.changed) {
    repo.set(e.document.uri, result.guides);
    compositor.renderVisibleFor(e.document.uri);
  }
}

/**
 * The AI reading-guide feature: interprets the current function through a
 * headless coding-agent CLI and renders the returned steps in place.
 */
export class GuideFeature implements vscode.Disposable {
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private repo: GuideRepository,
    private compositor: Compositor,
  ) {
    this.subscriptions.push(
      vscode.commands.registerCommand('sightread.interpretFunction', () =>
        this.interpretFunction(),
      ),
      vscode.commands.registerCommand('sightread.guideFilterRoles', () => this.filterRoles()),
      vscode.commands.registerCommand('sightread.guideFilterRolesActive', () =>
        this.filterRoles(),
      ),
      vscode.commands.registerCommand('sightread.removeGuide', (node: GuideNode) => {
        if (node?.kind !== 'guide') {
          return;
        }
        this.repo.set(
          node.uri,
          this.repo.get(node.uri).filter((g) => g.id !== node.guide.id),
        );
        this.compositor.renderVisibleFor(node.uri);
      }),
    );
  }

  private async interpretFunction(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const target = await resolveInterpretTarget(doc, editor.selection);
    const lineCount = target.range.end.line - target.range.start.line + 1;
    if (lineCount > MAX_UNIT_LINES[target.unit]) {
      void vscode.window.showWarningMessage(
        `SightRead: ${target.unit} ${target.name} is longer than ${MAX_UNIT_LINES[target.unit]} lines — interpret a smaller unit instead.`,
      );
      return;
    }
    const cfg = vscode.workspace.getConfiguration('sightread');
    const runner = await pickHarness();
    if (!runner) {
      void showHarnessNotFound(cfg);
      return;
    }

    // Esc means "no focus", same as the marker-note prompt — never a cancel
    const userNote = await vscode.window.showInputBox({
      title: `AI Interpret: ${target.unit} ${target.name}`,
      prompt: `Prompt = built-in rules + promptTemplate.${target.unit} setting + this line. Optional — Enter or Esc to skip.`,
      placeHolder: 'your focus for this run, e.g. why the retry loop?',
    });

    const prompt = buildGuidePrompt(await collectSubjectContext(doc, target), {
      template: cfg.get<string>(`guide.promptTemplate.${target.unit}`, '') || undefined,
      userNote: userNote || undefined,
      language: cfg.get<string>('guide.language', '') || undefined,
    });
    const cwd =
      vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(doc.uri.fsPath);

    let raw: string;
    try {
      raw = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `SightRead: interpreting ${target.name} via ${runner.name}…`,
          cancellable: true,
        },
        (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return runner.run({ prompt, cwd, timeoutMs: RUN_TIMEOUT_MS, signal: abort.signal });
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== 'cancelled') {
        void vscode.window.showErrorMessage(`SightRead: ${message}`);
      }
      return;
    }

    const parsed = parseGuideResponse(
      {
        raw,
        subject: target.name,
        unit: target.unit,
        startLine: target.range.start.line,
        endLine: target.range.end.line,
      },
      newId,
    );
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(`SightRead: ${parsed.error}`);
      return;
    }
    const guide: Guide = {
      ...parsed.guide,
      steps: parsed.guide.steps.map((s) => ({ ...s, preview: linePreview(doc, s.startLine) })),
    };
    // a new interpretation supersedes whatever it overlaps (a function guide
    // replaces the file overview covering it — confirmed design)
    const kept = this.repo
      .get(doc.uri)
      .filter((g) => g.endLine < guide.startLine || g.startLine > guide.endLine);
    this.repo.set(doc.uri, [...kept, guide]);
    this.compositor.renderVisibleFor(doc.uri);
    void vscode.commands.executeCommand(
      'sightread.revealLocation',
      doc.uri.toString(),
      guide.steps[0].startLine,
    );
  }

  /**
   * Multi-select over the role keys present in the active file's guides plus
   * whatever is currently hidden (so a hidden role can always be brought
   * back). Checked = visible; confirming hides the unchecked. Session-wide
   * state, owned by the compositor; hiding applies everywhere — editor
   * decorations, the Markers view, and the Segments-view tint.
   */
  private async filterRoles(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const hidden = this.compositor.getHiddenGuideRoles();
    const counts = new Map<string, number>();
    if (editor) {
      for (const g of this.repo.get(editor.document.uri)) {
        for (const s of g.steps) {
          const key = roleKey(s.role);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    const keys = [...new Set([...counts.keys(), ...hidden])].sort(
      (a, b) => guideRoleRank(a) - guideRoleRank(b) || a.localeCompare(b),
    );
    if (keys.length === 0) {
      void vscode.window.showInformationMessage(
        'SightRead: no guide steps in this file to filter.',
      );
      return;
    }
    const items = keys.map((key) => {
      const n = counts.get(key) ?? 0;
      return {
        key,
        label: key || '(untagged)',
        description: n === 1 ? '1 step' : `${n} steps`,
        iconPath: circleIcon(guideRoleRgb(key)),
        picked: !hidden.has(key),
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Guide Steps: Visible Roles',
      placeHolder: 'Unchecked roles are hidden everywhere — editor, Markers and Segments views',
      canPickMany: true,
    });
    if (!picked) {
      return; // Esc — keep the current filter
    }
    const visible = new Set(picked.map((i) => i.key));
    const nextHidden = new Set(keys.filter((k) => !visible.has(k)));
    this.compositor.setHiddenGuideRoles(nextHidden);
    void vscode.commands.executeCommand(
      'setContext',
      'sightread.guideFilterActive',
      nextHidden.size > 0,
    );
    this.compositor.renderVisible();
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
  }
}
