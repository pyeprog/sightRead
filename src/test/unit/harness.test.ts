import * as assert from 'assert';
import {
  BUILTIN_HARNESSES,
  DETECTION_ORDER,
  HarnessProfile,
  buildInvocation,
  extractResult,
  resolveHarness,
} from '../../core/harness';

suite('harness: buildInvocation', () => {
  test('substitutes ${prompt} into argv and skips stdin', () => {
    const inv = buildInvocation(BUILTIN_HARNESSES.claude, 'read this');
    assert.ok(inv.args.includes('read this'));
    assert.strictEqual(inv.stdinPrompt, undefined);
  });

  test('falls back to stdin when args have no placeholder', () => {
    const inv = buildInvocation(BUILTIN_HARNESSES.codex, 'read this');
    assert.deepStrictEqual(inv.args, BUILTIN_HARNESSES.codex.args);
    assert.strictEqual(inv.stdinPrompt, 'read this');
  });
});

suite('harness: explore invocation', () => {
  test('buildInvocation picks exploreArgs in explore mode and falls back to args', () => {
    const explore = buildInvocation(BUILTIN_HARNESSES.claude, 'plan it', true);
    assert.ok(explore.args.includes('Read,Grep,Glob,LS'));
    assert.ok(!explore.args.includes('1'));
    const normal = buildInvocation(BUILTIN_HARNESSES.claude, 'plan it');
    assert.ok(normal.args.includes(''));
    // a profile without exploreArgs falls back gently
    const aider = buildInvocation(BUILTIN_HARNESSES.aider, 'plan it', true);
    assert.ok(aider.args.includes('plan it'));
  });

  test('claude, codex and opencode declare exploreArgs; the rest do not', () => {
    const capable = Object.entries(BUILTIN_HARNESSES)
      .filter(([, p]) => p.exploreArgs !== undefined)
      .map(([name]) => name)
      .sort();
    assert.deepStrictEqual(capable, ['claude', 'codex', 'opencode']);
  });
});

suite('harness: resolveHarness', () => {
  test('finds builtins by name; unknown names resolve to undefined', () => {
    assert.strictEqual(resolveHarness('claude', {})?.profile.command, 'claude');
    assert.strictEqual(resolveHarness('nope', {}), undefined);
    for (const name of DETECTION_ORDER) {
      assert.ok(resolveHarness(name, {}), `builtin ${name} must resolve`);
    }
  });

  test('a custom entry replaces a same-named builtin wholesale', () => {
    const custom: Record<string, HarnessProfile> = {
      claude: { command: 'my-claude', args: ['${prompt}'] },
    };
    const r = resolveHarness('claude', custom);
    assert.strictEqual(r?.profile.command, 'my-claude');
    assert.strictEqual(r?.profile.resultField, undefined); // no field merge
  });

  test('a malformed custom entry is ignored in favor of the builtin', () => {
    const custom = { claude: { command: '', args: 'oops' } } as unknown as Record<
      string,
      HarnessProfile
    >;
    assert.strictEqual(resolveHarness('claude', custom)?.profile.command, 'claude');
  });
});

suite('harness: extractResult', () => {
  test('reads the configured envelope field', () => {
    const out = JSON.stringify({ result: 'the guide', is_error: false });
    assert.deepStrictEqual(extractResult(out, BUILTIN_HARNESSES.claude), {
      ok: true,
      text: 'the guide',
    });
    const agy = JSON.stringify({ response: 'the guide', status: 'SUCCESS' });
    assert.deepStrictEqual(extractResult(agy, BUILTIN_HARNESSES.agy), {
      ok: true,
      text: 'the guide',
    });
  });

  test('errorField === true fails with the envelope text as the reason', () => {
    const out = JSON.stringify({ result: 'quota exceeded', is_error: true });
    const r = extractResult(out, BUILTIN_HARNESSES.claude);
    assert.deepStrictEqual(r, { ok: false, error: 'quota exceeded' });
  });

  test('plain-stdout profiles pass stdout through untouched', () => {
    const r = extractResult('{"steps":[]} trailing noise', BUILTIN_HARNESSES.codex);
    assert.deepStrictEqual(r, { ok: true, text: '{"steps":[]} trailing noise' });
  });

  test('an unparsable envelope falls back to raw stdout', () => {
    const r = extractResult('not json at all', BUILTIN_HARNESSES.claude);
    assert.deepStrictEqual(r, { ok: true, text: 'not json at all' });
  });
});
