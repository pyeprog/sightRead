import * as assert from 'assert';
import {
  EditChange,
  Marker,
  applyChange,
  applyChanges,
  insertMarker,
  markersAtLine,
  markersInLineRange,
  removeInLineRange,
} from '../../core/markers';

function marker(startLine: number, endLine: number, id = 'm1'): Marker {
  return { id, color: 'yellow', startLine, endLine };
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

suite('markers: applyChange', () => {
  test('insertion above shifts the marker down', () => {
    const r = applyChange([marker(2, 4)], change(0, 0, 0, 0, 2));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [4, 6]);
    assert.strictEqual(r.changed, true);
  });

  test('deletion above shifts the marker up', () => {
    const r = applyChange([marker(2, 4)], change(0, 0, 2, 0, 0));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [0, 2]);
  });

  test('edit below leaves the marker untouched', () => {
    const r = applyChange([marker(2, 4)], change(5, 0, 5, 3, 0));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [2, 4]);
    assert.strictEqual(r.changed, false);
  });

  test('typing inside the marked lines deletes the marker', () => {
    const r = applyChange([marker(2, 4)], change(3, 5, 3, 5, 0));
    assert.strictEqual(r.markers.length, 0);
    assert.strictEqual(r.removed.length, 1);
  });

  test('typing at the end of the last marked line deletes the marker', () => {
    const r = applyChange([marker(2, 4)], change(4, 10, 4, 10, 0));
    assert.strictEqual(r.markers.length, 0);
  });

  test('pure insertion at column 0 of the first marked line shifts instead of deleting', () => {
    const r = applyChange([marker(2, 4)], change(2, 0, 2, 0, 1));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [3, 5]);
  });

  test('insertion at column 0 right after the marker leaves it untouched', () => {
    const r = applyChange([marker(2, 4)], change(5, 0, 5, 0, 1));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [2, 4]);
  });

  test('deletion spanning the marker deletes it', () => {
    const r = applyChange([marker(2, 4)], change(1, 0, 5, 0, 0));
    assert.strictEqual(r.markers.length, 0);
  });

  test('same-line edit above the marker without newline change is a no-op', () => {
    const r = applyChange([marker(2, 4)], change(1, 0, 1, 4, 0));
    assert.deepStrictEqual([r.markers[0].startLine, r.markers[0].endLine], [2, 4]);
    assert.strictEqual(r.changed, false);
  });
});

suite('markers: applyChanges (multi-change events)', () => {
  test('applies changes bottom-up so earlier shifts do not corrupt later ones', () => {
    const ms = [marker(2, 3, 'a'), marker(10, 11, 'b')];
    // one edit event: insert a line at line 0 and another at line 6
    const r = applyChanges(ms, [change(0, 0, 0, 0, 1), change(6, 0, 6, 0, 1)]);
    const byId = new Map(r.markers.map((m) => [m.id, m]));
    assert.deepStrictEqual([byId.get('a')!.startLine, byId.get('a')!.endLine], [3, 4]);
    assert.deepStrictEqual([byId.get('b')!.startLine, byId.get('b')!.endLine], [12, 13]);
  });
});

suite('markers: insert/remove helpers', () => {
  test('insertMarker swallows intersecting markers', () => {
    const existing = [marker(2, 4, 'old'), marker(8, 9, 'far')];
    const r = insertMarker(existing, marker(4, 6, 'new'));
    assert.deepStrictEqual(r.replaced.map((m) => m.id), ['old']);
    assert.deepStrictEqual(r.markers.map((m) => m.id), ['new', 'far']);
  });

  test('removeInLineRange removes exactly the intersecting markers', () => {
    const ms = [marker(0, 1, 'a'), marker(3, 5, 'b'), marker(7, 8, 'c')];
    const r = removeInLineRange(ms, 4, 7);
    assert.deepStrictEqual(r.markers.map((m) => m.id), ['a']);
    assert.deepStrictEqual(r.removed.map((m) => m.id), ['b', 'c']);
  });

  test('markersAtLine', () => {
    const ms = [marker(0, 1, 'a'), marker(3, 5, 'b')];
    assert.deepStrictEqual(markersAtLine(ms, 4).map((m) => m.id), ['b']);
    assert.deepStrictEqual(markersAtLine(ms, 2), []);
  });

  test('markersInLineRange keeps partial overlaps and drops the rest', () => {
    const ms = [marker(0, 1, 'a'), marker(3, 5, 'b'), marker(7, 8, 'c')];
    assert.deepStrictEqual(markersInLineRange(ms, 4, 7).map((m) => m.id), ['b', 'c']);
    assert.deepStrictEqual(markersInLineRange(ms, 2, 2), []);
    assert.deepStrictEqual(markersInLineRange(ms, 1, 3).map((m) => m.id), ['a', 'b']);
  });
});
