import * as assert from 'assert';
import {
  RawCursorState,
  SettledState,
  SettledSymbol,
  classifyJump,
  pickDeparture,
  stripParens,
} from '../../core/jumpClassify';

function sym(
  name: string,
  startLine: number,
  endLine: number,
  onName = false,
): SettledSymbol {
  return { name, startLine, endLine, onName };
}

function state(
  uriString: string,
  line: number,
  word?: string,
  at?: SettledSymbol,
): SettledState {
  return { uriString, line, word, at };
}

const A = 'file:///a.ts';
const B = 'file:///b.ts';

suite('jumpClassify: drill-in', () => {
  test('from a call site onto the callee name → previous scope calls it', () => {
    const prev = state(A, 12, 'foo', sym('caller', 5, 20));
    const curr = state(B, 3, 'foo', sym('foo', 3, 9, true));
    assert.deepStrictEqual(classifyJump(prev, curr), {
      type: 'drill-in',
      caller: 'prev',
      callsiteLine: 12,
    });
  });

  test('C-style symbol names with parameter lists still match the word', () => {
    const prev = state(A, 12, 'foo', sym('caller', 5, 20));
    const curr = state(B, 3, 'foo', sym('foo(int a)', 3, 9, true));
    assert.strictEqual(classifyJump(prev, curr)?.type, 'drill-in');
  });

  test('word mismatch is not a drill-in', () => {
    const prev = state(A, 12, 'bar', sym('caller', 5, 20));
    const curr = state(B, 3, 'foo', sym('foo', 3, 9, true));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('landing mid-body is not a drill-in', () => {
    const prev = state(A, 12, 'foo', sym('caller', 5, 20));
    const curr = state(B, 6, 'x', sym('foo', 3, 9, false));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('module top-level caller: script code drills into a function', () => {
    const prev = state(A, 40, 'foo', undefined);
    const curr = state(B, 3, 'foo', sym('foo', 3, 9, true));
    assert.deepStrictEqual(classifyJump(prev, curr), {
      type: 'drill-in',
      caller: 'prev',
      callsiteLine: 40,
    });
  });

  test('recursion: from a call site inside foo onto foo\'s own name', () => {
    const prev = state(A, 6, 'foo', sym('foo', 3, 9, false));
    const curr = state(A, 3, 'foo', sym('foo', 3, 9, true));
    assert.strictEqual(classifyJump(prev, curr)?.type, 'drill-in');
  });

  test('re-clicking the name already under the cursor is not a self call', () => {
    const prev = state(A, 3, 'foo', sym('foo', 3, 9, true));
    const curr = state(A, 4, 'foo', sym('foo', 3, 9, true));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });
});

suite('jumpClassify: ref-jump', () => {
  test('landing on a mention of the symbol just read → landing scope is the caller', () => {
    const prev = state(A, 5, undefined, sym('target', 3, 9));
    const curr = state(B, 22, 'target', sym('caller', 18, 30, false));
    assert.deepStrictEqual(classifyJump(prev, curr), {
      type: 'ref-jump',
      caller: 'curr',
      callsiteLine: 22,
    });
  });

  test('landing at module top level: the script itself is the caller', () => {
    const prev = state(A, 5, undefined, sym('target', 3, 9));
    const curr = state(B, 50, 'target', undefined);
    assert.deepStrictEqual(classifyJump(prev, curr), {
      type: 'ref-jump',
      caller: 'curr',
      callsiteLine: 50,
    });
  });

  test('landing on another definition header is not a call site', () => {
    const prev = state(A, 5, undefined, sym('target', 3, 9));
    const curr = state(B, 18, 'target', sym('target', 18, 30, true));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('word mismatch is not a ref-jump', () => {
    const prev = state(A, 5, undefined, sym('target', 3, 9));
    const curr = state(B, 22, 'other', sym('caller', 18, 30, false));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('recursion: landing on a recursive call site inside the symbol itself', () => {
    const prev = state(A, 3, undefined, sym('foo', 3, 9));
    const curr = state(A, 6, 'foo', sym('foo', 3, 9, false));
    assert.strictEqual(classifyJump(prev, curr)?.type, 'ref-jump');
  });
});

suite('jumpClassify: none', () => {
  test('no words at all', () => {
    const prev = state(A, 5, undefined, sym('a', 3, 9));
    const curr = state(B, 22, undefined, sym('b', 18, 30));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('movement within one line is never a jump', () => {
    const prev = state(A, 3, 'foo', sym('foo', 3, 9, true));
    const curr = state(A, 3, 'foo', sym('foo', 3, 9, true));
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });

  test('module to module is never classified', () => {
    const prev = state(A, 5, 'x', undefined);
    const curr = state(B, 22, 'y', undefined);
    assert.strictEqual(classifyJump(prev, curr), undefined);
  });
});

suite('jumpClassify: pickDeparture', () => {
  const raw = (line: number, ms: number, word?: string, uri = A): RawCursorState => ({
    uriString: uri,
    line,
    character: 4,
    word,
    ms,
  });

  test('skips the landing itself and returns the state before it', () => {
    const history = [raw(12, 100, 'callee'), raw(3, 150, 'callee')];
    const dep = pickDeparture(history, { uriString: A, line: 3, ms: 260 }, 3000);
    assert.strictEqual(dep?.line, 12);
    assert.strictEqual(dep?.word, 'callee');
  });

  test('the departure may live in another file', () => {
    const history = [raw(12, 100, 'callee', B), raw(3, 150, 'callee')];
    const dep = pickDeparture(history, { uriString: A, line: 3, ms: 260 }, 3000);
    assert.strictEqual(dep?.uriString, B);
  });

  test('a stale departure outside the window is discarded, not skipped over', () => {
    const history = [raw(30, 0, 'other'), raw(12, 100, 'callee'), raw(3, 150)];
    assert.strictEqual(
      pickDeparture([raw(12, 100, 'callee'), raw(3, 150)], { uriString: A, line: 3, ms: 5000 }, 3000),
      undefined,
    );
    assert.strictEqual(
      pickDeparture(history, { uriString: A, line: 3, ms: 260 }, 3000)?.line,
      12,
    );
  });

  test('states newer than the landing belong to later activity (replay)', () => {
    const history = [raw(12, 100, 'callee'), raw(3, 150), raw(40, 9000, 'later')];
    const dep = pickDeparture(history, { uriString: A, line: 3, ms: 260 }, 3000);
    assert.strictEqual(dep?.line, 12);
  });

  test('empty history → undefined', () => {
    assert.strictEqual(pickDeparture([], { uriString: A, line: 3, ms: 260 }, 3000), undefined);
  });
});

suite('jumpClassify: stripParens', () => {
  test('removes parameter lists, keeps plain names', () => {
    assert.strictEqual(stripParens('foo(int a, char b)'), 'foo');
    assert.strictEqual(stripParens('foo'), 'foo');
    assert.strictEqual(stripParens('foo (a)'), 'foo');
  });
});
