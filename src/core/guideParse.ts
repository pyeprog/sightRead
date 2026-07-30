/**
 * Parsing/validation of an agent's guide response. Pure logic, no vscode
 * dependency. The agent is asked for bare JSON (see guidePrompt.ts) but real
 * responses may wrap it in code fences or prose — tolerated here.
 */

import { Guide, InterpretUnit } from './guide';

export interface GuideParseInput {
  raw: string;
  subject: string;
  unit: InterpretUnit;
  /** subject range, 0-based inclusive — steps are clipped to it */
  startLine: number;
  endLine: number;
}

export type GuideParseResult =
  | { ok: true; guide: Guide }
  | { ok: false; error: string };

const MAX_STEPS = 30;

function extractJson(raw: string): unknown | undefined {
  const candidates = [raw.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (_e) {
      // try the next candidate
    }
  }
  return undefined;
}

export function parseGuideResponse(
  input: GuideParseInput,
  newId: () => string,
): GuideParseResult {
  const parsed = extractJson(input.raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'the response contains no JSON object' };
  }
  const obj = parsed as { summary?: unknown; steps?: unknown };
  if (!Array.isArray(obj.steps)) {
    return { ok: false, error: 'the response JSON has no "steps" array' };
  }

  const steps = obj.steps
    .map((s: unknown) => {
      if (typeof s !== 'object' || s === null) {
        return undefined;
      }
      const { startLine, endLine, note, role } = s as Record<string, unknown>;
      if (typeof startLine !== 'number' || typeof endLine !== 'number') {
        return undefined;
      }
      if (typeof note !== 'string' || note.trim() === '') {
        return undefined;
      }
      // 1-based in the response → 0-based internally
      let start = Math.floor(Math.min(startLine, endLine)) - 1;
      let end = Math.floor(Math.max(startLine, endLine)) - 1;
      start = Math.max(start, input.startLine);
      end = Math.min(end, input.endLine);
      if (start > end) {
        return undefined; // entirely outside the subject
      }
      const roleTag =
        typeof role === 'string' && role.trim() !== '' ? role.trim().slice(0, 24) : undefined;
      return { id: newId(), startLine: start, endLine: end, note: note.trim(), role: roleTag };
    })
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .slice(0, MAX_STEPS)
    .sort((a, b) => a.startLine - b.startLine);

  if (steps.length === 0) {
    return { ok: false, error: 'the response has no valid steps inside the interpreted range' };
  }

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim() !== ''
      ? obj.summary.trim()
      : undefined;
  return {
    ok: true,
    guide: {
      id: newId(),
      subject: input.subject,
      unit: input.unit,
      startLine: input.startLine,
      endLine: input.endLine,
      summary,
      steps,
    },
  };
}
