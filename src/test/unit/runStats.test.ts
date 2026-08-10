import * as assert from 'assert';
import { recordDuration, typicalMs } from '../../core/runStats';

suite('runStats', () => {
  test('typicalMs is the median, robust against an outlier run', () => {
    assert.strictEqual(typicalMs([]), undefined);
    assert.strictEqual(typicalMs([40_000]), 40_000);
    assert.strictEqual(typicalMs([30_000, 45_000, 170_000]), 45_000);
    assert.strictEqual(typicalMs([30_000, 40_000, 50_000, 60_000]), 45_000);
  });

  test('recordDuration appends and keeps only the newest samples', () => {
    let recent: number[] = [];
    for (let i = 1; i <= 12; i++) {
      recent = recordDuration(recent, i * 1000);
    }
    assert.strictEqual(recent.length, 10);
    assert.deepStrictEqual([recent[0], recent[9]], [3000, 12_000]);
  });
});
