/**
 * Prompt composition for the one-shot guide request. Pure logic, no vscode
 * dependency. The prompt has two parts: a per-unit reading-instructions
 * template (builtin defaults, replaceable via settings) and the fixed output
 * contract the parser depends on — always appended last, never user-editable,
 * and declared to override the template on conflict.
 *
 * The templates share one philosophy: notes are signposts, not summaries.
 * They label the ROLE of a region and the reason an entity exists — they
 * never describe what the code does, at any granularity.
 */

import { InterpretUnit } from './marks';

export interface SubjectContext {
  /** workspace-relative path, for the agent's orientation */
  filePath: string;
  languageId: string;
  unit: InterpretUnit;
  /** function name, class name, or file basename */
  subjectName: string;
  /** subject source with absolute 1-based line numbers prefixed */
  subjectText: string;
  /** leading import/header region; empty for the file unit (the source has it) */
  fileHeader: string;
}

export interface PromptOptions {
  /** user's per-unit template from settings; empty/undefined = builtin default */
  template?: string;
  /** per-run focus typed into the InputBox */
  userNote?: string;
  /** language of the generated summary/notes; empty/undefined = English */
  language?: string;
}

const USER_NOTE_PLACEHOLDER = '${userNote}';

const SHARED_PREAMBLE =
  'You are helping a developer read unfamiliar code. Your notes are signposts, not summaries: ' +
  'never describe what the code does — the reader can read. ' +
  'Label roles and give reasons for existence.\n' +
  '\n' +
  'File: ${filePath} (${languageId})\n' +
  'Subject: ${subjectName}\n' +
  '\n' +
  'File header (imports, for context only — never put steps here):\n' +
  '${fileHeader}\n' +
  '\n' +
  'Source (each line prefixed with its absolute line number):\n' +
  '${subjectText}\n' +
  '\n' +
  '${userNote}\n' +
  '\n';

const DEFAULT_TEMPLATES: Record<InterpretUnit, string> = {
  function:
    SHARED_PREAMBLE +
    'Annotate this FUNCTION on two layers:\n' +
    '- Structure: which region is the main body (the loop/flow the function exists for), ' +
    'which is setup that makes the main body possible, which is fallback, ' +
    'which handles special cases. Use roles: main, setup, fallback, special.\n' +
    '- Entities (role: entity): only the core variables and functions/closures a reader must hold in ' +
    'working memory — at most 9. For each, the note says WHY it exists (deduplication? a step of the ' +
    'algorithm? the return value?) — never its definition, contents, or where it is read/written; ' +
    'the code and the language server already show those.',
  class:
    SHARED_PREAMBLE +
    'Annotate this CLASS: one step per member (or coherent member group), anchored at its ' +
    'definition lines. The role tags the member\'s job in the class: entry, helper, util, ' +
    'lifecycle, state. The note says why the member exists in this class — ' +
    'never what its code does.',
  file:
    SHARED_PREAMBLE +
    'Annotate this FILE\'s overall structure: one step per top-level block (import/config region, ' +
    'core types, main flow, wiring, exports…). The role tags the block\'s job: config, types, ' +
    'core, wiring, util, exports. The note says why the block exists and how it serves the ' +
    'file\'s purpose — never what its code does.',
};

function contract(language: string): string {
  return (
    '\n\n' +
    'The output rules below are fixed and override anything above.\n' +
    '\n' +
    'Respond with ONLY a JSON object — no markdown fences, no prose — in exactly this shape:\n' +
    '{\n' +
    '  "summary": "<one sentence>",\n' +
    '  "steps": [\n' +
    '    { "startLine": <n>, "endLine": <n>, "role": "<short role tag>", "note": "<why, not what>" }\n' +
    '  ]\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- startLine/endLine are the absolute 1-based line numbers shown in the source; every step must lie inside the subject.\n' +
    '- Each step covers one coherent block of consecutive lines; steps must not overlap.\n' +
    '- List steps in ascending line order.\n' +
    '- Keep each note under 100 characters.\n' +
    `- Write the summary and every note in ${language}.`
  );
}

export function buildGuidePrompt(ctx: SubjectContext, opts?: PromptOptions): string {
  const template = opts?.template?.trim() ? opts.template : DEFAULT_TEMPLATES[ctx.unit];
  const note = opts?.userNote?.trim()
    ? `The reader specifically wants to know: ${opts.userNote.trim()}`
    : '';
  const hasNotePlaceholder = template.includes(USER_NOTE_PLACEHOLDER);
  const values: Record<string, string> = {
    filePath: ctx.filePath,
    languageId: ctx.languageId,
    subjectName: ctx.subjectName,
    subjectText: ctx.subjectText,
    fileHeader: ctx.fileHeader.trim() ? ctx.fileHeader : '(none)',
    userNote: note,
  };
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll('${' + key + '}', value);
  }
  if (note && !hasNotePlaceholder) {
    text += `\n\n${note}`;
  }
  return text + contract(opts?.language?.trim() || 'English');
}
