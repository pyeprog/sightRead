import * as assert from 'assert';
import { SubjectContext, buildGuidePrompt } from '../../core/guidePrompt';

const ctx: SubjectContext = {
  filePath: 'src/x.ts',
  languageId: 'typescript',
  unit: 'function',
  subjectName: 'parseConfig',
  subjectText: '6\tfunction parseConfig() {\n7\t}',
  fileHeader: "import * as fs from 'fs';",
};

const CONTRACT_MARK = 'The output rules below are fixed and override anything above.';

suite('guidePrompt: buildGuidePrompt', () => {
  test('default template substitutes placeholders and puts the contract last', () => {
    const p = buildGuidePrompt(ctx);
    assert.ok(p.includes('src/x.ts'));
    assert.ok(p.includes('parseConfig'));
    assert.ok(p.includes('function parseConfig()'));
    assert.ok(!p.includes('${filePath}'));
    assert.ok(p.indexOf(CONTRACT_MARK) > p.indexOf('parseConfig'));
    assert.ok(p.includes('"startLine"')); // contract shape survives
  });

  test('a custom template still gets the contract appended after it', () => {
    const p = buildGuidePrompt(ctx, { template: 'Read ${subjectName} in ${filePath}.' });
    assert.ok(p.startsWith('Read parseConfig in src/x.ts.'));
    assert.ok(p.includes(CONTRACT_MARK));
  });

  test('each unit selects its own builtin template', () => {
    assert.ok(buildGuidePrompt(ctx).includes('Annotate this FUNCTION'));
    assert.ok(buildGuidePrompt({ ...ctx, unit: 'class' }).includes('Annotate this CLASS'));
    assert.ok(buildGuidePrompt({ ...ctx, unit: 'file' }).includes("Annotate this FILE"));
  });

  test('userNote fills ${userNote} or is appended when the template lacks it', () => {
    const withPlaceholder = buildGuidePrompt(ctx, { userNote: 'why the retry loop?' });
    assert.ok(withPlaceholder.includes('The reader specifically wants to know: why the retry loop?'));

    const without = buildGuidePrompt(ctx, {
      template: 'Read ${subjectName}.',
      userNote: 'why the retry loop?',
    });
    const noteAt = without.indexOf('The reader specifically wants to know: why the retry loop?');
    assert.ok(noteAt > -1 && noteAt < without.indexOf(CONTRACT_MARK));

    const noNote = buildGuidePrompt(ctx);
    assert.ok(!noNote.includes('specifically wants to know'));
  });

  test('language: English by default, setting value lands in the contract', () => {
    assert.ok(buildGuidePrompt(ctx).includes('every note in English'));
    const zh = buildGuidePrompt(ctx, { language: '简体中文' });
    assert.ok(zh.includes('every note in 简体中文'));
    assert.ok(!zh.includes('in English'));
  });
});
