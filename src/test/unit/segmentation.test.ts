import * as assert from 'assert';
import { SegmentNode, extractBody, segmentTree } from '../../core/segmentation';

function tree(...lines: string[]): SegmentNode[] {
  return segmentTree(lines);
}

function shape(nodes: SegmentNode[]): unknown[] {
  return nodes.map((n) => [n.startLine, n.endLine, n.kind, n.name, shape(n.children)]);
}

suite('segmentation: structural naming', () => {
  test('assignment segments are named A=.. B=..', () => {
    const t = tree('const a = 1;', 'const b = 2;', '', 'let c = 3;', '', 'return c;');
    assert.deepStrictEqual(shape(t), [
      [0, 1, 'assignment', 'a=.. b=..', []],
      [3, 3, 'assignment', 'c=..', []],
      [5, 5, 'flow', 'return ...', []],
    ]);
  });

  test('call segments elide arguments', () => {
    const t = tree('shutil.rmtree(path, ignore_errors=True)');
    assert.strictEqual(t[0].kind, 'call');
    assert.strictEqual(t[0].name, 'shutil.rmtree(...)');
    const t2 = tree('path.unlink()');
    assert.strictEqual(t2[0].name, 'path.unlink()');
  });

  test('comments bind to the next segment but never name it', () => {
    const t = tree('// prepare buffers', 'const buf = alloc();');
    assert.strictEqual(t.length, 1);
    assert.deepStrictEqual([t[0].startLine, t[0].endLine], [0, 1]);
    assert.strictEqual(t[0].name, 'buf=..');
    assert.strictEqual(t[0].kind, 'assignment');
  });

  test('if without else', () => {
    const t = tree('const x = 1;', 'if (x) {', '  doA();', '  doB();', '}', 'const y = 2;');
    assert.deepStrictEqual(shape(t), [
      [0, 0, 'assignment', 'x=..', []],
      [1, 4, 'branch', 'if ...', [[2, 3, 'call', 'doA() doB()', []]]],
      [5, 5, 'assignment', 'y=..', []],
    ]);
  });

  test('if/else chain is one node named if ... else ..., branches become children', () => {
    const t = tree('if (a) {', '  x();', '} else {', '  y();', '}');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'if ... else ...');
    assert.deepStrictEqual(shape(t[0].children), [
      [1, 1, 'call', 'x()', []],
      [3, 3, 'call', 'y()', []],
    ]);
  });

  test('python elif chain counts elifs', () => {
    const t = tree(
      'if a:',
      '    x()',
      'elif b:',
      '    y()',
      'elif c:',
      '    z()',
      'else:',
      '    w()',
    );
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'if ... elif{2} ... else ...');
    assert.strictEqual(t[0].children.length, 4);
  });

  test('js else-if uses the language keyword', () => {
    const t = tree('if (a) {', '  x();', '} else if (b) {', '  y();', '} else {', '  z();', '}');
    assert.strictEqual(t[0].name, 'if ... else if ... else ...');
  });

  test('try/except/finally', () => {
    const t = tree('try:', '    x()', 'except ValueError:', '    y()', 'finally:', '    z()');
    assert.strictEqual(t[0].kind, 'try');
    assert.strictEqual(t[0].name, 'try ... except ... finally ...');
  });

  test('loop and with keywords', () => {
    assert.strictEqual(tree('for (const x of xs) {', '  use(x);', '}')[0].name, 'for ...');
    assert.strictEqual(tree('while (a) {', '  b();', '}')[0].name, 'while ...');
    const w = tree('with open(p) as f:', '    read(f)', '    parse(f)');
    assert.strictEqual(w[0].kind, 'with');
    assert.strictEqual(w[0].name, 'with ...');
  });

  test('definitions keep the language keyword and the name', () => {
    assert.strictEqual(tree('def foo():', '    a()', '    b()')[0].name, 'def foo');
    const c = tree('class Bar:', '    x = 1', '    y = 2');
    assert.strictEqual(c[0].name, 'class Bar');
    assert.strictEqual(c[0].kind, 'definition');
  });

  test('recursion: nested blocks become descendants', () => {
    const t = tree('if (a) {', '  for (const x of xs) {', '    handle(x);', '  }', '}');
    assert.strictEqual(t[0].name, 'if ...');
    assert.strictEqual(t[0].children[0].name, 'for ...');
    assert.strictEqual(t[0].children[0].children[0].name, 'handle(...)');
  });

  test('multiline calls do not recurse into their arguments', () => {
    const t = tree('parser.add_argument(', '  "--x",', '  action="store_true",', ')');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'parser.add_argument(...)');
    assert.deepStrictEqual(t[0].children, []);
  });

  test('summary tokens are capped with an ellipsis', () => {
    const t = tree('a = 1', 'b = 2', 'c = 3', 'd = 4', 'e = 5');
    assert.strictEqual(t[0].name, 'a=.. b=.. c=.. d=.. …');
  });

  test('blank lines inside a block split its children, not the block', () => {
    const t = tree('for (;;) {', '  a();', '', '  b();', '}');
    assert.strictEqual(t.length, 1);
    assert.deepStrictEqual(shape(t[0].children), [
      [1, 1, 'call', 'a()', []],
      [3, 3, 'call', 'b()', []],
    ]);
  });

  test('small blocks merge with neighbours into a statement segment', () => {
    const t = tree('a()', 'if x:', '    b()', 'c()');
    assert.strictEqual(t.length, 1);
    assert.deepStrictEqual([t[0].startLine, t[0].endLine], [0, 3]);
    assert.strictEqual(t[0].name, 'a() c()');
  });

  test('unrecognized statements fall back to raw text, truncated', () => {
    const long = 'x'.repeat(100) + ';';
    const t = tree(long);
    assert.strictEqual(t[0].name.length, 60);
    assert.ok(t[0].name.endsWith('…'));
  });

  test('headerLines record every fold-region header, branch keywords included', () => {
    const js = tree('if (a) {', '  x();', '} else {', '  y();', '}');
    assert.deepStrictEqual(js[0].headerLines, [0, 2]);

    const py = tree(
      'if a:',
      '    x()',
      'elif b:',
      '    y()',
      'elif c:',
      '    z()',
      'else:',
      '    w()',
    );
    assert.deepStrictEqual(py[0].headerLines, [0, 2, 4, 6]);

    const flat = tree('const a = 1;', 'const b = 2;');
    assert.deepStrictEqual(flat[0].headerLines, []);

    const call = tree('parser.add_argument(', '  "--x",', ')');
    assert.deepStrictEqual(call[0].headerLines, [0]);
  });

  test('empty and blank-only input yields no segments', () => {
    assert.deepStrictEqual(segmentTree([]), []);
    assert.deepStrictEqual(segmentTree(['', '  ', '']), []);
  });
});

suite('segmentation: extractBody', () => {
  test('K&R braces: skips signature line and trailing closer', () => {
    const r = extractBody(['function foo() {', '  a;', '  b;', '}']);
    assert.strictEqual(r.offset, 1);
    assert.deepStrictEqual(r.lines, ['  a;', '  b;']);
  });

  test('Allman braces: skips signature and opening brace lines', () => {
    const r = extractBody(['function foo()', '{', '  a;', '}']);
    assert.strictEqual(r.offset, 2);
    assert.deepStrictEqual(r.lines, ['  a;']);
  });

  test('python def', () => {
    const r = extractBody(['def foo():', '    a()', '    b()']);
    assert.strictEqual(r.offset, 1);
    assert.deepStrictEqual(r.lines, ['    a()', '    b()']);
  });

  test('multi-line signature', () => {
    const r = extractBody(['function foo(', '  a,', '  b,', ') {', '  body();', '}']);
    assert.strictEqual(r.offset, 4);
    assert.deepStrictEqual(r.lines, ['  body();']);
  });

  test('single-line symbol has no body', () => {
    const r = extractBody(['const f = () => x;']);
    assert.deepStrictEqual(r.lines, []);
  });
});
