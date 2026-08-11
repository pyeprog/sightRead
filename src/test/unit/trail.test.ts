import * as assert from 'assert';
import { RouteHopInput, TrailGraph, TrailNodeInput } from '../../core/trail';

function n(name: string, uri = 'file:///a.ts', line = 0, endLine = 10): TrailNodeInput {
  return { key: `${uri}#${name}`, name, kind: 'function', uriString: uri, line, endLine };
}

function hop(
  name: string,
  opts?: { calledFrom?: number; callsiteLine?: number; note?: string; core?: boolean },
): RouteHopInput {
  return { node: n(name), ...opts };
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

suite('trail: planned route', () => {
  test('seedRoute builds a dim tree: branch hops attach to their calledFrom node', () => {
    const g = new TrailGraph();
    g.seedRoute(
      [
        hop('entry'),
        hop('a', { calledFrom: 0, callsiteLine: 5 }),
        hop('b', { calledFrom: 0, callsiteLine: 9 }),
        hop('model', { calledFrom: 1, callsiteLine: 3, note: 'the shape everything moves' }),
      ],
      'how does it work',
    );
    assert.deepStrictEqual(g.roots().map((r) => r.name), ['entry']);
    assert.deepStrictEqual(
      g.children(n('entry').key).map((c) => [c.node.name, c.planned]),
      [['a', true], ['b', true]],
    );
    assert.deepStrictEqual(g.children(n('a').key).map((c) => c.node.name), ['model']);
    assert.strictEqual(g.node(n('model').key)?.planned, true);
    assert.strictEqual(g.node(n('model').key)?.routeNote, 'the shape everything moves');
  });

  test('core hops carry the flag, others stay unmarked', () => {
    const g = new TrailGraph();
    g.seedRoute(
      [
        hop('entry', { core: true }),
        hop('plumbing', { calledFrom: 0, callsiteLine: 3 }),
        hop('meat', { calledFrom: 1, callsiteLine: 8, core: true }),
      ],
      'goal',
    );
    assert.strictEqual(g.node(n('entry').key)?.routeCore, true);
    assert.strictEqual(g.node(n('plumbing').key)?.routeCore, undefined);
    assert.strictEqual(g.node(n('meat').key)?.routeCore, true);
  });

  test('seeding onto an existing walked node keeps it walked and only adds the route badge', () => {
    const g = new TrailGraph();
    g.upsert(n('walked', 'file:///a.ts', 5, 15));
    g.seedRoute([hop('walked', { core: true }), hop('x', { calledFrom: 0, callsiteLine: 2 })], 'goal');
    const walked = g.node(n('walked').key);
    assert.strictEqual(walked?.planned, false);
    assert.strictEqual(walked?.routeCore, true);
    assert.strictEqual(walked?.line, 5); // self-healed position survives the seed
    assert.strictEqual(g.node(n('x').key)?.planned, true);
  });

  test('a hop without calledFrom becomes an extra planned root, roots in step order', () => {
    const g = new TrailGraph();
    g.seedRoute([hop('entry'), hop('stray')], 'goal');
    // exact order: step 1 on top, despite roots() sorting newest-seq first
    assert.deepStrictEqual(g.roots().map((r) => r.name), ['entry', 'stray']);
  });

  test('two routes coexist; an overlapping node takes the latest route badge; routeOf reports each', () => {
    const g = new TrailGraph();
    g.seedRoute([hop('entry1'), hop('shared', { calledFrom: 0, callsiteLine: 4 })], 'goal one');
    g.seedRoute([hop('entry2'), hop('shared', { calledFrom: 0, callsiteLine: 8 })], 'goal two');
    assert.strictEqual(g.routeOf(n('entry1').key)?.label, 'goal one');
    assert.strictEqual(g.routeOf(n('entry2').key)?.label, 'goal two');
    assert.strictEqual(g.routeOf(n('shared').key)?.label, 'goal two');
    assert.strictEqual(g.node(n('entry1').key)?.planned, true); // earlier route stays
    assert.strictEqual(g.inDegree(n('shared').key), 2);
  });

  test('clearPlanned removes every route: planned nodes, edges, badges and the registry', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('b'), 1);
    g.seedRoute([hop('a', { core: true }), hop('c', { calledFrom: 0, callsiteLine: 7 })], 'goal');
    g.clearPlanned();
    assert.strictEqual(g.node(n('c').key), undefined);
    assert.deepStrictEqual(g.children(n('a').key).map((c) => c.node.name), ['b']);
    assert.strictEqual(g.node(n('a').key)?.routeCore, undefined);
    assert.strictEqual(g.routeOf(n('a').key), undefined);
  });
});

suite('trail: route conversion', () => {
  test('touch inside a planned node converts it to walked', () => {
    const g = new TrailGraph();
    g.seedRoute([hop('p', { note: 'why here', core: true })], 'goal');
    g.touch(n('p').key);
    assert.strictEqual(g.node(n('p').key)?.planned, false);
    // the badge and note survive conversion
    assert.strictEqual(g.node(n('p').key)?.routeCore, true);
    assert.strictEqual(g.node(n('p').key)?.routeNote, 'why here');
  });

  test('recordEdge over a planned edge converts it and replaces the seeded call site', () => {
    const g = new TrailGraph();
    g.seedRoute([hop('a'), hop('b', { calledFrom: 0, callsiteLine: 99 })], 'goal');
    g.recordEdge(n('a'), n('b'), 12);
    assert.deepStrictEqual(
      g.children(n('a').key).map((c) => [c.callsiteLine, c.planned]),
      [[12, false]],
    );
    g.recordEdge(n('a'), n('b'), 30);
    assert.strictEqual(g.children(n('a').key)[0].callsiteLine, 12); // min rule resumes
  });

  test('planned children with unknown call site sort after walked children', () => {
    const g = new TrailGraph();
    g.recordEdge(n('a'), n('w'), 50);
    g.seedRoute([hop('a'), hop('p', { calledFrom: 0 })], 'goal');
    assert.deepStrictEqual(
      g.children(n('a').key).map((c) => c.node.name),
      ['w', 'p'],
    );
  });
});

suite('trail: planned eviction', () => {
  test('evict never drops planned nodes even in the least-recent tree', () => {
    const g = new TrailGraph();
    g.seedRoute([hop('r'), hop('c', { calledFrom: 0, callsiteLine: 1 })], 'goal');
    g.recordEdge(n('x'), n('y'), 1);
    g.touch(n('y').key);
    g.evict(2);
    assert.strictEqual(g.node(n('r').key)?.name, 'r');
    assert.strictEqual(g.node(n('c').key)?.name, 'c');
    assert.strictEqual(g.size, 4);
  });
});
