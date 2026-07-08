import * as vscode from 'vscode';
import { SegmentNode, extractBody, segmentTree } from '../core/segmentation';

/** A segment tree node with document-absolute line numbers. */
export type DocSegmentNode = SegmentNode;

function offsetTree(nodes: SegmentNode[], base: number): DocSegmentNode[] {
  return nodes.map((n) => ({
    ...n,
    startLine: n.startLine + base,
    endLine: n.endLine + base,
    children: offsetTree(n.children, base),
    headerLines: n.headerLines?.map((h) => h + base),
  }));
}

/**
 * Per-document, per-function segmentation cache, invalidated by document
 * version. Segmentation is pure text work, so recomputing is cheap; the cache
 * only avoids re-running it on every cursor move.
 */
export class SegmentCache {
  private cache = new Map<string, { version: number; byFn: Map<string, DocSegmentNode[]> }>();

  get(doc: vscode.TextDocument, fnRange: vscode.Range): DocSegmentNode[] {
    const key = doc.uri.toString();
    let entry = this.cache.get(key);
    if (!entry || entry.version !== doc.version) {
      entry = { version: doc.version, byFn: new Map() };
      this.cache.set(key, entry);
    }
    const fnKey = `${fnRange.start.line}:${fnRange.end.line}`;
    const hit = entry.byFn.get(fnKey);
    if (hit) {
      return hit;
    }

    const lastLine = Math.min(fnRange.end.line, doc.lineCount - 1);
    const lines: string[] = [];
    for (let i = fnRange.start.line; i <= lastLine; i++) {
      lines.push(doc.lineAt(i).text);
    }
    const body = extractBody(lines);
    const tree = offsetTree(segmentTree(body.lines), fnRange.start.line + body.offset);
    entry.byFn.set(fnKey, tree);
    return tree;
  }

  drop(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }
}
