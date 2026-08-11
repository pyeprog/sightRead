import * as vscode from 'vscode';
import { Accent, MarkerColor } from '../core/marks';

/**
 * One accent's editor paint, as "r, g, b" fragments for rgba() composition —
 * one per theme kind. All twelve accents (5 manual + 7 role tiers) sit on a
 * shared oklch band (dark L .79 C .15, light L .50 C .14; plumbing C .04),
 * gamut-mapped to sRGB — same-band colors read as one family, and the light
 * variants fix the old "dark palette on a white editor" problem.
 */
export interface AccentPaint {
  dark: string;
  light: string;
}

/** Marker palette (oklch hues: yellow 98, red 22, green 152, blue 258, purple 300). */
export const PALETTE: Record<MarkerColor, AccentPaint> = {
  yellow: { dark: '212, 187, 48', light: '115, 99, 0' },
  red: { dark: '255, 154, 151', light: '164, 58, 61' },
  green: { dark: '101, 214, 138', light: '0, 119, 59' },
  blue: { dark: '143, 188, 255', light: '42, 97, 177' },
  purple: { dark: '199, 168, 255', light: '113, 76, 166' },
};

/** AI guide accent — teal (hue 172), deliberately outside the 5 marker hues. */
export const GUIDE_PAINT: AccentPaint = { dark: '25, 217, 175', light: '0, 117, 93' };

/**
 * Guide step accent tiers: the editor paint plus the contributed theme color
 * (package.json `colors`) used to tint tree labels. The vivid tier marks what
 * deserves the reader's attention first (main/entry/core and entity/state);
 * quieter tiers recede.
 */
const ROLE_GROUPS = {
  primary: { paint: { dark: '255, 160, 92', light: '151, 76, 0' }, theme: 'sightread.guidePrimary' }, // warm orange (hue 55)
  entity: { paint: { dark: '253, 145, 208', light: '152, 60, 117' }, theme: 'sightread.guideEntity' }, // magenta (hue 345)
  setup: { paint: { dark: '109, 196, 255', light: '0, 106, 157' }, theme: 'sightread.guideSetup' }, // sky blue (hue 240)
  plumbing: { paint: { dark: '174, 187, 213', light: '88, 99, 123' }, theme: 'sightread.guidePlumbing' }, // near-grey slate (hue 265)
  special: { paint: { dark: '0, 208, 242', light: '0, 111, 131' }, theme: 'sightread.guideSpecial' }, // cyan (hue 215)
  neutral: { paint: GUIDE_PAINT, theme: 'sightread.guideAccent' }, // guide teal (hue 172)
  boundary: { paint: { dark: '239, 173, 50', light: '131, 90, 0' }, theme: 'sightread.guideExports' }, // gold (hue 78)
} as const;

/**
 * Guide step role → accent tier. Roles are grouped across the three interpret
 * units so colors stay consistent (a class's `entry` is its `main`). Unknown
 * roles fall back to the neutral guide teal.
 */
const ROLE_GROUP: Record<string, keyof typeof ROLE_GROUPS> = {
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

function roleGroup(role: string | undefined): { paint: AccentPaint; theme: string } {
  return ROLE_GROUPS[(role && ROLE_GROUP[role.toLowerCase()]) || 'neutral'];
}

export function guideRolePaint(role: string | undefined): AccentPaint {
  return roleGroup(role).paint;
}

/** Editor paint of any accent. */
export function accentPaint(a: Accent): AccentPaint {
  return a.kind === 'color' ? PALETTE[a.color] : guideRolePaint(a.role);
}

/** ThemeColor for accent-tinted tree labels — ids contributed in package.json `colors`. */
export function accentThemeColor(a: Accent): vscode.ThemeColor {
  if (a.kind === 'color') {
    return new vscode.ThemeColor(
      `sightread.marker${a.color[0].toUpperCase()}${a.color.slice(1)}`,
    );
  }
  return new vscode.ThemeColor(roleGroup(a.role).theme);
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

/** every accent a guide step can take — the compositor makes one decoration pair per entry */
export const GUIDE_ROLE_PAINTS: AccentPaint[] = [
  ...new Map(
    [GUIDE_PAINT, ...Object.values(ROLE_GROUPS).map((g) => g.paint)].map((p) => [p.dark, p]),
  ).values(),
];

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
