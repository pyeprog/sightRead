/**
 * Prompt composition for the reading-route requests (scenario A: goal →
 * route; scenario B: code position → entries). Pure logic, no vscode
 * dependency. Mirrors guidePrompt.ts: a replaceable exploration template
 * plus the fixed output contract the parser depends on — always appended
 * last, never user-editable, declared to override the template on conflict.
 *
 * Unlike the guide prompt, no source is pasted: the agent runs with
 * read-only exploration tools in the repository root and reads for itself.
 */

export interface RoutePromptOptions {
  /** user's template from settings; empty/undefined = builtin default */
  template?: string;
  /** language of the generated summary/notes; empty/undefined = English */
  language?: string;
}

/** the code the reader is at — scenario B's query */
export interface TraceContext {
  /** workspace-relative path */
  filePath: string;
  subjectName: string;
  /** 1-based, as shown to the agent */
  startLine: number;
  endLine: number;
}

const EXPLORE_PREAMBLE =
  'You are helping a developer read an unfamiliar codebase. You are running in the\n' +
  'repository root with read-only tools: explore the code with search and file\n' +
  'reads before answering. Never guess — verify every claim by reading the file.\n' +
  '\n';

const NOTES_RULE =
  'Notes are signposts, not summaries: each note says why the reader must pass\n' +
  'through this hop — never what the code does; the reader can read.\n';

const DEFAULT_ROUTE_TEMPLATE =
  EXPLORE_PREAMBLE +
  "The reader's goal:\n" +
  '${goal}\n' +
  '\n' +
  'Lay out a READING ROUTE: the tree of code locations the reader should read to\n' +
  'understand how this goal works in THIS repository.\n' +
  '\n' +
  'Building the route:\n' +
  '- The route starts at an entry: where the behavior is triggered or wired up —\n' +
  '  a command or route registration, an event subscription, a public API, a main\n' +
  '  function. The most upstream point from which everything below makes sense.\n' +
  '- If the goal asks who uses or calls a symbol, lay out a chain from EVERY\n' +
  '  entry that reaches it and include the symbol itself as each chain\'s last\n' +
  '  hop — a caller the reader never learns about is a surprise.\n' +
  '- Every non-entry hop must be directly called or used by its calledBy hop.\n' +
  "  Record the exact line in that hop's body where the call/use happens.\n" +
  '- Follow the spine that serves the goal; skip logging, error plumbing and side\n' +
  '  branches that do not answer it. Attach a side hop only for a critical\n' +
  '  reference — a data model, a key helper — without which the spine cannot be\n' +
  '  understood. Complex goals may need several components; keep only the ones\n' +
  '  that carry the mechanism.\n' +
  '- Stop when the core mechanism is reached — fewer hops is better.\n' +
  '- Mark "core": true on the few hops where the goal is actually implemented —\n' +
  '  the places that do the real work, not the plumbing that leads there.\n' +
  '- If the goal is broad, route the main execution path. If the goal cannot be\n' +
  '  found in this repository, return an empty hops array and use the summary to\n' +
  '  say what you searched for and the closest thing you found.\n' +
  '\n' +
  NOTES_RULE;

const DEFAULT_TRACE_TEMPLATE =
  EXPLORE_PREAMBLE +
  'The reader is looking at this code and does not know where it is reached from:\n' +
  'File: ${filePath}\n' +
  'Symbol: ${subjectName} (lines ${startLine}-${endLine})\n' +
  '\n' +
  'Find the entry points this code serves, and lay out a READING ROUTE from each\n' +
  'relevant entry down to this code.\n' +
  '\n' +
  'Building the route:\n' +
  '- An entry is where behavior is triggered or wired up — a command or route\n' +
  '  registration, an event subscription, a public API, a main function.\n' +
  '- List EVERY entry whose path reaches this code — an entry the reader never\n' +
  '  learns about is a surprise, not a simplification. Mark "core": true on\n' +
  '  every entry hop.\n' +
  '- Every non-entry hop must be directly called or used by its calledBy hop, with\n' +
  "  the exact call/use line. Each chain ends at the symbol above — include it as\n" +
  "  the chain's last hop.\n" +
  '- Follow the spine of each chain; attach a side hop only for a critical\n' +
  '  reference without which the chain cannot be understood. Fewer hops is better.\n' +
  '- If no path from any entry reaches this code, return an empty hops array and\n' +
  '  use the summary to say what you searched and the closest caller you found.\n' +
  '\n' +
  NOTES_RULE;

function contract(language: string): string {
  return (
    '\n\n' +
    'The output rules below are fixed and override anything above.\n' +
    '\n' +
    'Respond with ONLY a JSON object — no markdown fences, no prose — in exactly this shape:\n' +
    '{\n' +
    '  "summary": "<one sentence: where the goal lives and how the route reaches it>",\n' +
    '  "hops": [\n' +
    '    { "file": "<workspace-relative path>",\n' +
    '      "symbol": "<function/class name>",\n' +
    '      "container": "<enclosing class or outer function; omit if none>",\n' +
    '      "kind": "function" | "method" | "class" | "module",\n' +
    '      "line": <1-based line of the definition>,\n' +
    '      "note": "<why this hop, under 100 characters>",\n' +
    '      "core": <true only on the hops the instructions above mark as core; omit otherwise>,\n' +
    '      "calledBy": <hop number (1-based) whose code calls or uses this one; omit for an entry/root hop>,\n' +
    '      "callsiteLine": <1-based line in the calledBy hop\'s body where the call/use happens; omit when calledBy is absent> }\n' +
    '  ]\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- The order of the hops array carries no meaning — structure comes only from calledBy. A hop may reference any other hop.\n' +
    '- file/symbol/line must be real — copied from files you actually read.\n' +
    '- Keep each tree small: at most 12 hops per tree (a chain plus its side references). The number of trees follows the number of real entries.\n' +
    `- Write the summary and every note in ${language}.`
  );
}

function substitute(template: string, values: Record<string, string>): string {
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll('${' + key + '}', value);
  }
  return text;
}

export function buildRoutePrompt(goal: string, opts?: RoutePromptOptions): string {
  const template = opts?.template?.trim() ? opts.template : DEFAULT_ROUTE_TEMPLATE;
  let text = substitute(template, { goal });
  if (!template.includes('${goal}')) {
    text += `\n\nThe reader's goal: ${goal}`;
  }
  return text + contract(opts?.language?.trim() || 'English');
}

export function buildTracePrompt(ctx: TraceContext, opts?: RoutePromptOptions): string {
  const template = opts?.template?.trim() ? opts.template : DEFAULT_TRACE_TEMPLATE;
  let text = substitute(template, {
    filePath: ctx.filePath,
    subjectName: ctx.subjectName,
    startLine: String(ctx.startLine),
    endLine: String(ctx.endLine),
  });
  if (!template.includes('${subjectName}')) {
    text += `\n\nThe reader is at: ${ctx.subjectName} in ${ctx.filePath} (lines ${ctx.startLine}-${ctx.endLine})`;
  }
  return text + contract(opts?.language?.trim() || 'English');
}
