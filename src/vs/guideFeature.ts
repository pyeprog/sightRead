import * as path from 'path';
import * as vscode from 'vscode';
import {
  Guide,
  InterpretUnit,
  MARKER_COLORS,
  Mark,
  MarkerColor,
  accentFromKey,
  accentKey,
  addGuide,
  roleAccent,
} from '../core/marks';
import { parseGuideResponse } from '../core/guideParse';
import { SubjectContext, buildGuidePrompt } from '../core/guidePrompt';
import { BUILTIN_HARNESSES, HarnessProfile, resolveHarness } from '../core/harness';
import { recordDuration, typicalMs } from '../core/runStats';
import { autoDetectionOrder, pickHarness } from './agentCli';
import { Compositor } from './compositor';
import { linePreview } from './highlighter';
import { MarkRepository, newId } from './markRepository';
import { accentPaint, guideRoleRank, swatchIcon } from './palette';
import type { GuideNode } from './markersView';
import { InterpretTarget, resolveInterpretTarget } from './symbols';

const RUN_TIMEOUT_MS = 180_000;
/** globalState key: `${harness}/${unit}` → recent successful run durations (ms);
 *  shared with routeFeature, whose units are 'route' and 'trace' */
export const DURATIONS_KEY = 'sightread.guide.runDurations';
/** argv-size / token-cost guards for the one-shot prompt */
const MAX_UNIT_LINES: Record<InterpretUnit, number> = { function: 1200, class: 1200, file: 2000 };
const MAX_HEADER_LINES = 40;

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
export async function showHarnessNotFound(cfg: vscode.WorkspaceConfiguration): Promise<void> {
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

/**
 * The AI reading-guide feature: interprets the current function through a
 * headless coding-agent CLI and renders the returned steps in place, as
 * role-accent marks owned by a guide shell.
 */
export class GuideFeature implements vscode.Disposable {
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private repo: MarkRepository,
    private compositor: Compositor,
    /** globalState — typical durations belong to the machine's harness, not the workspace */
    private stats: vscode.Memento,
    /** shared "SightRead" channel — every AI run leaves its raw response here */
    private channel: vscode.OutputChannel,
  ) {
    this.subscriptions.push(
      vscode.commands.registerCommand('sightread.interpretFunction', () =>
        this.interpretFunction(),
      ),
      vscode.commands.registerCommand('sightread.guideFilterRoles', () => this.filterMarks()),
      vscode.commands.registerCommand('sightread.guideFilterRolesActive', () =>
        this.filterMarks(),
      ),
      vscode.commands.registerCommand('sightread.removeGuide', (node: GuideNode) => {
        if (node?.kind !== 'guide') {
          return;
        }
        const state = this.repo.get(node.uri);
        this.repo.set(node.uri, {
          marks: state.marks.filter((m) => m.guideId !== node.guide.id),
          guides: state.guides.filter((g) => g.id !== node.guide.id),
        });
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

    const durations = this.stats.get<Record<string, number[]>>(DURATIONS_KEY, {});
    const statsKey = `${runner.name}/${target.unit}`;
    const typicalS = Math.round(typicalMs(durations[statsKey] ?? []) / 1000);
    const model = cfg.get<string>('guide.model', '').trim() || undefined;

    let raw: string;
    const startMs = Date.now();
    try {
      raw = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          // the title names the model so an unset setting is visible as such
          title: `SightRead: interpreting ${target.name} via ${runner.name}${model ? ` · ${model}` : ' (default model)'}…`,
          cancellable: true,
        },
        (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          // the harness is silent until it finishes — an elapsed tick is the
          // "still alive" signal; the typical figure says whether the current
          // wait is normal. Constant text first, the growing counter last —
          // a changing prefix makes the notification re-wrap and jitter.
          const limitS = Math.round(RUN_TIMEOUT_MS / 1000);
          const prefix = `typically ~${typicalS}s · limit ${limitS}s · elapsed `;
          const ticker = setInterval(() => {
            const elapsedS = Math.round((Date.now() - startMs) / 1000);
            progress.report({ message: `${prefix}${elapsedS}s` });
          }, 1000);
          return runner
            .run({ prompt, cwd, timeoutMs: RUN_TIMEOUT_MS, signal: abort.signal, model })
            .finally(() => clearInterval(ticker));
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.channel.appendLine(
        `\n[${new Date().toISOString()}] ${target.unit} ${target.name} via ${runner.name}: run failed — ${message}`,
      );
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
      `\n[${new Date().toISOString()}] ${target.unit} ${target.name} via ${runner.name}`,
    );
    this.channel.appendLine('--- raw response ---');
    this.channel.appendLine(raw.trim());
    this.channel.appendLine('--- end raw response ---');

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
      this.channel.appendLine(`parse: ${parsed.error}`);
      void vscode.window.showErrorMessage(`SightRead: ${parsed.error}`);
      return;
    }
    this.channel.appendLine(`parse: ${parsed.guide.steps.length} steps`);
    const shell: Guide = {
      id: parsed.guide.id,
      subject: parsed.guide.subject,
      unit: parsed.guide.unit,
      summary: parsed.guide.summary,
    };
    const steps: Mark[] = parsed.guide.steps.map((s, order) => ({
      id: s.id,
      accent: roleAccent(s.role),
      note: s.note,
      preview: linePreview(doc, s.startLine),
      guideId: shell.id,
      order,
      startLine: s.startLine,
      endLine: s.endLine,
    }));
    // a new interpretation supersedes whatever it overlaps (a function guide
    // replaces the file overview covering it — handled inside addGuide)
    this.repo.set(doc.uri, addGuide(this.repo.get(doc.uri), shell, steps));
    this.compositor.renderVisibleFor(doc.uri);
    void vscode.commands.executeCommand(
      'sightread.revealLocation',
      doc.uri.toString(),
      steps[0].startLine,
    );
  }

  /**
   * Multi-select over the accent keys present in the active file's marks —
   * manual colors and AI roles alike — plus whatever is currently hidden (so
   * a hidden accent can always be brought back). Checked = visible;
   * confirming hides the unchecked. Session-wide state, owned by the
   * compositor; hiding applies everywhere — editor decorations and every
   * sidebar view.
   */
  private async filterMarks(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const hidden = this.compositor.getHiddenAccents();
    const counts = new Map<string, number>();
    if (editor) {
      for (const m of this.repo.get(editor.document.uri).marks) {
        const key = accentKey(m.accent);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // colors first in palette order, then roles in semantic-group order
    const rank = (key: string): number =>
      key.startsWith('color:')
        ? MARKER_COLORS.indexOf(key.slice('color:'.length) as MarkerColor)
        : MARKER_COLORS.length + guideRoleRank(key.slice('role:'.length));
    const keys = [...new Set([...counts.keys(), ...hidden])].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    );
    if (keys.length === 0) {
      void vscode.window.showInformationMessage('SightRead: no marks in this file to filter.');
      return;
    }
    const label = (key: string): string => {
      if (key.startsWith('color:')) {
        const color = key.slice('color:'.length);
        return color[0].toUpperCase() + color.slice(1);
      }
      return key.slice('role:'.length) || '(untagged)';
    };
    const items = keys.map((key) => {
      const n = counts.get(key) ?? 0;
      return {
        key,
        label: label(key),
        description: n === 1 ? '1 mark' : `${n} marks`,
        iconPath: swatchIcon(accentPaint(accentFromKey(key))),
        picked: !hidden.has(key),
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Marks: Visible Colors & Roles',
      placeHolder: 'Unchecked marks are hidden everywhere — editor and views',
      canPickMany: true,
    });
    if (!picked) {
      return; // Esc — keep the current filter
    }
    const visible = new Set(picked.map((i) => i.key));
    const nextHidden = new Set(keys.filter((k) => !visible.has(k)));
    this.compositor.setHiddenAccents(nextHidden);
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
