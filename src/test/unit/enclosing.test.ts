import * as assert from 'assert';
import {
  EnclosingCandidate,
  chooseEnclosingFunction,
  chooseOutermostFunction,
} from '../../core/enclosing';

interface Named extends EnclosingCandidate {
  name: string;
}

function c(name: string, startLine: number, endLine: number, fnKind = true): Named {
  return { name, startLine, endLine, fnKind };
}

suite('enclosing: chooseEnclosingFunction', () => {
  test('empty candidates → undefined', () => {
    assert.strictEqual(chooseEnclosingFunction([], 5), undefined);
  });

  test('innermost function-kind wins when the cursor is inside a nested body', () => {
    const outer = c('outer', 0, 9);
    const inner = c('inner', 3, 5);
    assert.strictEqual(chooseEnclosingFunction([outer, inner], 4)?.name, 'inner');
  });

  test('a larger function-kind beats a smaller non-function candidate', () => {
    const fn = c('fn', 0, 9);
    const variable = c('v', 2, 4, false);
    assert.strictEqual(chooseEnclosingFunction([fn, variable], 3)?.name, 'fn');
  });

  test('falls back to the innermost any-kind candidate without function kinds', () => {
    const mod = c('mod', 0, 20, false);
    const arrow = c('arrow', 3, 8, false);
    assert.strictEqual(chooseEnclosingFunction([mod, arrow], 5)?.name, 'arrow');
  });

  test('cursor on a nested definition header yields to the enclosing function', () => {
    const outer = c('outer', 0, 9);
    const inner = c('inner', 3, 5);
    assert.strictEqual(chooseEnclosingFunction([outer, inner], 3)?.name, 'outer');
  });

  test('cursor on a nested header yields to a non-function enclosing scope', () => {
    const outerArrow = c('outerArrow', 0, 9, false);
    const inner = c('inner', 3, 5);
    assert.strictEqual(chooseEnclosingFunction([outerArrow, inner], 3)?.name, 'outerArrow');
  });

  test('every candidate starting at the cursor line yields together', () => {
    // `const f = () => {` often surfaces as a Variable AND a Function child,
    // both starting on the header line.
    const outer = c('outer', 0, 12);
    const fVar = c('f', 4, 8, false);
    const fFn = c('f', 4, 8);
    assert.strictEqual(chooseEnclosingFunction([outer, fVar, fFn], 4)?.name, 'outer');
  });

  test('a top-level header with nothing to yield to keeps itself', () => {
    const only = c('only', 3, 9);
    assert.strictEqual(chooseEnclosingFunction([only], 3)?.name, 'only');
  });

  test('deeper nesting yields exactly one level up from the header', () => {
    const outer = c('outer', 0, 20);
    const mid = c('mid', 2, 15);
    const inner = c('inner', 5, 8);
    assert.strictEqual(chooseEnclosingFunction([outer, mid, inner], 5)?.name, 'mid');
  });
});

suite('enclosing: chooseOutermostFunction', () => {
  test('empty candidates → undefined', () => {
    assert.strictEqual(chooseOutermostFunction([]), undefined);
  });

  test('widest function-kind wins over nested ones', () => {
    const outer = c('outer', 0, 20);
    const mid = c('mid', 2, 15);
    const inner = c('inner', 5, 8);
    assert.strictEqual(chooseOutermostFunction([inner, mid, outer])?.name, 'outer');
  });

  test('never widens past a function: a wider non-function wrapper loses', () => {
    const klass = c('Klass', 0, 40, false);
    const method = c('method', 3, 20);
    assert.strictEqual(chooseOutermostFunction([klass, method])?.name, 'method');
  });

  test('falls back to the widest any-kind candidate without function kinds', () => {
    const outerArrow = c('outerArrow', 0, 20, false);
    const innerArrow = c('innerArrow', 3, 8, false);
    assert.strictEqual(chooseOutermostFunction([innerArrow, outerArrow])?.name, 'outerArrow');
  });
});
