import * as assert from 'assert';
import { Guide, GuideStep, adjacentStep, applyChangesToGuides, guideAtLine } from '../../core/guide';
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

suite('guide: navigation helpers', () => {
  // reading order deliberately differs from line order
  const g = guide(0, 50, [step(30, 32, 'first'), step(10, 12, 'second')]);

  test('adjacentStep follows array order, not line order', () => {
    assert.strictEqual(adjacentStep(g, 31, 1)?.id, 'second');
    assert.strictEqual(adjacentStep(g, 11, -1)?.id, 'first');
  });

  test('adjacentStep is undefined past either end of the reading order', () => {
    assert.strictEqual(adjacentStep(g, 11, 1), undefined);
    assert.strictEqual(adjacentStep(g, 31, -1), undefined);
  });

  test('adjacentStep outside every step enters at the first or last step', () => {
    assert.strictEqual(adjacentStep(g, 45, 1)?.id, 'first');
    assert.strictEqual(adjacentStep(g, 45, -1)?.id, 'second');
  });

  test('guideAtLine finds the guide spanning the line', () => {
    assert.strictEqual(guideAtLine([g], 40)?.id, 'g1');
    assert.strictEqual(guideAtLine([g], 51), undefined);
  });
});
