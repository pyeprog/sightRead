import * as assert from 'assert';
import { syntaxFor } from '../../core/lang';
import { genericSyntax } from '../../core/lang/generic';
import { DEFAULT_OPTIONS, SegmentNode, extractBody, segmentTree } from '../../core/segmentation';

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
      [5, 5, 'flow', 'return', []],
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
    assert.strictEqual(t[0].name, 'buf=alloc()');
    assert.strictEqual(t[0].kind, 'assignment');
  });

  test('if without else', () => {
    const t = tree('const x = 1;', 'if (x) {', '  doA();', '  doB();', '}', 'const y = 2;');
    assert.deepStrictEqual(shape(t), [
      [0, 0, 'assignment', 'x=..', []],
      [1, 4, 'branch', 'if', [[2, 3, 'call', 'doA() doB()', []]]],
      [5, 5, 'assignment', 'y=..', []],
    ]);
  });

  test('if/else chain is one node named if/else, branches become children', () => {
    const t = tree('if (a) {', '  x();', '} else {', '  y();', '}');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'if/else');
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
    assert.strictEqual(t[0].name, 'if/elif{2}/else');
    assert.strictEqual(t[0].children.length, 4);
  });

  test('js else-if uses the language keyword', () => {
    const t = tree('if (a) {', '  x();', '} else if (b) {', '  y();', '} else {', '  z();', '}');
    assert.strictEqual(t[0].name, 'if/else if/else');
  });

  test('try/except/finally', () => {
    const t = tree('try:', '    x()', 'except ValueError:', '    y()', 'finally:', '    z()');
    assert.strictEqual(t[0].kind, 'try');
    assert.strictEqual(t[0].name, 'try/except/finally');
  });

  test('loop and with keywords', () => {
    assert.strictEqual(tree('for (const x of xs) {', '  use(x);', '}')[0].name, 'for');
    assert.strictEqual(tree('while (a) {', '  b();', '}')[0].name, 'while');
    const w = tree('with open(p) as f:', '    read(f)', '    parse(f)');
    assert.strictEqual(w[0].kind, 'with');
    assert.strictEqual(w[0].name, 'with');
  });

  test('definitions keep the language keyword and the name', () => {
    assert.strictEqual(tree('def foo():', '    a()', '    b()')[0].name, 'def foo');
    const c = tree('class Bar:', '    x = 1', '    y = 2');
    assert.strictEqual(c[0].name, 'class Bar');
    assert.strictEqual(c[0].kind, 'definition');
  });

  test('a function value bound to a name is a definition, and its body recurses', () => {
    const t = tree(
      'const handle = (x) => {',
      '  if (x) {',
      '    doA();',
      '    doB();',
      '  }',
      '};',
    );
    assert.strictEqual(t[0].kind, 'definition');
    assert.strictEqual(t[0].name, 'function handle');
    assert.strictEqual(t[0].children[0].name, 'if');
    const f = tree('const f = function (a) {', '  return a;', '  // pad', '};');
    assert.strictEqual(f[0].name, 'function f');
    // a lone one-liner is a definition too; a `this.` binding sheds the prefix
    const g = tree('this.handler = async (e: Event) => e.stop();');
    assert.deepStrictEqual([g[0].kind, g[0].name], ['definition', 'function handler']);
    // ...but merged into a statement group it must not claim the group's name
    const merged = tree('const g = (x) => x * 2;', 'const y = g(3);');
    assert.strictEqual(merged[0].kind, 'assignment');
    // a plain value assignment stays an assignment
    assert.strictEqual(tree('const x = compute();')[0].kind, 'assignment');
  });

  test('recursion: nested blocks become descendants', () => {
    const t = tree('if (a) {', '  for (const x of xs) {', '    handle(x);', '  }', '}');
    assert.strictEqual(t[0].name, 'if');
    assert.strictEqual(t[0].children[0].name, 'for');
    assert.strictEqual(t[0].children[0].children[0].name, 'handle(...)');
  });

  test('multiline calls do not recurse into their arguments', () => {
    const t = tree('parser.add_argument(', '  "--x",', '  action="store_true",', ')');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'parser.add_argument(...)');
    assert.deepStrictEqual(t[0].children, []);
  });

  test('assignment from a call names the dataflow edge', () => {
    const t = tree('const fresh = self._sift_pool(candidates, rows);');
    assert.strictEqual(t[0].name, 'fresh=_sift_pool(...)');
    assert.strictEqual(t[0].kind, 'assignment');
  });

  test('multi-target assignment joins its names on the edge', () => {
    const t = tree('related, seed_rows = self._expand(seeds)');
    assert.strictEqual(t[0].name, 'related,seed_rows=_expand(...)');
  });

  test('a call inside a comprehension is still the verb', () => {
    const t = tree('candidates = [c for c in self._aggregate(related) if c.mid not in seen]');
    assert.strictEqual(t[0].name, 'candidates=_aggregate(...)');
  });

  test('a conditional right-hand side falls back to the bare name', () => {
    const js = tree('const key = fn ? makeKey(fn) : undefined;');
    assert.strictEqual(js[0].name, 'key=..');
    const py = tree('key = make_key(fn) if fn else None');
    assert.strictEqual(py[0].name, 'key=..');
  });

  test('calls inside string literals are not verbs', () => {
    const t = tree('const id = `${el.uriString}:${node.startLine.toString()}`;');
    assert.strictEqual(t[0].name, 'id=..');
  });

  test('an operand call behind an operator is not the verb', () => {
    const t = tree('avg = total / len(xs)');
    assert.strictEqual(t[0].name, 'avg=..');
  });

  test('dotted callee paths keep their last two segments, self/this dropped', () => {
    const t = tree('const doc = vscode.workspace.textDocuments.find(match);');
    assert.strictEqual(t[0].name, 'doc=textDocuments.find(...)');
    const py = tree('rows = self.db.cursor.fetchall()');
    assert.strictEqual(py[0].name, 'rows=cursor.fetchall()');
  });

  test('a segment mixing assignments and bare calls stays an assignment', () => {
    const t = tree('fresh = self._sift(pool)', 'self._trace(fresh)');
    assert.strictEqual(t[0].name, 'fresh=_sift(...) _trace(...)');
    assert.strictEqual(t[0].kind, 'assignment');
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

  test('a bodyless keyword statement does not swallow the statements after it', () => {
    const t = tree(
      'if (n > 0) push(a);',
      'const idle = total - used;',
      "push('b');",
      'return lines;',
    );
    // the two plain statements still merge — only keyword statements stand alone
    assert.deepStrictEqual(shape(t), [
      [0, 0, 'branch', 'if', []],
      [1, 2, 'assignment', 'idle=.. push(...)', []],
      [3, 3, 'flow', 'return', []],
    ]);
  });

  test('a single-line loop keeps a segment of its own', () => {
    const t = tree('total = 0', 'for x in xs: total += x', 'avg = total / len(xs)');
    assert.deepStrictEqual(shape(t), [
      [0, 0, 'assignment', 'total=..', []],
      [1, 1, 'loop', 'for', []],
      [2, 2, 'assignment', 'avg=..', []],
    ]);
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

suite('segmentation: header detail', () => {
  test('if condition becomes the detail, outer parens unwrapped', () => {
    const t = tree('if (x && y) {', '  a();', '}');
    assert.strictEqual(t[0].detail, 'x && y');
  });

  test('loop and with headers keep their expression', () => {
    assert.strictEqual(tree('for f in files:', '    use(f)')[0].detail, 'f in files');
    assert.strictEqual(tree('while retries < 3:', '    retry()')[0].detail, 'retries < 3');
    assert.strictEqual(tree('with open(path) as f:', '    read(f)')[0].detail, 'open(path) as f');
  });

  test('string literals collapse', () => {
    const t = tree("if (mode === 'production') {", '  a();', '}');
    assert.strictEqual(t[0].detail, "mode === '…'");
  });

  test('depth-2 bracket groups collapse', () => {
    const t = tree('if (isEnabled(getCtx(env), key)) {', '  a();', '}');
    assert.strictEqual(t[0].detail, 'isEnabled(getCtx(…), key)');
  });

  test('token budget cuts long conditions at a token boundary', () => {
    const t = tree("if (user.role === 'admin' && flags.isEnabled(ctx, 'x')) {", '  a();', '}');
    assert.strictEqual(t[0].detail, "user.role === '…' && …");
  });

  test('return value becomes the detail; bare return has none', () => {
    assert.strictEqual(tree('return cache[key];')[0].detail, 'cache[key]');
    assert.strictEqual(tree('return;')[0].detail, undefined);
  });

  test('multi-line header opener yields no detail instead of noise', () => {
    const t = tree('return {', '  a: 1,', '};');
    assert.strictEqual(t[0].detail, undefined);
  });

  test('try segments carry no detail', () => {
    const t = tree('try:', '    x()', 'except ValueError:', '    y()');
    assert.strictEqual(t[0].detail, undefined);
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

  test('ts: multi-line destructured params with inline type literal', () => {
    const r = extractBody(
      [
        'function EntryParamsRow({',
        '  form,',
        '  params,',
        '  onChange,',
        '}: {',
        '  form: PracticeForm;',
        '  params?: FormParams;',
        '  onChange(params: FormParams): void;',
        '}) {',
        '  const specs = FORM_PARAM_SPECS[form];',
        '  if (!specs) return null;',
        '  return specs;',
        '}',
      ],
      syntaxFor('typescriptreact'),
    );
    assert.strictEqual(r.offset, 9);
    assert.deepStrictEqual(r.lines, [
      '  const specs = FORM_PARAM_SPECS[form];',
      '  if (!specs) return null;',
      '  return specs;',
    ]);
  });

  test('ts: single-line destructured params', () => {
    const r = extractBody(
      ['function f({ a, b }: { a: X; b: Y }) {', '  body();', '}'],
      syntaxFor('typescript'),
    );
    assert.strictEqual(r.offset, 1);
    assert.deepStrictEqual(r.lines, ['  body();']);
  });

  test('python: multi-line signature with annotated params', () => {
    const r = extractBody(
      ['def f(', '    a: int,', ') -> dict:', '    return {}'],
      syntaxFor('python'),
    );
    assert.strictEqual(r.offset, 3);
    assert.deepStrictEqual(r.lines, ['    return {}']);
  });
});

suite('segmentation: language dispatch', () => {
  test('typescript variants map to the ts-js syntax', () => {
    assert.strictEqual(syntaxFor('typescript'), syntaxFor('javascriptreact'));
    assert.notStrictEqual(syntaxFor('typescript'), genericSyntax);
  });

  test('unknown language falls back to generic', () => {
    assert.strictEqual(syntaxFor('cobol'), genericSyntax);
  });

  test('js: bare match assignment is assignment, not switch', () => {
    const t = segmentTree(['match = pattern.exec(s);'], DEFAULT_OPTIONS, syntaxFor('javascript'));
    assert.strictEqual(t[0].kind, 'assignment');
    assert.strictEqual(t[0].name, 'match=pattern.exec(...)');
  });

  test('python: match statement keeps its switch kind', () => {
    const t = segmentTree(
      ['match cmd:', '    case 1:', '        a()', '    case 2:', '        b()'],
      DEFAULT_OPTIONS,
      syntaxFor('python'),
    );
    assert.strictEqual(t[0].kind, 'switch');
    assert.strictEqual(t[0].name, 'match');
  });

  test('python: top-level end variable starts its own segment', () => {
    const t = segmentTree(
      ['start = lo()', '', 'end = hi()'],
      DEFAULT_OPTIONS,
      syntaxFor('python'),
    );
    assert.strictEqual(t.length, 2);
    assert.strictEqual(t[1].name, 'end=hi()');
  });
});

suite('segmentation: per-language syntax', () => {
  test('go: receiver method signature and type definition', () => {
    const r = extractBody(
      ['func (s *Server) handle(', '  w http.ResponseWriter,', ') error {', '  s.mu.Lock()', '  return nil', '}'],
      syntaxFor('go'),
    );
    assert.strictEqual(r.offset, 3);
    const t = segmentTree(
      ['type Config struct {', '  Name string', '  Port int', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('go'),
    );
    assert.strictEqual(t[0].kind, 'definition');
    assert.strictEqual(t[0].name, 'type Config');
  });

  test('rust: match is a switch, multi-line fn signature with return type', () => {
    const t = segmentTree(
      ['match msg {', '    Msg::A => a(),', '    Msg::B => b(),', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('rust'),
    );
    assert.strictEqual(t[0].kind, 'switch');
    assert.strictEqual(t[0].name, 'match');
    const r = extractBody(
      ['fn parse(', '    input: &str,', ') -> Result<(), Error> {', '    body();', '}'],
      syntaxFor('rust'),
    );
    assert.strictEqual(r.offset, 3);
  });

  test('java: try/catch/finally chain and synchronized block', () => {
    const t = segmentTree(
      ['try {', '  a();', '} catch (IOException e) {', '  b();', '} finally {', '  c();', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('java'),
    );
    assert.strictEqual(t[0].name, 'try/catch/finally');
    const s = segmentTree(
      ['synchronized (lock) {', '  a();', '  b();', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('java'),
    );
    assert.strictEqual(s[0].kind, 'with');
  });

  test('csharp: using block and foreach loop', () => {
    const u = segmentTree(
      ['using (var conn = Open()) {', '  conn.Run();', '  conn.Close();', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('csharp'),
    );
    assert.strictEqual(u[0].kind, 'with');
    assert.strictEqual(u[0].name, 'using');
    const f = segmentTree(
      ['foreach (var x in xs) {', '  Use(x);', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('csharp'),
    );
    assert.strictEqual(f[0].kind, 'loop');
  });

  test('cpp: else-if chain, c shares the module', () => {
    const t = segmentTree(
      ['if (a) {', '  x();', '} else if (b) {', '  y();', '} else {', '  z();', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('cpp'),
    );
    assert.strictEqual(t[0].name, 'if/else if/else');
    assert.strictEqual(syntaxFor('c'), syntaxFor('cpp'));
  });

  test('ruby: def body starts right after the signature, begin/rescue is a try', () => {
    const r = extractBody(['def fetch(id)', '  row = db[id]', '  row', 'end'], syntaxFor('ruby'));
    assert.strictEqual(r.offset, 1);
    const t = segmentTree(
      ['begin', '  risky()', 'rescue KeyError', '  fallback()', 'ensure', '  cleanup()', 'end'],
      DEFAULT_OPTIONS,
      syntaxFor('ruby'),
    );
    assert.strictEqual(t[0].kind, 'try');
    assert.strictEqual(t[0].name, 'begin/rescue/ensure');
  });

  test('php: elseif keeps the source spelling', () => {
    const t = segmentTree(
      ['if ($a) {', '  x();', '} elseif ($b) {', '  y();', '} else {', '  z();', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('php'),
    );
    assert.strictEqual(t[0].name, 'if/elseif/else');
  });

  test('swift: guard is a branch, do/catch is the try chain', () => {
    const g = segmentTree(
      ['guard let user = user else {', '  return', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('swift'),
    );
    assert.strictEqual(g[0].kind, 'branch');
    assert.strictEqual(g[0].name, 'guard');
    const t = segmentTree(
      ['do {', '  try risky()', '} catch {', '  report()', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('swift'),
    );
    assert.strictEqual(t[0].kind, 'try');
    assert.strictEqual(t[0].name, 'do/catch');
  });

  test('kotlin: when is a switch, data class names the definition', () => {
    const t = segmentTree(
      ['when (x) {', '    1 -> a()', '    else -> b()', '}'],
      DEFAULT_OPTIONS,
      syntaxFor('kotlin'),
    );
    assert.strictEqual(t[0].kind, 'switch');
    assert.strictEqual(t[0].name, 'when');
    const d = segmentTree(
      ['data class Config(', '    val name: String,', '    val port: Int,', ')'],
      DEFAULT_OPTIONS,
      syntaxFor('kotlin'),
    );
    assert.strictEqual(d[0].name, 'class Config');
  });
});
