import * as assert from 'assert';
import {
  classifyEntry,
  detectDeclaredPublic,
  isExportClauseLine,
  isImportLine,
  parseExportedNames,
} from '../../core/entries';

suite('entries: classifyEntry', () => {
  test('external refs only → entry', () => {
    assert.strictEqual(classifyEntry({ externalRefs: 3, internalRefs: 0 }), 'entry');
  });

  test('external AND internal refs → still an entry (wrapped by a more abstract entry)', () => {
    assert.strictEqual(classifyEntry({ externalRefs: 1, internalRefs: 5 }), 'entry');
  });

  test('internal refs only → hidden', () => {
    assert.strictEqual(classifyEntry({ externalRefs: 0, internalRefs: 2 }), 'hidden');
  });

  test('no refs at all, syntax silent → suspected', () => {
    assert.strictEqual(classifyEntry({ externalRefs: 0, internalRefs: 0 }), 'suspected');
  });

  test('no refs but declared public → promoted to entry (framework hooks, unused API)', () => {
    assert.strictEqual(
      classifyEntry({ externalRefs: 0, internalRefs: 0, declaredPublic: true }),
      'entry',
    );
  });

  test('no refs and declared private → hidden', () => {
    assert.strictEqual(
      classifyEntry({ externalRefs: 0, internalRefs: 0, declaredPublic: false }),
      'hidden',
    );
  });

  test('usage outranks syntax: externally referenced private name is an entry', () => {
    assert.strictEqual(
      classifyEntry({ externalRefs: 1, internalRefs: 0, declaredPublic: false }),
      'entry',
    );
  });

  test('usage outranks syntax: internally-only referenced exported name is hidden', () => {
    // declaredPublic never overrides usage; the export clause case is handled
    // upstream by isExportClauseLine before internal refs are counted.
    assert.strictEqual(
      classifyEntry({ externalRefs: 0, internalRefs: 3, declaredPublic: true }),
      'hidden',
    );
  });

  test('alias: reference counts are meaningless — external refs do NOT make an import an entry', () => {
    assert.strictEqual(
      classifyEntry({ externalRefs: 7, internalRefs: 2, alias: true }),
      'hidden',
    );
  });

  test('alias re-published by this file → entry (barrel files, __init__.py)', () => {
    assert.strictEqual(
      classifyEntry({ externalRefs: 0, internalRefs: 0, alias: true, declaredPublic: true }),
      'entry',
    );
  });
});

suite('entries: detectDeclaredPublic', () => {
  test('typescript export keyword → public', () => {
    assert.strictEqual(
      detectDeclaredPublic('typescript', 'export function foo() {', 'foo'),
      true,
    );
    assert.strictEqual(
      detectDeclaredPublic('typescript', 'export default class Bar {', 'Bar'),
      true,
    );
  });

  test('typescript without export keyword → unknown (may be re-exported elsewhere)', () => {
    assert.strictEqual(
      detectDeclaredPublic('typescript', 'function foo() {', 'foo'),
      undefined,
    );
  });

  test('export keyword outranks the underscore convention', () => {
    assert.strictEqual(
      detectDeclaredPublic('typescript', 'export function _internal() {', '_internal'),
      true,
    );
  });

  test('underscore prefix → private', () => {
    assert.strictEqual(detectDeclaredPublic('python', 'def _helper():', '_helper'), false);
    assert.strictEqual(
      detectDeclaredPublic('javascript', 'function _hidden() {', '_hidden'),
      false,
    );
  });

  test('go capitalization is decisive in both directions', () => {
    assert.strictEqual(detectDeclaredPublic('go', 'func Public() {', 'Public'), true);
    assert.strictEqual(detectDeclaredPublic('go', 'func private() {', 'private'), false);
    assert.strictEqual(detectDeclaredPublic('go', 'func _x() {', '_x'), false);
  });

  test('go main/init are runtime-invoked entries', () => {
    assert.strictEqual(detectDeclaredPublic('go', 'func main() {', 'main'), true);
    assert.strictEqual(detectDeclaredPublic('go', 'func init() {', 'init'), true);
  });

  test('rust pub keyword → public, absence → unknown', () => {
    assert.strictEqual(detectDeclaredPublic('rust', 'pub fn run() {', 'run'), true);
    assert.strictEqual(detectDeclaredPublic('rust', 'pub(crate) fn run() {', 'run'), true);
    assert.strictEqual(detectDeclaredPublic('rust', 'fn run() {', 'run'), undefined);
  });

  test('unknown language, plain name → unknown', () => {
    assert.strictEqual(detectDeclaredPublic('ruby', 'def call', 'call'), undefined);
  });
});

suite('entries: isExportClauseLine', () => {
  test('typescript export clauses publish rather than call', () => {
    assert.strictEqual(isExportClauseLine('typescript', 'export { foo, bar };'), true);
    assert.strictEqual(isExportClauseLine('typescript', 'export default foo;'), true);
    assert.strictEqual(isExportClauseLine('typescript', '  foo();'), false);
  });

  test('python __all__ publishes', () => {
    assert.strictEqual(isExportClauseLine('python', "__all__ = ['foo']"), true);
    assert.strictEqual(isExportClauseLine('python', "__all__ += ['bar']"), true);
    assert.strictEqual(isExportClauseLine('python', 'foo()'), false);
  });

  test('languages without an export clause concept → never', () => {
    assert.strictEqual(isExportClauseLine('go', 'export { foo }'), false);
  });
});

suite('entries: isImportLine', () => {
  test('javascript/typescript import forms', () => {
    assert.strictEqual(isImportLine('typescript', "import { a } from './x';"), true);
    assert.strictEqual(isImportLine('typescript', "import * as vscode from 'vscode';"), true);
    assert.strictEqual(isImportLine('typescript', "import './side-effect';"), true);
    assert.strictEqual(isImportLine('javascript', "const fs = require('fs');"), true);
  });

  test('declarations are not imports', () => {
    assert.strictEqual(isImportLine('typescript', 'export function foo() {'), false);
    assert.strictEqual(isImportLine('typescript', 'const importantThing = 1;'), false);
    assert.strictEqual(isImportLine('javascript', 'const x = required();'), false);
  });

  test('python import and from-import', () => {
    assert.strictEqual(isImportLine('python', 'import os'), true);
    assert.strictEqual(isImportLine('python', 'from x import foo'), true);
    assert.strictEqual(isImportLine('python', 'def frombar():'), false);
  });

  test('rust use is an import, pub use is a re-publication', () => {
    assert.strictEqual(isImportLine('rust', 'use std::io;'), true);
    assert.strictEqual(isImportLine('rust', 'pub use crate::api::Client;'), false);
  });

  test('csharp using, java import', () => {
    assert.strictEqual(isImportLine('csharp', 'using System.IO;'), true);
    assert.strictEqual(isImportLine('java', 'import java.util.List;'), true);
  });
});

suite('entries: parseExportedNames', () => {
  test('typescript export clause, with as-renames and type re-exports', () => {
    const names = parseExportedNames(
      'typescript',
      "function foo() {}\nconst bar = 1;\nexport { foo, bar as baz, type Qux };\n",
    );
    assert.deepStrictEqual([...names].sort(), ['bar', 'foo', 'Qux'].sort());
  });

  test('export { … } from another module is not a local name', () => {
    const names = parseExportedNames('typescript', "export { thing } from './other';\n");
    assert.strictEqual(names.size, 0);
  });

  test('multi-line export clause', () => {
    const names = parseExportedNames('typescript', 'export {\n  alpha,\n  beta,\n};\n');
    assert.deepStrictEqual([...names].sort(), ['alpha', 'beta']);
  });

  test('python __all__, including += and multi-line lists', () => {
    const names = parseExportedNames(
      'python',
      "__all__ = [\n    'foo',\n    \"bar\",\n]\n__all__ += ['baz']\n",
    );
    assert.deepStrictEqual([...names].sort(), ['bar', 'baz', 'foo']);
  });

  test('languages without static export clauses → empty', () => {
    assert.strictEqual(parseExportedNames('go', 'export { foo }').size, 0);
  });
});
