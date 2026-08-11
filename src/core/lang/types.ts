/**
 * Shared types for segmentation and the per-language syntax modules
 * (design.md §3.4). Pure types, no vscode dependency.
 */

export type SegmentKind =
  | 'branch'
  | 'loop'
  | 'try'
  | 'with'
  | 'switch'
  | 'definition'
  | 'assignment'
  | 'call'
  | 'flow'
  | 'other';

/** Structural name + kind summarizing one segment — see LanguageSyntax.classify. */
export interface Summary {
  kind: SegmentKind;
  name: string;
  /**
   * Condensed header expression — the `if` condition, loop header, `return`
   * value… Rendered as dimmed detail text next to the structural name.
   */
  detail?: string;
}

export interface SegmentationOptions {
  /** a block unit shorter than this merges with neighbours like plain lines */
  minBlockLines: number;
  maxNameLength: number;
  /** recursion depth limit */
  maxDepth: number;
  /** max `a=..`/`f(...)` tokens in a statement-summary name */
  maxSummaryTokens: number;
  /** hard character budget for a node's condensed `detail` expression */
  maxDetailLength: number;
}

/**
 * One language's syntax, implemented as a function group — one module per
 * language under lang/, picked wholesale via `syntaxFor(languageId)`. The
 * segmentation algorithm itself is language-independent and delegates every
 * language-specific decision to these four functions.
 */
export interface LanguageSyntax {
  /**
   * Whether a top-level line starting like this attaches to the unit above it
   * instead of opening a new unit: closers, else/catch chains, method chains…
   * Receives the line with leading whitespace stripped.
   */
  isContinuationLine(trimmed: string): boolean;
  /**
   * Whether the line opens with a structural keyword. Such a line must not
   * share a segment with the statements around it — the name would be taken
   * from whichever line came first and the rest would go unrendered. Keep in
   * sync with the keyword cases in the same module's `classify`.
   */
  isKeywordLead(trimmed: string): boolean;
  /**
   * The full naming chain for one segment: branch/loop/try/with/switch by
   * keyword, then definitions and flow statements, falling back to the
   * language-neutral statement summary (`a=f(...)` dataflow edges).
   */
  classify(top: string[], opts: SegmentationOptions): Summary;
  /**
   * Index of the first line after the definition's signature, scanning from
   * the signature's first line; 1 when no signature end is recognized.
   */
  findBodyStart(lines: string[]): number;
}
