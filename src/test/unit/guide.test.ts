import * as assert from 'assert';
import {
  Guide,
  GuideStep,
  applyChangesToGuides,
  roleKey,
  stepVisible,
  stepsInLineRange,
} from '../../core/guide';
import { EditChange } from '../../core/markers';

function step(startLine: number, endLine: number, id: string): GuideStep {
  return { id, startLine, endLine, note: `note ${id}` };
}

function guide(startLine: number, endLine: number, steps: GuideStep[]): Guide {
  return { id: 'g1', subject: 'fn', unit: 'function', startLine, endLine, steps };
}

function change(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  insertedNewlines: number,
): EditChange {
  return { startLine, startChar, endLine, endChar, insertedNewlines };
}

suite('guide: applyChangesToGuides', () => {
  test('edit above the function shifts the guide and all steps by the delta', () => {
    const g = guide(10, 20, [step(12, 14, 'a'), step(17, 18, 'b')]);
    const r = applyChangesToGuides([g], [change(0, 0, 0, 0, 2)]);
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual([r.guides[0].startLine, r.guides[0].endLine], [12, 22]);
    assert.deepStrictEqual(
      r.guides[0].steps.map((s) => [s.startLine, s.endLine]),
      [
        [14, 16],
        [19, 20],
      ],
    );
  });

  test('edit inside the function range removes the whole guide', () => {
    const g = guide(10, 20, [step(12, 14, 'a')]);
    const r = applyChangesToGuides([g], [change(19, 0, 19, 3, 0)]);
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(r.guides, []);
  });

  test('edit below the function leaves the guide untouched', () => {
    const g = guide(10, 20, [step(12, 14, 'a')]);
    const r = applyChangesToGuides([g], [change(25, 0, 25, 4, 1)]);
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual([r.guides[0].startLine, r.guides[0].steps[0].startLine], [10, 12]);
  });
});

suite('guide: stepsInLineRange', () => {
  test('returns intersecting steps across guides, ascending by startLine', () => {
    const a = guide(10, 20, [step(12, 14, 'a'), step(18, 19, 'b')]);
    const b = guide(30, 40, [step(31, 33, 'c')]);
    assert.deepStrictEqual(
      stepsInLineRange([b, a], 13, 32).map((s) => s.id),
      ['a', 'b', 'c'],
    );
  });

  test('partial overlap counts; disjoint ranges return nothing', () => {
    const g = guide(10, 20, [step(12, 14, 'a')]);
    assert.deepStrictEqual(
      stepsInLineRange([g], 14, 30).map((s) => s.id),
      ['a'],
    );
    assert.deepStrictEqual(stepsInLineRange([g], 15, 30), []);
  });
});

suite('guide: step visibility filter', () => {
  test('empty hidden set shows every step', () => {
    assert.strictEqual(stepVisible('entity', new Set()), true);
    assert.strictEqual(stepVisible(undefined, new Set()), true);
  });

  test('hiding matches the role tag case-insensitively', () => {
    const hidden = new Set(['entity']);
    assert.strictEqual(stepVisible('Entity', hidden), false);
    assert.strictEqual(stepVisible('main', hidden), true);
  });

  test('untagged steps filter through the empty key', () => {
    assert.strictEqual(roleKey(undefined), '');
    assert.strictEqual(roleKey(' Setup '), 'setup');
    assert.strictEqual(stepVisible(undefined, new Set([''])), false);
  });
});
