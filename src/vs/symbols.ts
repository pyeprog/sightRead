import * as path from 'path';
import * as vscode from 'vscode';
import {
  EnclosingCandidate,
  chooseEnclosingFunction,
  chooseInnermostFunction,
  chooseInterpretUnit,
  chooseOutermostFunction,
} from '../core/enclosing';
import { InterpretUnit } from '../core/marks';
import { stripParens } from '../core/jumpClassify';

const FUNCTION_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
]);

export interface FunctionInfo {
  name: string;
  range: vscode.Range;
}

interface Candidate extends EnclosingCandidate {
  name: string;
  range: vscode.Range;
  kind: vscode.SymbolKind;
  /** reported as a class-like symbol (Class/Interface/Struct/Enum) */
  classKind: boolean;
  /** range of the symbol's own name; absent for SymbolInformation providers */
  selectionRange?: vscode.Range;
  containerName?: string;
}

/** The trail's view of the symbol under the cursor (design.md §3.7). */
export interface SymbolAtCursor extends FunctionInfo {
  kind: vscode.SymbolKind;
  containerName?: string;
  /** the cursor sits on the symbol's own name */
  onName: boolean;
}

export interface EnclosingFunctions {
  /** the spotlight anchor — the innermost function-like symbol */
  fn?: FunctionInfo;
  /** the widest function-like symbol containing the cursor (`fn` itself when nothing wraps it) */
  outermost?: FunctionInfo;
  /** innermost symbol under the cursor — unlike `fn`, a header line counts as
   *  the symbol itself, and the kind/name-range info the trail needs is kept */
  at?: SymbolAtCursor;
}

async function documentSymbols(
  doc: vscode.TextDocument,
): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[]> {
  try {
    return (
      (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      )) ?? []
    );
  } catch (_e) {
    return [];
  }
}

/** Multi-line symbols whose line span contains [`pos`, `endPos`] (line-based,
 *  so the header's indentation and the closing brace's tail count as inside). */
async function collectContaining(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  endPos: vscode.Position = pos,
): Promise<Candidate[]> {
  const roots = await documentSymbols(doc);

  const containing: Candidate[] = [];
  const visit = (
    s: vscode.DocumentSymbol | vscode.SymbolInformation,
    container?: string,
  ): void => {
    const range = 'location' in s ? s.location.range : s.range;
    if (pos.line < range.start.line || endPos.line > range.end.line) {
      return;
    }
    if (range.end.line - range.start.line >= 1) {
      containing.push({
        startLine: range.start.line,
        endLine: range.end.line,
        fnKind: FUNCTION_KINDS.has(s.kind),
        classKind: CLASS_KINDS.has(s.kind),
        name: s.name,
        range,
        kind: s.kind,
        selectionRange: 'selectionRange' in s ? s.selectionRange : undefined,
        containerName:
          'containerName' in s && s.containerName ? s.containerName : container,
      });
    }
    if ('children' in s) {
      s.children.forEach((c) => visit(c, s.name));
    }
  };
  roots.forEach((s) => visit(s, undefined));
  return containing;
}

/** A named symbol located for route seeding, as the provider reports it. */
export interface NamedSymbol {
  name: string;
  containerName?: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
}

/**
 * Finds a symbol by name in one document, for seeding AI-planned trail
 * nodes. Names compare via stripParens (C-family providers append parameter
 * lists). A container match ranks first, then the smallest distance to
 * `lineHint`; ties keep document order.
 */
export async function findSymbolByName(
  doc: vscode.TextDocument,
  name: string,
  containerName?: string,
  lineHint?: number,
): Promise<NamedSymbol | undefined> {
  const wanted = stripParens(name);
  const wantedContainer = containerName === undefined ? undefined : stripParens(containerName);
  const matches: NamedSymbol[] = [];
  const visit = (
    s: vscode.DocumentSymbol | vscode.SymbolInformation,
    container?: string,
  ): void => {
    if (stripParens(s.name) === wanted) {
      matches.push({
        name: s.name,
        containerName: 'containerName' in s && s.containerName ? s.containerName : container,
        kind: s.kind,
        range: 'location' in s ? s.location.range : s.range,
      });
    }
    if ('children' in s) {
      s.children.forEach((c) => visit(c, s.name));
    }
  };
  (await documentSymbols(doc)).forEach((s) => visit(s, undefined));
  const score = (m: NamedSymbol): number[] => [
    wantedContainer !== undefined &&
    m.containerName !== undefined &&
    stripParens(m.containerName) === wantedContainer
      ? 0
      : 1,
    lineHint === undefined ? 0 : Math.abs(m.range.start.line - lineHint),
  ];
  return matches
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1])
    .map((x) => x.m)[0];
}

const info = (c: Candidate | undefined): FunctionInfo | undefined =>
  c ? { name: c.name, range: c.range } : undefined;

/**
 * Finds the spotlight anchor function containing `pos`, plus the outermost
 * one (the island search scope, see core/enclosing.ts). Falls back to
 * containing multi-line symbols of any kind (covers arrow functions reported
 * as Variable/Property by some language servers). A nested function whose
 * header line is the cursor line yields to its enclosing function, so that a
 * local definition and its call sites spotlight each other.
 */
export async function findEnclosingFunctions(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<EnclosingFunctions> {
  const containing = await collectContaining(doc, pos);
  const at = chooseInnermostFunction(containing);
  return {
    fn: info(chooseEnclosingFunction(containing, pos.line)),
    outermost: info(chooseOutermostFunction(containing)),
    at: at
      ? {
          name: at.name,
          range: at.range,
          kind: at.kind,
          containerName: at.containerName,
          onName: at.selectionRange
            ? at.selectionRange.contains(pos)
            : pos.line === at.range.start.line,
        }
      : undefined,
  };
}

/**
 * The target of explicit "current function" commands: the innermost
 * function-like symbol containing `pos`. Unlike the spotlight anchor of
 * `findEnclosingFunctions`, a nested function's header line counts as the
 * nested function itself — folding on `function inner(…)` must fold `inner`,
 * not the function around it.
 */
export async function findFunctionAtCursor(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<FunctionInfo | undefined> {
  return info(chooseInnermostFunction(await collectContaining(doc, pos)));
}

export interface InterpretTarget {
  unit: InterpretUnit;
  /** function name, class name, or file basename for the file unit */
  name: string;
  /** the whole document for the file unit */
  range: vscode.Range;
}

/**
 * What "Interpret Current" points at. With no selection the cursor decides
 * (innermost function → enclosing class → file); with a selection the
 * candidates are narrowed to symbols containing the whole selection, so
 * selecting a class definition interprets the class and a multi-symbol
 * selection falls through to the file.
 */
export async function resolveInterpretTarget(
  doc: vscode.TextDocument,
  selection: vscode.Selection,
): Promise<InterpretTarget> {
  const containing = await collectContaining(doc, selection.start, selection.end);
  const chosen = chooseInterpretUnit(containing);
  if (chosen) {
    return { unit: chosen.unit, name: chosen.candidate.name, range: chosen.candidate.range };
  }
  return {
    unit: 'file',
    name: path.basename(doc.uri.fsPath),
    range: new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length),
  };
}
