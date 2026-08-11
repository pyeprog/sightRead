import * as assert from 'assert';
import {
  EditChange,
  FileMarks,
  Mark,
  accentFromKey,
  accentKey,
  addGuide,
  applyChange,
  applyChanges,
  applyChangesToFile,
  guideEnvelope,
  guideMarks,
  insertMark,
  markVisible,
  marksAtLine,
  marksInLineRange,
  removeMark,
  removeMarksInRange,
} from '../../core/marks';

function mark(startLine: number, endLine: number, id = 'm1'): Mark {
  return { id, accent: { kind: 'color', color: 'yellow' }, startLine, endLine };
}

function step(startLine: number, endLine: number, id: string, guideId = 'g1', order = 0): Mark {
  return {
    id,
    accent: { kind: 'role', role: 'main' },
    note: `note ${id}`,
    guideId,
    order,
    startLine,
    endLine,
  };
}

function state(marks: Mark[], guideIds: string[] = []): FileMarks {
  return {
    marks,
    guides: guideIds.map((id) => ({ id, subject: 'fn', unit: 'function' as const })),
  };
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

suite('marks: applyChange', () => {
  test('insertion above shifts the mark down', () => {
    const r = applyChange([mark(2, 4)], change(0, 0, 0, 0, 2));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [4, 6]);
    assert.strictEqual(r.changed, true);
  });

  test('deletion above shifts the mark up', () => {
    const r = applyChange([mark(2, 4)], change(0, 0, 2, 0, 0));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [0, 2]);
  });

  test('edit below leaves the mark untouched', () => {
    const r = applyChange([mark(2, 4)], change(5, 0, 5, 3, 0));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [2, 4]);
    assert.strictEqual(r.changed, false);
  });

  test('typing inside the marked lines deletes the mark', () => {
    const r = applyChange([mark(2, 4)], change(3, 5, 3, 5, 0));
    assert.strictEqual(r.items.length, 0);
    assert.strictEqual(r.removed.length, 1);
  });

  test('typing at the end of the last marked line deletes the mark', () => {
    const r = applyChange([mark(2, 4)], change(4, 10, 4, 10, 0));
    assert.strictEqual(r.items.length, 0);
  });

  test('pure insertion at column 0 of the first marked line shifts instead of deleting', () => {
    const r = applyChange([mark(2, 4)], change(2, 0, 2, 0, 1));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [3, 5]);
  });

  test('insertion at column 0 right after the mark leaves it untouched', () => {
    const r = applyChange([mark(2, 4)], change(5, 0, 5, 0, 1));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [2, 4]);
  });

  test('deletion spanning the mark deletes it', () => {
    const r = applyChange([mark(2, 4)], change(1, 0, 5, 0, 0));
    assert.strictEqual(r.items.length, 0);
  });

  test('same-line edit above the mark without newline change is a no-op', () => {
    const r = applyChange([mark(2, 4)], change(1, 0, 1, 4, 0));
    assert.deepStrictEqual([r.items[0].startLine, r.items[0].endLine], [2, 4]);
    assert.strictEqual(r.changed, false);
  });
});

suite('marks: applyChanges (multi-change events)', () => {
  test('applies changes bottom-up so earlier shifts do not corrupt later ones', () => {
    const ms = [mark(2, 3, 'a'), mark(10, 11, 'b')];
    // one edit event: insert a line at line 0 and another at line 6
    const r = applyChanges(ms, [change(0, 0, 0, 0, 1), change(6, 0, 6, 0, 1)]);
    const byId = new Map(r.items.map((m) => [m.id, m]));
    assert.deepStrictEqual([byId.get('a')!.startLine, byId.get('a')!.endLine], [3, 4]);
    assert.deepStrictEqual([byId.get('b')!.startLine, byId.get('b')!.endLine], [12, 13]);
  });
});

suite('marks: accent keys and visibility', () => {
  test('accentKey normalizes colors, roles and untagged', () => {
    assert.strictEqual(accentKey({ kind: 'color', color: 'yellow' }), 'color:yellow');
    assert.strictEqual(accentKey({ kind: 'role', role: ' Setup ' }), 'role:setup');
    assert.strictEqual(accentKey({ kind: 'role', role: undefined }), 'role:');
  });

  test('accentFromKey inverts accentKey', () => {
    assert.deepStrictEqual(accentFromKey('color:red'), { kind: 'color', color: 'red' });
    assert.deepStrictEqual(accentFromKey('role:main'), { kind: 'role', role: 'main' });
    assert.deepStrictEqual(accentFromKey('role:'), { kind: 'role', role: undefined });
  });

  test('markVisible honors hidden color and role keys', () => {
    const hidden = new Set(['color:yellow', 'role:entity']);
    assert.strictEqual(markVisible({ kind: 'color', color: 'yellow' }, hidden), false);
    assert.strictEqual(markVisible({ kind: 'color', color: 'red' }, hidden), true);
    assert.strictEqual(markVisible({ kind: 'role', role: 'Entity' }, hidden), false);
    assert.strictEqual(markVisible({ kind: 'role', role: 'main' }, hidden), true);
  });

  test('untagged steps filter through the empty role key', () => {
    assert.strictEqual(markVisible({ kind: 'role' }, new Set(['role:'])), false);
    assert.strictEqual(markVisible({ kind: 'role' }, new Set()), true);
  });
});

suite('marks: insert/remove on FileMarks', () => {
  test('insertMark swallows intersecting loose color marks only', () => {
    const s = state([mark(2, 4, 'old'), mark(8, 9, 'far'), step(3, 5, 's1')], ['g1']);
    const r = insertMark(s, mark(4, 6, 'new'));
    assert.deepStrictEqual(
      r.marks.map((m) => m.id),
      ['s1', 'new', 'far'],
      'the loose intersecting mark is swallowed, the guide step survives',
    );
    assert.strictEqual(r.guides.length, 1);
  });

  test('removeMark prunes the guide shell with its last mark', () => {
    const s = state([step(2, 3, 's1'), mark(5, 6, 'loose')], ['g1']);
    const r = removeMark(s, 's1');
    assert.deepStrictEqual(r.marks.map((m) => m.id), ['loose']);
    assert.deepStrictEqual(r.guides, []);
  });

  test('removeMarksInRange removes steps and loose marks alike, pruning shells', () => {
    const s = state(
      [mark(0, 1, 'a'), step(3, 5, 's1', 'g1', 0), step(8, 9, 's2', 'g1', 1)],
      ['g1'],
    );
    const r = removeMarksInRange(s, 3, 5);
    assert.deepStrictEqual(r.marks.map((m) => m.id), ['a', 's2']);
    assert.strictEqual(r.guides.length, 1, 'the shell keeps living through its other step');
    const r2 = removeMarksInRange(r, 8, 9);
    assert.deepStrictEqual(r2.guides, [], 'the shell dies with its last step');
  });

  test('marksAtLine and marksInLineRange work over the flat list', () => {
    const ms = [mark(0, 1, 'a'), mark(3, 5, 'b'), step(7, 8, 'c')];
    assert.deepStrictEqual(marksAtLine(ms, 4).map((m) => m.id), ['b']);
    assert.deepStrictEqual(marksAtLine(ms, 2), []);
    assert.deepStrictEqual(marksInLineRange(ms, 4, 7).map((m) => m.id), ['b', 'c']);
    assert.deepStrictEqual(marksInLineRange(ms, 2, 2), []);
  });
});

suite('marks: guides', () => {
  test('guideMarks returns steps in reading order, guideEnvelope spans them', () => {
    const s = state([step(8, 9, 's2', 'g1', 1), step(2, 4, 's1', 'g1', 0)], ['g1']);
    assert.deepStrictEqual(guideMarks(s, 'g1').map((m) => m.id), ['s1', 's2']);
    assert.deepStrictEqual(guideEnvelope(s, 'g1'), { startLine: 2, endLine: 9 });
    assert.strictEqual(guideEnvelope(s, 'missing'), undefined);
  });

  test('addGuide replaces guides with intersecting envelopes, keeps loose marks', () => {
    const s = state([mark(3, 3, 'loose'), step(2, 4, 'old1', 'gOld', 0)], ['gOld']);
    const r = addGuide(
      s,
      { id: 'gNew', subject: 'fn', unit: 'function' },
      [step(3, 5, 'new1', 'gNew', 0)],
    );
    assert.deepStrictEqual(r.guides.map((g) => g.id), ['gNew']);
    assert.deepStrictEqual(r.marks.map((m) => m.id), ['loose', 'new1']);
  });

  test('addGuide keeps disjoint guides', () => {
    const s = state([step(20, 22, 'far1', 'gFar', 0)], ['gFar']);
    const r = addGuide(
      s,
      { id: 'gNew', subject: 'fn', unit: 'function' },
      [step(2, 4, 'new1', 'gNew', 0)],
    );
    assert.deepStrictEqual(r.guides.map((g) => g.id).sort(), ['gFar', 'gNew']);
  });
});

suite('marks: applyChangesToFile', () => {
  test('shifts untouched marks and deletes touched ones per mark', () => {
    const s = state([step(10, 12, 's1', 'g1', 0), step(17, 18, 's2', 'g1', 1)], ['g1']);
    // an edit inside s1 kills s1 only; s2 stays put (edit above it has no newline delta)
    const r = applyChangesToFile(s, [change(11, 0, 11, 3, 0)]);
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(r.state.marks.map((m) => m.id), ['s2']);
    assert.strictEqual(r.state.guides.length, 1, 'the guide survives with one step');
  });

  test('edit above shifts a guide step by the delta', () => {
    const s = state([step(10, 12, 's1')], ['g1']);
    const r = applyChangesToFile(s, [change(0, 0, 0, 0, 2)]);
    assert.deepStrictEqual(
      [r.state.marks[0].startLine, r.state.marks[0].endLine],
      [12, 14],
    );
  });

  test('prunes a shell when its last mark dies', () => {
    const s = state([step(10, 12, 's1')], ['g1']);
    const r = applyChangesToFile(s, [change(11, 0, 11, 2, 0)]);
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(r.state.marks, []);
    assert.deepStrictEqual(r.state.guides, []);
  });

  test('no-op edits report changed=false and keep the same state', () => {
    const s = state([mark(2, 4)]);
    const r = applyChangesToFile(s, [change(6, 0, 6, 2, 0)]);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.state, s);
  });
});
