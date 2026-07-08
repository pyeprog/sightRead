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

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** Thin vertical bar — used in the editor gutter. */
export function gutterIcon(color: MarkerColor): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<rect x="6" y="2" width="3" height="12" rx="1.5" fill="rgba(${PALETTE[color]},0.9)"/></svg>`,
  );
}

/** Filled circle — used in tree views. */
export function circleIcon(color: MarkerColor): vscode.Uri {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
      `<circle cx="8" cy="8" r="5" fill="rgba(${PALETTE[color]},0.95)"/></svg>`,
  );
}
