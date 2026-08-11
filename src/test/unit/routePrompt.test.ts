import * as assert from 'assert';
import { buildRoutePrompt, buildTracePrompt } from '../../core/routePrompt';

suite('routePrompt: buildRoutePrompt', () => {
  test('embeds the goal and appends the fixed contract last', () => {
    const p = buildRoutePrompt('how does folding work?');
    assert.ok(p.includes('how does folding work?'));
    const contractAt = p.indexOf('The output rules below are fixed');
    assert.ok(contractAt > 0);
    assert.ok(contractAt > p.indexOf('READING ROUTE'));
    assert.ok(p.trimEnd().endsWith('Write the summary and every note in English.'));
  });

  test('a custom template replaces exploration instructions, contract still wins', () => {
    const p = buildRoutePrompt('the goal', { template: 'My rules for ${goal} only.' });
    assert.ok(p.startsWith('My rules for the goal only.'));
    assert.ok(!p.includes('READING ROUTE'));
    assert.ok(p.includes('The output rules below are fixed'));
    // a template without the placeholder still gets the goal appended
    const q = buildRoutePrompt('the goal', { template: 'No placeholder here.' });
    assert.ok(q.includes("The reader's goal: the goal"));
  });

  test('language setting lands in the contract, English by default', () => {
    assert.ok(buildRoutePrompt('g', { language: '中文' }).includes('every note in 中文.'));
    assert.ok(buildRoutePrompt('g', { language: '  ' }).includes('every note in English.'));
  });

  test('cursor context is appended before the contract; absent when not given', () => {
    const p = buildRoutePrompt('who calls it?', undefined, {
      filePath: 'src/core/trail.ts',
      subjectName: 'nodeAt',
      startLine: 141,
      endLine: 155,
    });
    assert.ok(p.includes("cursor was on nodeAt in src/core/trail.ts (lines 141-155)"));
    assert.ok(p.indexOf('cursor was on') < p.indexOf('The output rules below are fixed'));
    assert.ok(!buildRoutePrompt('who calls it?').includes('cursor was on'));
  });
});

suite('routePrompt: buildTracePrompt', () => {
  test('embeds file, symbol and line span of the queried code', () => {
    const p = buildTracePrompt({
      filePath: 'src/vs/trailView.ts',
      subjectName: 'revealNode',
      startLine: 406,
      endLine: 419,
    });
    assert.ok(p.includes('File: src/vs/trailView.ts'));
    assert.ok(p.includes('Symbol: revealNode (lines 406-419)'));
    assert.ok(p.includes('entry points'));
    assert.ok(p.includes('The output rules below are fixed'));
  });
});
