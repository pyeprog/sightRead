import * as vscode from 'vscode';
import { LineRange, intersectsAny, subtractRanges } from '../core/focus';
import {
  FileMarks,
  MARKER_COLORS,
  Mark,
  guideEnvelope,
  markVisible,
} from '../core/marks';
import {
  AccentPaint,
  GUIDE_PAINT,
  GUIDE_ROLE_PAINTS,
  PALETTE,
  accentPaint,
  gutterIcon,
} from './palette';

const STEP_BADGES = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** Reading-order badge for a 0-based step index. */
function stepBadge(index: number): string {
  return index < STEP_BADGES.length ? STEP_BADGES[index] : `(${index + 1})`;
}

export interface TintOccurrence {
  range: vscode.Range;
  write: boolean;
}

export interface SpotlightRender {
  fn: LineRange;
  /** fully lit; may extend outside `fn` (related islands at Seg+Var) */
  lit: LineRange[];
  /** lightly dimmed (siblings tier); disjoint from `lit` */
  light: LineRange[];
}

interface TransientState {
  tint: TintOccurrence[];
  spotlight?: SpotlightRender;
}

/** every accent paint a mark can take — one decoration pair per entry,
 *  deduplicated and keyed by the dark fragment */
const ACCENT_PAINTS: AccentPaint[] = [
  ...new Map(
    [...MARKER_COLORS.map((c) => PALETTE[c]), ...GUIDE_ROLE_PAINTS].map((p) => [p.dark, p]),
  ).values(),
];

/**
 * The single rendering coordinator (design.md §一.4): every decoration in the
 * extension flows through here. Owns all decoration types and composes the
 * persistent layer (marks — manual and AI alike) with the transient state
 * (tint + spotlight), including suppressing marks inside dimmed regions.
 */
export class Compositor implements vscode.Disposable {
  /** one pair per accent paint (keyed by its dark fragment), shared by manual
   *  colors and guide roles; each type carries light/dark variants */
  private accentFull = new Map<string, vscode.TextEditorDecorationType>();
  private accentDim = new Map<string, vscode.TextEditorDecorationType>();
  private noteType: vscode.TextEditorDecorationType;
  private tintRead: vscode.TextEditorDecorationType;
  private tintWrite: vscode.TextEditorDecorationType;
  private dimHeavy!: vscode.TextEditorDecorationType;
  private dimMedium!: vscode.TextEditorDecorationType;
  private dimLight!: vscode.TextEditorDecorationType;

  private transient = new Map<string, TransientState>();
  /** accent keys (accentKey) whose marks are not rendered at all (session state) */
  private hiddenAccents: ReadonlySet<string> = new Set();
  private hiddenEmitter = new vscode.EventEmitter<void>();
  /** fired by setHiddenAccents — the tree views mirror the filter from it */
  readonly onDidChangeHiddenAccents = this.hiddenEmitter.event;

  constructor(private getState: (uri: vscode.Uri) => FileMarks) {
    for (const paint of ACCENT_PAINTS) {
      this.accentFull.set(
        paint.dark,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
          gutterIconSize: 'contain',
          dark: {
            backgroundColor: `rgba(${paint.dark}, 0.12)`,
            overviewRulerColor: `rgba(${paint.dark}, 0.7)`,
            gutterIconPath: gutterIcon(paint.dark),
          },
          light: {
            backgroundColor: `rgba(${paint.light}, 0.12)`,
            overviewRulerColor: `rgba(${paint.light}, 0.7)`,
            gutterIconPath: gutterIcon(paint.light),
          },
        }),
      );
      this.accentDim.set(
        paint.dark,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
          dark: {
            backgroundColor: `rgba(${paint.dark}, 0.04)`,
            overviewRulerColor: `rgba(${paint.dark}, 0.25)`,
          },
          light: {
            backgroundColor: `rgba(${paint.light}, 0.04)`,
            overviewRulerColor: `rgba(${paint.light}, 0.25)`,
          },
        }),
      );
    }
    this.noteType = vscode.window.createTextEditorDecorationType({});
    this.tintRead = vscode.window.createTextEditorDecorationType({
      border: '1px solid rgba(100, 180, 255, 0.8)',
      borderRadius: '2px',
    });
    this.tintWrite = vscode.window.createTextEditorDecorationType({
      border: '1px solid rgba(255, 150, 50, 0.95)',
      borderRadius: '2px',
      fontWeight: 'bold',
    });
    this.refreshDimTypes();
  }

  /** (Re)creates the opacity-based dim types from configuration. */
  refreshDimTypes(): void {
    this.dimHeavy?.dispose();
    this.dimMedium?.dispose();
    this.dimLight?.dispose();
    const cfg = vscode.workspace.getConfiguration('sightread');
    this.dimHeavy = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: String(cfg.get('spotlight.functionDimOpacity', 0.15)),
    });
    this.dimMedium = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: String(cfg.get('spotlight.segmentDimOpacity', 0.4)),
    });
    this.dimLight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: String(cfg.get('spotlight.siblingDimOpacity', 0.6)),
    });
  }

  setTransient(uri: vscode.Uri, state: TransientState): void {
    this.transient.set(uri.toString(), state);
  }

  setHiddenAccents(hidden: ReadonlySet<string>): void {
    this.hiddenAccents = hidden;
    this.hiddenEmitter.fire();
  }

  getHiddenAccents(): ReadonlySet<string> {
    return this.hiddenAccents;
  }

  /** test hook */
  getTransient(uri: vscode.Uri): TransientState | undefined {
    return this.transient.get(uri.toString());
  }

  /** The spotlight/tint belong to the active document only. */
  clearTransientExcept(uri: vscode.Uri): void {
    const keep = uri.toString();
    for (const key of [...this.transient.keys()]) {
      if (key !== keep) {
        this.transient.delete(key);
      }
    }
  }

  renderVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  renderVisibleFor(uri: vscode.Uri): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.render(editor);
      }
    }
  }

  render(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const lastLine = doc.lineCount - 1;
    const state = this.transient.get(doc.uri.toString()) ?? { tint: [] };
    const spot = state.spotlight;
    const fileMarks = this.getState(doc.uri);
    const marks = this.clip(
      fileMarks.marks.filter((m) => markVisible(m.accent, this.hiddenAccents)),
      lastLine,
    );

    const lineRangeOf = (r: LineRange): vscode.Range => {
      const end = Math.min(r.end, lastLine);
      return new vscode.Range(r.start, 0, end, doc.lineAt(end).text.length);
    };

    // spotlight dim layers (heavy: outside fn minus lit islands, medium: non-related, light: siblings)
    if (spot) {
      const heavy = subtractRanges({ start: 0, end: lastLine }, [spot.fn, ...spot.lit]);
      const light = spot.light.filter((r) => r.start <= lastLine);
      const medium = subtractRanges(
        { start: spot.fn.start, end: Math.min(spot.fn.end, lastLine) },
        [...spot.lit, ...light],
      );
      editor.setDecorations(this.dimHeavy, heavy.map(lineRangeOf));
      editor.setDecorations(this.dimMedium, medium.map(lineRangeOf));
      editor.setDecorations(this.dimLight, light.map(lineRangeOf));
    } else {
      editor.setDecorations(this.dimHeavy, []);
      editor.setDecorations(this.dimMedium, []);
      editor.setDecorations(this.dimLight, []);
    }

    // marks: full style in lit regions, suppressed style inside dimmed ones
    const isLit = (r: LineRange): boolean => !spot || intersectsAny(r, spot.lit);
    const full = new Map<string, vscode.Range[]>();
    const dim = new Map<string, vscode.Range[]>();
    for (const m of marks) {
      const span = { start: m.startLine, end: m.endLine };
      const bucket = isLit(span) ? full : dim;
      const key = accentPaint(m.accent).dark;
      bucket.set(key, [...(bucket.get(key) ?? []), lineRangeOf(span)]);
    }
    for (const [rgb, type] of this.accentFull) {
      editor.setDecorations(type, full.get(rgb) ?? []);
    }
    for (const [rgb, type] of this.accentDim) {
      editor.setDecorations(type, dim.get(rgb) ?? []);
    }

    // notes, at the start or end of the mark's first line: ✎ manual notes,
    // ✦ guide summaries (at the guide's first surviving mark), ① step notes
    const noteAtStart =
      vscode.workspace
        .getConfiguration('sightread')
        .get<string>('marker.notePosition', 'lineEnd') === 'lineStart';
    const noteOption = (
      line: number,
      text: string,
      paint: AccentPaint,
    ): vscode.DecorationOptions => {
      const noteStyle = {
        contentText: noteAtStart ? `${text} ` : ` ${text}`,
        fontStyle: 'italic',
        margin: noteAtStart ? '0 0.8em 0 0' : '0 0 0 1.5em',
      };
      if (noteAtStart) {
        return {
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: {
            before: noteStyle,
            dark: { before: { color: `rgba(${paint.dark}, 0.85)` } },
            light: { before: { color: `rgba(${paint.light}, 0.85)` } },
          },
        };
      }
      const eol = doc.lineAt(line).text.length;
      return {
        range: new vscode.Range(line, eol, line, eol),
        renderOptions: {
          after: noteStyle,
          dark: { after: { color: `rgba(${paint.dark}, 0.85)` } },
          light: { after: { color: `rgba(${paint.light}, 0.85)` } },
        },
      };
    };
    const noteOptions: vscode.DecorationOptions[] = [];
    for (const g of fileMarks.guides) {
      const envelope = guideEnvelope(fileMarks, g.id);
      if (g.summary && envelope && envelope.startLine <= lastLine) {
        noteOptions.push(noteOption(envelope.startLine, `✦ ${g.summary}`, GUIDE_PAINT));
      }
    }
    for (const m of marks) {
      if (m.guideId !== undefined) {
        const role = m.accent.kind === 'role' && m.accent.role ? `[${m.accent.role}] ` : '';
        noteOptions.push(
          noteOption(
            m.startLine,
            `${stepBadge(m.order ?? 0)} ${role}${m.note ?? ''}`,
            accentPaint(m.accent),
          ),
        );
      } else if (m.note) {
        noteOptions.push(noteOption(m.startLine, `✎ ${m.note}`, accentPaint(m.accent)));
      }
    }
    editor.setDecorations(this.noteType, noteOptions);

    // variable tint (stroke channel); hidden inside dimmed regions
    let occurrences = state.tint;
    if (spot) {
      occurrences = occurrences.filter((o) =>
        intersectsAny({ start: o.range.start.line, end: o.range.start.line }, spot.lit),
      );
    }
    editor.setDecorations(
      this.tintRead,
      occurrences.filter((o) => !o.write).map((o) => o.range),
    );
    editor.setDecorations(
      this.tintWrite,
      occurrences.filter((o) => o.write).map((o) => o.range),
    );
  }

  private clip(marks: Mark[], lastLine: number): Mark[] {
    return marks
      .filter((m) => m.startLine <= lastLine)
      .map((m) => (m.endLine <= lastLine ? m : { ...m, endLine: lastLine }));
  }

  dispose(): void {
    for (const t of this.accentFull.values()) {
      t.dispose();
    }
    for (const t of this.accentDim.values()) {
      t.dispose();
    }
    this.noteType.dispose();
    this.tintRead.dispose();
    this.tintWrite.dispose();
    this.dimHeavy.dispose();
    this.dimMedium.dispose();
    this.dimLight.dispose();
    this.hiddenEmitter.dispose();
  }
}
