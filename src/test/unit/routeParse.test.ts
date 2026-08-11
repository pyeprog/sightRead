import * as assert from 'assert';
import { Route, parseRouteResponse } from '../../core/routeParse';

function parsed(raw: string): Route {
  const r = parseRouteResponse(raw);
  assert.strictEqual(r.ok, true, r.ok ? undefined : r.error);
  return (r as { ok: true; route: Route }).route;
}

const hopJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  file: 'src/a.ts',
  symbol: 'foo',
  kind: 'function',
  line: 10,
  note: 'entry',
  ...over,
});

suite('routeParse: parseRouteResponse', () => {
  test('parses a clean response into 0-based hops with calledFrom links', () => {
    const route = parsed(
      JSON.stringify({
        summary: 'lives in a.ts',
        hops: [
          hopJson(),
          hopJson({ symbol: 'bar', container: 'Baz', kind: 'method', line: 30, calledBy: 1, callsiteLine: 12 }),
        ],
      }),
    );
    assert.strictEqual(route.summary, 'lives in a.ts');
    assert.deepStrictEqual(
      route.hops.map((h) => [h.symbol, h.line, h.calledFrom, h.callsiteLine]),
      [
        ['foo', 9, undefined, undefined],
        ['bar', 29, 0, 11],
      ],
    );
    assert.strictEqual(route.hops[1].containerName, 'Baz');
  });

  test('hop list order carries no meaning: a forward calledBy reference still links', () => {
    const route = parsed(
      JSON.stringify({
        hops: [hopJson({ symbol: 'child', calledBy: 2, callsiteLine: 5 }), hopJson({ symbol: 'parent' })],
      }),
    );
    assert.strictEqual(route.hops[0].calledFrom, 1);
    assert.strictEqual(route.hops[0].callsiteLine, 4);
  });

  test('extracts JSON wrapped in code fences and prose', () => {
    const body = JSON.stringify({ hops: [hopJson()] });
    const route = parsed('Here is the route:\n```json\n' + body + '\n```\nEnjoy.');
    assert.strictEqual(route.hops[0].symbol, 'foo');
  });

  test('drops invalid hops and re-roots hops whose calledBy referenced a dropped hop', () => {
    const route = parsed(
      JSON.stringify({
        hops: [
          hopJson(),
          hopJson({ file: '' }), // dropped
          hopJson({ symbol: 'orphan', calledBy: 2, callsiteLine: 9 }),
        ],
      }),
    );
    assert.deepStrictEqual(
      route.hops.map((h) => [h.symbol, h.calledFrom, h.callsiteLine]),
      [
        ['foo', undefined, undefined],
        ['orphan', undefined, undefined],
      ],
    );
  });

  test('breaks calledBy cycles by re-rooting deterministically', () => {
    const route = parsed(
      JSON.stringify({
        hops: [
          hopJson({ symbol: 'a', calledBy: 2, callsiteLine: 1 }),
          hopJson({ symbol: 'b', calledBy: 1, callsiteLine: 2 }),
        ],
      }),
    );
    // the lowest-index member of the cycle loses its link; the other keeps it
    assert.deepStrictEqual(
      route.hops.map((h) => [h.symbol, h.calledFrom]),
      [
        ['a', undefined],
        ['b', 0],
      ],
    );
  });

  test('caps hops at 12, notes at 100 characters, unknown kinds fall back to function', () => {
    const route = parsed(
      JSON.stringify({
        hops: Array.from({ length: 14 }, (_, i) =>
          hopJson({ symbol: `s${i}`, kind: 'gadget', note: 'x'.repeat(150) }),
        ),
      }),
    );
    assert.strictEqual(route.hops.length, 12);
    assert.strictEqual(route.hops[0].kind, 'function');
    assert.strictEqual(route.hops[0].note?.length, 100);
  });

  test('empty hops with a summary surfaces the summary as the error', () => {
    const r = parseRouteResponse(
      JSON.stringify({ summary: 'searched for X, closest is Y', hops: [] }),
    );
    assert.deepStrictEqual(r, { ok: false, error: 'searched for X, closest is Y' });
  });

  test('returns an error for non-JSON garbage', () => {
    assert.strictEqual(parseRouteResponse('no json here').ok, false);
    assert.strictEqual(parseRouteResponse(JSON.stringify({ answer: 42 })).ok, false);
  });
});
