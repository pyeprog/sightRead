import * as assert from 'assert';
import {
  computeFocus,
  intersectsAny,
  mergeLineRanges,
  pathToLine,
  rangeContaining,
  subtractRangeList,
  subtractRanges,
} from '../../core/focus';
import { SegmentNode } from '../../core/segmentation';

function n(start: number, end: number, children: SegmentNode[] = []): SegmentNode {
  return { startLine: start, endLine: end, name: '', kind: 'other', children };
}

suite('focus: line-range algebra', () => {
  test('mergeLineRanges merges overlapping and adjacent ranges', () => {
    assert.deepStrictEqual(
      mergeLineRanges([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
      ]),
      [{ start: 1, end: 7 }],
    );
    assert.deepStrictEqual(
      mergeLineRanges([
        { start: 1, end: 2 },
        { start: 4, end: 5 },
      ]),
      [
        { start: 1, end: 2 },
        { start: 4, end: 5 },
      ],
    );
  });

  test('subtractRanges', () => {
    assert.deepStrictEqual(
      subtractRanges({ start: 0, end: 10 }, [
        { start: 3, end: 4 },
        { start: 8, end: 8 },
      ]),
      [
        { start: 0, end: 2 },
        { start: 5, end: 7 },
        { start: 9, end: 10 },
      ],
    );
    assert.deepStrictEqual(subtractRanges({ start: 0, end: 10 }, [{ start: 0, end: 10 }]), []);
    assert.deepStrictEqual(subtractRanges({ start: 0, end: 10 }, []), [{ start: 0, end: 10 }]);
  });

  test('subtractRangeList', () => {
    assert.deepStrictEqual(
      subtractRangeList(
        [
          { start: 0, end: 4 },
          { start: 8, end: 9 },
        ],
        [{ start: 2, end: 8 }],
      ),
      [
        { start: 0, end: 1 },
        { start: 9, end: 9 },
      ],
    );
  });

  test('rangeContaining / intersectsAny', () => {
    const ranges = [
      { start: 1, end: 3 },
      { start: 6, end: 9 },
    ];
    assert.deepStrictEqual(rangeContaining(ranges, 7), { start: 6, end: 9 });
    assert.strictEqual(rangeContaining(ranges, 4), undefined);
    assert.strictEqual(intersectsAny({ start: 3, end: 5 }, ranges), true);
    assert.strictEqual(intersectsAny({ start: 4, end: 5 }, ranges), false);
  });
});

suite('focus: computeFocus over the segment tree', () => {
  const fn = { start: 10, end: 30 };
  //  n(12,14)
  //  n(16,24) ── n(17,18)
  //           └─ n(20,23) ── n(21,22)
  //  n(26,28)
  const tree = [n(12, 14), n(16, 24, [n(17, 18), n(20, 23, [n(21, 22)])]), n(26, 28)];

  test('pathToLine finds the ancestor chain', () => {
    assert.deepStrictEqual(
      pathToLine(tree, 21).map((x) => [x.startLine, x.endLine]),
      [
        [16, 24],
        [20, 23],
        [21, 22],
      ],
    );
    assert.deepStrictEqual(pathToLine(tree, 15), []);
  });

  test('level 0 lights nothing', () => {
    assert.deepStrictEqual(computeFocus(0, fn, tree, 13, []), { lit: [], light: [] });
  });

  test('level 1 lights the whole function', () => {
    assert.deepStrictEqual(computeFocus(1, fn, tree, 13, []), { lit: [fn], light: [] });
  });

  test('level 2: cursor on a top-level node lights it; siblings get the light tier', () => {
    assert.deepStrictEqual(computeFocus(2, fn, tree, 13, []), {
      lit: [
        { start: 10, end: 10 },
        { start: 12, end: 14 },
      ],
      light: [
        { start: 16, end: 24 },
        { start: 26, end: 28 },
      ],
    });
  });

  test('level 2: cursor on a nested node lights it + ancestor headers; siblings are its tree siblings', () => {
    assert.deepStrictEqual(computeFocus(2, fn, tree, 17, []), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 18 },
      ],
      light: [{ start: 20, end: 23 }],
    });
  });

  test('level 2: deep leaf with no siblings gets an empty light tier', () => {
    assert.deepStrictEqual(computeFocus(2, fn, tree, 21, []), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 16 },
        { start: 20, end: 22 },
      ],
      light: [],
    });
  });

  test('level 2: cursor in a gap inside a node focuses that node', () => {
    assert.deepStrictEqual(computeFocus(2, fn, tree, 19, []), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 24 },
      ],
      light: [
        { start: 12, end: 14 },
        { start: 26, end: 28 },
      ],
    });
  });

  test('level 2 degrades to whole function in a top-level gap or without a tree', () => {
    assert.deepStrictEqual(computeFocus(2, fn, tree, 15, []), { lit: [fn], light: [] });
    assert.deepStrictEqual(computeFocus(2, fn, [], 17, []), { lit: [fn], light: [] });
  });

  test('level 3 additionally lights the deepest node containing each occurrence', () => {
    assert.deepStrictEqual(computeFocus(3, fn, tree, 17, [27]), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 18 },
        { start: 26, end: 28 },
      ],
      light: [{ start: 20, end: 23 }],
    });
  });

  test('level 3: an occurrence inside a sibling subtree carves the light tier', () => {
    assert.deepStrictEqual(computeFocus(3, fn, tree, 17, [21]), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 18 },
        { start: 21, end: 22 },
      ],
      light: [
        { start: 20, end: 20 },
        { start: 23, end: 23 },
      ],
    });
  });

  test('level 3 ignores occurrences outside any segment', () => {
    assert.deepStrictEqual(computeFocus(3, fn, tree, 17, [15, 29]), {
      lit: [
        { start: 10, end: 10 },
        { start: 16, end: 18 },
      ],
      light: [{ start: 20, end: 23 }],
    });
  });
});
