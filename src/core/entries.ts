/**
 * Entry-point classification for a file's top-level symbols.
 * Pure logic, no vscode dependency.
 *
 * The primary signal is usage: a symbol referenced from another file is an
 * entry no matter how it is declared. Language syntax (export keywords,
 * naming conventions) only breaks ties for symbols with no references at
 * all — it can promote them to entries or drop them, never override usage.
 */

export type EntryVerdict = 'entry' | 'suspected' | 'hidden';

export interface EntryEvidence {
  /** references from other files (declaration excluded) */
  externalRefs: number;
  /** references from this file outside the symbol's own body (self-recursion and export clauses excluded) */
  internalRefs: number;
  /**
   * language-syntax verdict: true = declared public (export/pub keyword, an
   * export clause, Go capitalization), false = declared private (underscore
   * prefix, Go lowercase), undefined = the syntax says nothing either way.
   */
  declaredPublic?: boolean;
  /**
   * the symbol is an imported name (import statement, or its definition
   * resolves to another file). Its reference counts describe the ORIGINAL
   * symbol workspace-wide, so they say nothing about this file.
   */
  alias?: boolean;
}

/**
 * entry     — referenced from outside the file (internal refs are irrelevant:
 *             an entry may also be wrapped by a more abstract entry), or
 *             unreferenced but declared public.
 * hidden    — only referenced within the file, or unreferenced and declared
 *             private. Not shown.
 * suspected — no references found anywhere and the syntax is silent. Could be
 *             a framework-invoked entry (activation hooks, route handlers,
 *             string dispatch) or dead code; shown de-emphasized.
 */
export function classifyEntry(e: EntryEvidence): EntryVerdict {
  if (e.alias) {
    // an import is someone else's symbol; only re-publishing it
    // (`export { x }`, `__all__`) makes it an entry of THIS file
    return e.declaredPublic === true ? 'entry' : 'hidden';
  }
  if (e.externalRefs > 0) {
    return 'entry';
  }
  if (e.internalRefs > 0) {
    return 'hidden';
  }
  if (e.declaredPublic === true) {
    return 'entry';
  }
  if (e.declaredPublic === false) {
    return 'hidden';
  }
  return 'suspected';
}

const EXPORT_KEYWORD_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
]);

/**
 * Reads what the declaration syntax says about visibility. Deliberately
 * asymmetric where the syntax is inconclusive: a missing `export` keyword on
 * the declaration line proves nothing (the symbol may be re-exported from an
 * `export { … }` clause elsewhere — see isExportClauseLine), so only positive
 * evidence is returned there. Go capitalization is a language rule, so both
 * directions are safe; explicit keywords outrank the underscore convention.
 */
export function detectDeclaredPublic(
  languageId: string,
  declLine: string,
  name: string,
): boolean | undefined {
  if (languageId === 'go') {
    if (name === 'main' || name === 'init') {
      return true; // runtime-invoked entries the reference provider cannot see
    }
    return /^[A-Z]/.test(name);
  }
  if (EXPORT_KEYWORD_LANGUAGES.has(languageId) && /(^|\s)export\s/.test(declLine)) {
    return true;
  }
  if (languageId === 'rust' && /(^|\s)pub[\s(]/.test(declLine)) {
    return true;
  }
  if (name.startsWith('_')) {
    return false;
  }
  return undefined;
}

/**
 * A same-file reference sitting on one of these lines is not an internal
 * caller — it is the file publishing the symbol (`export { foo }`,
 * `export default foo`, Python's `__all__`). Such a reference counts as
 * declared-public evidence instead of an internal ref.
 */
export function isExportClauseLine(languageId: string, lineText: string): boolean {
  if (EXPORT_KEYWORD_LANGUAGES.has(languageId)) {
    return /^\s*export[\s{]/.test(lineText);
  }
  if (languageId === 'python') {
    return /^\s*__all__\s*[=+]/.test(lineText);
  }
  return false;
}

/**
 * Whether the declaration line is an import statement. Imported names must
 * not be classified by their references (those belong to the original
 * symbol), and skipping them also skips their workspace-wide reference
 * query. Rust's `pub use` deliberately doesn't match: it re-publishes.
 */
export function isImportLine(languageId: string, lineText: string): boolean {
  if (EXPORT_KEYWORD_LANGUAGES.has(languageId)) {
    return /^\s*import[\s{("']/.test(lineText) || /\brequire\s*\(/.test(lineText);
  }
  if (languageId === 'python') {
    return /^\s*(import|from)\s/.test(lineText);
  }
  if (languageId === 'rust') {
    return /^\s*use\s/.test(lineText);
  }
  if (languageId === 'csharp') {
    return /^\s*using\s/.test(lineText);
  }
  return /^\s*import\s/.test(lineText);
}

/**
 * Statically collects the names a file re-publishes: local names in
 * `export { … }` clauses (`export { x } from '…'` excluded — those never
 * surface as document symbols) and Python `__all__` entries. An imported
 * name on this list is a deliberate entry of the module (barrel files,
 * `__init__.py`); any other symbol on it is declared public.
 */
export function parseExportedNames(languageId: string, text: string): Set<string> {
  const names = new Set<string>();
  if (EXPORT_KEYWORD_LANGUAGES.has(languageId)) {
    for (const m of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from\b)/g)) {
      for (const raw of m[1].split(',')) {
        const local = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (local) {
          names.add(local);
        }
      }
    }
  } else if (languageId === 'python') {
    for (const m of text.matchAll(/__all__\s*(?:=|\+=)\s*[[(]([^\])]*)[\])]/g)) {
      for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
        names.add(q[1]);
      }
    }
  }
  return names;
}
