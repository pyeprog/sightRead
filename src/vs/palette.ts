import * as vscode from 'vscode';
import { Accent, MarkerColor } from '../core/marks';

/**
 * One accent's editor paint, as "r, g, b" fragments for rgba() composition —
 * one per theme kind. All twelve accents (5 manual + 7 role tiers) sit on a
 * shared oklch band, gamut-mapped to sRGB — same-band colors read as one
 * family, and the light variants fix the old "dark palette on a white
 * editor" problem.
 */
export interface AccentPaint {
  dark: string;
  light: string;
}

/** The two contributed bands, selectable via `sightread.palette`. */
export type PaletteVariant = 'vivid' | 'soft';

type RoleTier =
  | 'primary'
  | 'entity'
  | 'setup'
  | 'plumbing'
  | 'special'
  | 'neutral'
  | 'boundary';

type AccentSlot = MarkerColor | RoleTier;

/**
 * oklch hues per slot: yellow 98, red 22, green 152, blue 258, purple 300;
 * primary 55 (warm orange), entity 345 (magenta), setup 240 (sky blue),
 * plumbing 265 (near-grey slate), special 215 (cyan), neutral 172 (guide
 * teal), boundary 78 (gold).
 *
 * vivid: dark L .79 C .15, light L .50 C .14 — brighter, higher contrast.
 * soft:  dark L .76 C .11, light L .46 C .11 — annotations recede.
 * plumbing runs at C .04 / .03 respectively (pipes must not steal the show).
 */
const BANDS: Record<PaletteVariant, Record<AccentSlot, AccentPaint>> = {
  vivid: {
    yellow: { dark: '212, 187, 48', light: '115, 99, 0' },
    red: { dark: '255, 154, 151', light: '164, 58, 61' },
    green: { dark: '101, 214, 138', light: '0, 119, 59' },
    blue: { dark: '143, 188, 255', light: '42, 97, 177' },
    purple: { dark: '199, 168, 255', light: '113, 76, 166' },
    primary: { dark: '255, 160, 92', light: '151, 76, 0' },
    entity: { dark: '253, 145, 208', light: '152, 60, 117' },
    setup: { dark: '109, 196, 255', light: '0, 106, 157' },
    plumbing: { dark: '174, 187, 213', light: '88, 99, 123' },
    special: { dark: '0, 208, 242', light: '0, 111, 131' },
    neutral: { dark: '25, 217, 175', light: '0, 117, 93' },
    boundary: { dark: '239, 173, 50', light: '131, 90, 0' },
  },
  soft: {
    yellow: { dark: '196, 178, 91', light: '102, 88, 0' },
    red: { dark: '239, 148, 145', light: '139, 59, 59' },
    green: { dark: '121, 197, 142', light: '23, 105, 56' },
    blue: { dark: '133, 179, 247', light: '46, 87, 148' },
    purple: { dark: '188, 161, 237', light: '98, 72, 140' },
    primary: { dark: '231, 158, 107', light: '133, 68, 8' },
    entity: { dark: '227, 148, 193', light: '130, 60, 102' },
    setup: { dark: '107, 186, 240', light: '0, 94, 140' },
    plumbing: { dark: '168, 177, 197', light: '80, 88, 105' },
    special: { dark: '77, 195, 221', light: '0, 99, 116' },
    neutral: { dark: '92, 200, 169', light: '0, 104, 82' },
    boundary: { dark: '215, 168, 91', light: '117, 80, 0' },
  },
};

function currentBand(): Record<AccentSlot, AccentPaint> {
  const v = vscode.workspace.getConfiguration('sightread').get<string>('palette', 'vivid');
  return BANDS[v === 'soft' ? 'soft' : 'vivid'];
}

/** Paint of a manual marker color, in the configured band. */
export function markerPaint(color: MarkerColor): AccentPaint {
  return currentBand()[color];
}

/** AI guide accent — the neutral teal, deliberately outside the 5 marker hues. */
export function guidePaint(): AccentPaint {
  return currentBand().neutral;
}

/**
 * ThemeColor id per role tier (package.json `colors`), used to tint tree
 * labels. Contributed color defaults are static — they carry the vivid
 * values regardless of the palette setting (same hues, so a soft editor
 * under vivid labels stays coherent); users can override them via
 * workbench.colorCustomizations.
 */
const ROLE_THEMES: Record<RoleTier, string> = {
  primary: 'sightread.guidePrimary',
  entity: 'sightread.guideEntity',
  setup: 'sightread.guideSetup',
  plumbing: 'sightread.guidePlumbing',
  special: 'sightread.guideSpecial',
  neutral: 'sightread.guideAccent',
  boundary: 'sightread.guideExports',
};

/**
 * Guide step role → accent tier. Roles are grouped across the three interpret
 * units so colors stay consistent (a class's `entry` is its `main`). Unknown
 * roles fall back to the neutral guide teal. The vivid tier marks what
 * deserves the reader's attention first (main/entry/core and entity/state);
 * quieter tiers recede.
 */
const ROLE_GROUP: Record<string, RoleTier> = {
  main: 'primary',
  entry: 'primary',
  core: 'primary',
  // core entities/state
  entity: 'entity',
  state: 'entity',
  // preparation
  setup: 'setup',
  config: 'setup',
  lifecycle: 'setup',
  // plumbing
  fallback: 'plumbing',
  util: 'plumbing',
  // exceptional paths / cross-cutting
  special: 'special',
  wiring: 'special',
  helper: 'neutral',
  types: 'neutral',
  // boundary
  exports: 'boundary',
};

function roleTier(role: string | undefined): RoleTier {
  return (role && ROLE_GROUP[role.toLowerCase()]) || 'neutral';
}

export function guideRolePaint(role: string | undefined): AccentPaint {
  return currentBand()[roleTier(role)];
}

/** Editor paint of any accent, in the configured band. */
export function accentPaint(a: Accent): AccentPaint {
  return a.kind === 'color' ? markerPaint(a.color) : guideRolePaint(a.role);
}

/** ThemeColor for accent-tinted tree labels — ids contributed in package.json `colors`. */
export function accentThemeColor(a: Accent): vscode.ThemeColor {
  if (a.kind === 'color') {
    return new vscode.ThemeColor(
      `sightread.marker${a.color[0].toUpperCase()}${a.color.slice(1)}`,
    );
  }
  return new vscode.ThemeColor(ROLE_THEMES[roleTier(a.role)]);
}

const ROLE_ORDER = Object.keys(ROLE_GROUP);

/**
 * Sort rank for role filter lists: the semantic group order above (so
 * same-colored roles sit together), then unknown roles, untagged last.
 * `key` is a normalized role key ('' for untagged).
 */
export function guideRoleRank(key: string): number {
  if (key === '') {
    return ROLE_ORDER.length + 1;
  }
  const i = ROLE_ORDER.indexOf(key);
  return i === -1 ? ROLE_ORDER.length : i;
}

/** Every accent paint of the configured band — the compositor makes one
 *  decoration pair per entry (re-queried when the palette setting changes). */
export function accentPaints(): AccentPaint[] {
  return Object.values(currentBand());
}

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** Thin vertical bar — used in the editor gutter. `rgb` is one theme's "r, g, b" fragment. */
export function gutterIcon(rgb: string): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<rect x="6" y="2" width="3" height="12" rx="1.5" fill="rgba(${rgb},0.9)"/></svg>`,
  );
}

function swatchSvg(rgb: string): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<rect x="2.5" y="4" width="11" height="8" rx="2.5" fill="rgba(${rgb},0.95)"/></svg>`,
  );
}

/** Rounded-rectangle color swatch — used in tree views and quick picks. */
export function swatchIcon(paint: AccentPaint): { light: vscode.Uri; dark: vscode.Uri } {
  return { light: swatchSvg(paint.light), dark: swatchSvg(paint.dark) };
}
