import * as assert from 'assert';
import { parseGuideResponse } from '../../core/guideParse';

let counter = 0;
const newId = (): string => `id-${counter++}`;

// the interpreted subject occupies lines 5–20 (0-based)
const input = { subject: 'parseConfig', unit: 'function' as const, startLine: 5, endLine: 20 };

suite('guideParse: parseGuideResponse', () => {
  test('parses a clean JSON response into a 0-based guide sorted by line', () => {
    const raw = JSON.stringify({
      summary: 'Loads and validates the config file.',
      steps: [
        { startLine: 15, endLine: 18, note: 'main parse loop', role: 'main' },
        { startLine: 7, endLine: 9, note: 'defaults setup' },
      ],
    });
    const r = parseGuideResponse({ raw, ...input }, newId);
    assert.ok(r.ok);
    assert.strictEqual(r.guide.summary, 'Loads and validates the config file.');
    assert.strictEqual(r.guide.subject, 'parseConfig');
    assert.strictEqual(r.guide.unit, 'function');
    // ascending line order regardless of response order; role kept, absence tolerated
    assert.deepStrictEqual(
      r.guide.steps.map((s) => [s.startLine, s.endLine, s.note, s.role]),
      [
        [6, 8, 'defaults setup', undefined],
        [14, 17, 'main parse loop', 'main'],
      ],
    );
  });

  test('extracts JSON wrapped in code fences and surrounding prose', () => {
    const raw =
      'Here is the guide:\n```json\n' +
      JSON.stringify({ steps: [{ startLine: 6, endLine: 7, note: 'entry check' }] }) +
      '\n```\nHope this helps!';
    const r = parseGuideResponse({ raw, ...input }, newId);
    assert.ok(r.ok);
    assert.deepStrictEqual([r.guide.steps[0].startLine, r.guide.steps[0].endLine], [5, 6]);
    assert.strictEqual(r.guide.summary, undefined);
  });

  test('clips overhanging steps and drops fully-outside or noteless ones', () => {
    const raw = JSON.stringify({
      steps: [
        { startLine: 1, endLine: 8, note: 'clipped to the function start' },
        { startLine: 100, endLine: 110, note: 'entirely outside' },
        { startLine: 10, endLine: 11, note: '   ' },
        { startLine: 10, endLine: 11 },
      ],
    });
    const r = parseGuideResponse({ raw, ...input }, newId);
    assert.ok(r.ok);
    assert.strictEqual(r.guide.steps.length, 1);
    assert.deepStrictEqual([r.guide.steps[0].startLine, r.guide.steps[0].endLine], [5, 7]);
  });

  test('returns an error for non-JSON garbage and for empty steps', () => {
    assert.strictEqual(parseGuideResponse({ raw: 'Sorry, I cannot.', ...input }, newId).ok, false);
    assert.strictEqual(
      parseGuideResponse({ raw: '{"summary":"x","steps":[]}', ...input }, newId).ok,
      false,
    );
  });
});
