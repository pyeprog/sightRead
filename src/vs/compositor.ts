import * as vscode from 'vscode';
import { LineRange, intersectsAny, subtractRanges } from '../core/focus';
import { Guide, stepVisible } from '../core/guide';
import { MARKER_COLORS, Marker, MarkerColor } from '../core/markers';
import { GUIDE_RGB, GUIDE_ROLE_RGBS, PALETTE, guideRoleRgb, gutterIcon } from './palette';

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

/**
 * The single rendering coordinator (design.md §一.4): every decoration in the
 * extension flows through here. Owns all decoration types and composes the
 * persistent layer (markers + guides) with the transient state (tint +
 * spotlight), including suppressing markers inside dimmed regions.
 */
export class Compositor implements vscode.Disposable {
  private markerFull = new Map<MarkerColor, vscode.TextEditorDecorationType>();
  private markerDim = new Map<MarkerColor, vscode.TextEditorDecorationType>();
  /** one pair per role accent, keyed by the "r, g, b" fragment */
  private guideFull = new Map<string, vscode.TextEditorDecorationType>();
  private guideDim = new Map<string, vscode.TextEditorDecorationType>();
  private noteType: vscode.TextEditorDecorationType;
  private tintRead: vscode.TextEditorDecorationType;
  private tintWrite: vscode.TextEditorDecorationType;
  private dimHeavy!: vscode.TextEditorDecorationType;
  private dimMedium!: vscode.TextEditorDecorationType;
  private dimLight!: vscode.TextEditorDecorationType;

  private transient = new Map<string, TransientState>();
  /** role keys whose guide steps are not rendered at all (session state) */
  private hiddenGuideRoles: ReadonlySet<string> = new Set();

  constructor(
    private getMarkers: (uri: vscode.Uri) => Marker[],
    private getGuides: (uri: vscode.Uri) => Guide[],
  ) {
    for (const color of MARKER_COLORS) {
      const rgb = PALETTE[color];
      this.markerFull.set(
        color,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: `rgba(${rgb}, 0.14)`,
          overviewRulerColor: `rgba(${rgb}, 0.7)`,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
          gutterIconPath: gutterIcon(rgb),
          gutterIconSize: 'contain',
        }),
      );
      this.markerDim.set(
        color,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: `rgba(${rgb}, 0.04)`,
          overviewRulerColor: `rgba(${rgb}, 0.25)`,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
        }),
      );
    }
    for (const rgb of GUIDE_ROLE_RGBS) {
      this.guideFull.set(
        rgb,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: `rgba(${rgb}, 0.10)`,
          overviewRulerColor: `rgba(${rgb}, 0.7)`,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
          gutterIconPath: gutterIcon(rgb),
          gutterIconSize: 'contain',
        }),
      );
      this.guideDim.set(
        rgb,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: `rgba(${rgb}, 0.03)`,
          overviewRulerColor: `rgba(${rgb}, 0.25)`,
          overviewRulerLane: vscode.OverviewRulerLane.Center,
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

  setHiddenGuideRoles(hidden: ReadonlySet<string>): void {
    this.hiddenGuideRoles = hidden;
  }

  getHiddenGuideRoles(): ReadonlySet<string> {
    return this.hiddenGuideRoles;
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
    const markers = this.clip(this.getMarkers(doc.uri), lastLine);

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

    // markers: full style in lit regions, suppressed style inside dimmed ones
    const isLit = (r: LineRange): boolean => !spot || intersectsAny(r, spot.lit);
    for (const color of MARKER_COLORS) {
      const full: vscode.Range[] = [];
      const dim: vscode.Range[] = [];
      for (const m of markers) {
        if (m.color === color) {
          const span = { start: m.startLine, end: m.endLine };
          (isLit(span) ? full : dim).push(lineRangeOf(span));
        }
      }
      editor.setDecorations(this.markerFull.get(color)!, full);
      editor.setDecorations(this.markerDim.get(color)!, dim);
    }

    // guide steps: one accent per role, under the same lit/dim rule
    const guides = this.getGuides(doc.uri).filter((g) => g.startLine <= lastLine);
    const stepFull = new Map<string, vscode.Range[]>();
    const stepDim = new Map<string, vscode.Range[]>();
    for (const g of guides) {
      for (const s of g.steps) {
        if (s.startLine > lastLine || !stepVisible(s.role, this.hiddenGuideRoles)) {
          continue;
        }
        const span = { start: s.startLine, end: Math.min(s.endLine, lastLine) };
        const bucket = isLit(span) ? stepFull : stepDim;
        const rgb = guideRoleRgb(s.role);
        bucket.set(rgb, [...(bucket.get(rgb) ?? []), lineRangeOf(span)]);
      }
    }
    for (const [rgb, type] of this.guideFull) {
      editor.setDecorations(type, stepFull.get(rgb) ?? []);
    }
    for (const [rgb, type] of this.guideDim) {
      editor.setDecorations(type, stepDim.get(rgb) ?? []);
    }

    // notes, at the start or end of the item's first line: marker notes, then
    // guide summaries (function header) and numbered step notes
    const noteAtStart =
      vscode.workspace
        .getConfiguration('sightread')
        .get<string>('marker.notePosition', 'lineEnd') === 'lineStart';
    const noteOption = (line: number, text: string, rgb: string): vscode.DecorationOptions => {
      const noteStyle = {
        contentText: noteAtStart ? `${text} ` : ` ${text}`,
        color: `rgba(${rgb}, 0.85)`,
        fontStyle: 'italic',
        margin: noteAtStart ? '0 0.8em 0 0' : '0 0 0 1.5em',
      };
      if (noteAtStart) {
        return {
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: { before: noteStyle },
        };
      }
      const eol = doc.lineAt(line).text.length;
      return {
        range: new vscode.Range(line, eol, line, eol),
        renderOptions: { after: noteStyle },
      };
    };
    const noteOptions: vscode.DecorationOptions[] = markers
      .filter((m) => m.note)
      .map((m) => noteOption(m.startLine, `✎ ${m.note}`, PALETTE[m.color]));
    for (const g of guides) {
      if (g.summary) {
        noteOptions.push(noteOption(g.startLine, `✦ ${g.summary}`, GUIDE_RGB));
      }
      g.steps.forEach((s, i) => {
        if (s.startLine <= lastLine && stepVisible(s.role, this.hiddenGuideRoles)) {
          const role = s.role ? `[${s.role}] ` : '';
          noteOptions.push(
            noteOption(s.startLine, `${stepBadge(i)} ${role}${s.note}`, guideRoleRgb(s.role)),
          );
        }
      });
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

  private clip(markers: Marker[], lastLine: number): Marker[] {
    return markers
      .filter((m) => m.startLine <= lastLine)
      .map((m) => (m.endLine <= lastLine ? m : { ...m, endLine: lastLine }));
  }

  dispose(): void {
    for (const t of this.markerFull.values()) {
      t.dispose();
    }
    for (const t of this.markerDim.values()) {
      t.dispose();
    }
    for (const t of this.guideFull.values()) {
      t.dispose();
    }
    for (const t of this.guideDim.values()) {
      t.dispose();
    }
    this.noteType.dispose();
    this.tintRead.dispose();
    this.tintWrite.dispose();
    this.dimHeavy.dispose();
    this.dimMedium.dispose();
    this.dimLight.dispose();
  }
}
