import * as assert from 'assert';
import { TrailGraph, TrailNodeInput } from '../../core/trail';

function n(name: string, uri = 'file:///a.ts', line = 0, endLine = 10): TrailNodeInput {
  return { key: `${uri}#${name}`, name, kind: 'function', uriString: uri, line, endLine };
}

suite('trail: recordEdge and projection', () => {
  test('an edge creates both nodes, caller is the root', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 3);
    assert.strictEqual(g.size, 2);
    assert.deepStrictEqual(
      g.roots().map((r) => r.name),
      ['a'],
    );
    assert.deepStrictEqual(
      g.children(n('a').key).map((c) => c.node.name),
      ['b'],
    );
  });

  test('a discovered caller re-roots the callee (ref-jump semantics)', () => {
    const g = new TrailGraph();
    g.upsert(n('b'), true); // the function being read, pinned as a seed
    assert.deepStrictEqual(g.roots().map((r) => r.name), ['b']);
    g.recordEdge(n('c'), n('b'), 7);
    assert.deepStrictEqual(g.roots().map((r) => r.name), ['c']);
    assert.deepStrictEqual(g.children(n('c').key).map((c) => c.node.name), ['b']);
  });

  test('several callers keep one node with inDegree, mirrored under each', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.recordEdge(n('c'), n('b'), 2);
    assert.strictEqual(g.size, 3);
    assert.strictEqual(g.inDegree(n('b').key), 2);
    assert.deepStrictEqual(g.children(n('a').key).map((c) => c.node.name), ['b']);
    assert.deepStrictEqual(g.children(n('c').key).map((c) => c.node.name), ['b']);
  });

  test('children are ordered by call-site line, not discovery order', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('x'), 20);
    g.recordEdge(n('a'), n('y'), 5);
    assert.deepStrictEqual(
      g.children(n('a').key).map((c) => c.node.name),
      ['y', 'x'],
    );
  });

  test('re-walking an edge keeps the earliest call site', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 30);
    g.recordEdge(n('a'), n('b'), 10);
    g.recordEdge(n('a'), n('b'), 50);
    assert.strictEqual(g.children(n('a').key)[0].callsiteLine, 10);
    assert.strictEqual(g.children(n('a').key).length, 1);
  });

  test('upsert self-heals position info', () => {
    const g = new TrailGraph();
    g.upsert(n('a', 'file:///a.ts', 0, 10));
    g.upsert(n('a', 'file:///a.ts', 5, 15));
    assert.strictEqual(g.node(n('a').key)?.line, 5);
    assert.strictEqual(g.node(n('a').key)?.endLine, 15);
  });

  test('containerName is stored and self-heals', () => {
    const g = new TrailGraph();
    g.upsert({ ...n('m'), containerName: 'Foo' });
    assert.strictEqual(g.node(n('m').key)?.containerName, 'Foo');
    g.upsert({ ...n('m'), containerName: 'Bar' });
    assert.strictEqual(g.node(n('m').key)?.containerName, 'Bar');
  });

  test('nodeAt picks the innermost containing node', () => {
    const g = new TrailGraph();
    g.upsert({ ...n('mod'), kind: 'module', line: 0, endLine: 100 });
    g.upsert(n('fn', 'file:///a.ts', 10, 20));
    assert.strictEqual(g.nodeAt('file:///a.ts', 15)?.name, 'fn');
    assert.strictEqual(g.nodeAt('file:///a.ts', 50)?.name, 'mod');
    assert.strictEqual(g.nodeAt('file:///b.ts', 15), undefined);
  });
});

suite('trail: cycles', () => {
  test('a pure cycle still yields a root (earliest node promoted)', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.recordEdge(n('b'), n('a'), 2);
    const roots = g.roots();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].name, 'a');
  });

  test('self-recursion is a normal edge', () => {
    const g = new TrailGraph();
    g.recordEdge(n('f'), n('f'), 4);
    assert.strictEqual(g.roots().length, 1);
    assert.deepStrictEqual(g.children(n('f').key).map((c) => c.node.name), ['f']);
  });
});

suite('trail: remove', () => {
  test('removes the node and its exclusive descendants', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.recordEdge(n('b'), n('d'), 2);
    g.remove(n('b').key);
    assert.strictEqual(g.node(n('b').key), undefined);
    assert.strictEqual(g.node(n('d').key), undefined);
    assert.strictEqual(g.node(n('a').key)?.name, 'a');
    assert.deepStrictEqual(g.children(n('a').key), []);
  });

  test('shared descendants survive under their other caller', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.recordEdge(n('c'), n('b'), 2);
    g.recordEdge(n('b'), n('d'), 3);
    g.remove(n('a').key);
    assert.strictEqual(g.node(n('a').key), undefined);
    assert.strictEqual(g.node(n('b').key)?.name, 'b');
    assert.strictEqual(g.node(n('d').key)?.name, 'd');
    assert.deepStrictEqual(g.children(n('c').key).map((c) => c.node.name), ['b']);
  });

  test('removing a shared node detaches it from every caller', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.recordEdge(n('c'), n('b'), 2);
    g.remove(n('b').key);
    assert.deepStrictEqual(g.children(n('a').key), []);
    assert.deepStrictEqual(g.children(n('c').key), []);
    assert.strictEqual(g.inDegree(n('b').key), 0);
  });

  test('pinned descendants are spared and become roots', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.upsert(n('b'), true);
    g.remove(n('a').key);
    assert.strictEqual(g.node(n('b').key)?.name, 'b');
    assert.deepStrictEqual(g.roots().map((r) => r.name), ['b']);
  });
});

suite('trail: eviction', () => {
  test('drops the least recently visited tree, never the most active one', () => {
    const g = new TrailGraph();
    g.recordEdge(n('old'), n('oldChild'), 1);
    g.recordEdge(n('new'), n('newChild'), 1);
    g.touch(n('newChild').key); // activity deep in the newer tree
    g.evict(2);
    assert.strictEqual(g.size, 2);
    assert.strictEqual(g.node(n('old').key), undefined);
    assert.strictEqual(g.node(n('new').key)?.name, 'new');
  });

  test('pinned roots are exempt', () => {
    const g = new TrailGraph();
    g.upsert(n('pinned'), true);
    g.recordEdge(n('a'), n('b'), 1);
    g.touch(n('a').key);
    g.evict(2);
    assert.strictEqual(g.node(n('pinned').key)?.name, 'pinned');
  });

  test('no-op under the cap', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.evict(10);
    assert.strictEqual(g.size, 2);
  });
});

suite('trail: root ordering', () => {
  test('newest tree first', () => {
    const g = new TrailGraph();
    g.recordEdge(n('first'), n('x'), 1);
    g.recordEdge(n('second'), n('y'), 1);
    assert.deepStrictEqual(
      g.roots().map((r) => r.name),
      ['second', 'first'],
    );
  });
});
