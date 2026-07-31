import * as vscode from 'vscode';
import { MarkerColor } from '../core/markers';

/** Marker palette as "r, g, b" fragments for rgba() composition. */
export const PALETTE: Record<MarkerColor, string> = {
  yellow: '255, 200, 40',
  red: '255, 99, 99',
  green: '88, 200, 120',
  blue: '90, 156, 255',
  purple: '187, 134, 252',
};

/** AI guide accent — teal, deliberately outside the 5 marker colors. */
export const GUIDE_RGB = '78, 201, 176';

/**
 * Guide step accent tiers: the editor "r, g, b" fragment plus the contributed
 * theme color (package.json `colors`) used to tint tree labels. The vivid
 * tier marks what deserves the reader's attention first (main/entry/core and
 * entity/state); quieter tiers recede.
 */
const ROLE_GROUPS = {
  primary: { rgb: '255, 150, 60', theme: 'sightread.guidePrimary' }, // vivid warm
  entity: { rgb: '255, 110, 190', theme: 'sightread.guideEntity' }, // vivid magenta
  setup: { rgb: '110, 170, 255', theme: 'sightread.guideSetup' }, // sky blue
  plumbing: { rgb: '150, 150, 165', theme: 'sightread.guidePlumbing' }, // muted slate
  special: { rgb: '90, 200, 245', theme: 'sightread.guideSpecial' }, // cyan
  neutral: { rgb: GUIDE_RGB, theme: 'sightread.guideAccent' }, // guide teal
  boundary: { rgb: '255, 205, 90', theme: 'sightread.guideExports' }, // gold
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

function roleGroup(role: string | undefined): { rgb: string; theme: string } {
  return ROLE_GROUPS[(role && ROLE_GROUP[role.toLowerCase()]) || 'neutral'];
}

export function guideRoleRgb(role: string | undefined): string {
  return roleGroup(role).rgb;
}

/** ThemeColor for guide-step-tinted tree labels — ids contributed in package.json `colors`. */
export function guideRoleThemeColor(role: string | undefined): vscode.ThemeColor {
  return new vscode.ThemeColor(roleGroup(role).theme);
}

const ROLE_ORDER = Object.keys(ROLE_GROUP);

/**
 * Sort rank for role filter lists: the semantic group order above (so
 * same-colored roles sit together), then unknown roles, untagged last.
 * `key` is a normalized roleKey.
 */
export function guideRoleRank(key: string): number {
  if (key === '') {
    return ROLE_ORDER.length + 1;
  }
  const i = ROLE_ORDER.indexOf(key);
  return i === -1 ? ROLE_ORDER.length : i;
}

/** every accent a guide step can take — the compositor makes one decoration pair per entry */
export const GUIDE_ROLE_RGBS: string[] = [
  ...new Set([GUIDE_RGB, ...Object.values(ROLE_GROUPS).map((g) => g.rgb)]),
];

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** Thin vertical bar — used in the editor gutter. `rgb` is an "r, g, b" fragment. */
export function gutterIcon(rgb: string): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<rect x="6" y="2" width="3" height="12" rx="1.5" fill="rgba(${rgb},0.9)"/></svg>`,
  );
}

/** Theme color for marker-tinted labels — ids contributed in package.json `colors`. */
export function markerThemeColor(color: MarkerColor): vscode.ThemeColor {
  return new vscode.ThemeColor(`sightread.marker${color[0].toUpperCase()}${color.slice(1)}`);
}

/** Filled circle — used in tree views. `rgb` is an "r, g, b" fragment. */
export function circleIcon(rgb: string): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<circle cx="8" cy="8" r="5" fill="rgba(${rgb},0.95)"/></svg>`,
  );
}
