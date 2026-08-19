/**
 * The shapes a model answer must take to be used at all.
 *
 * `complete()` parses the response against one of these inside the metered step,
 * so anything that does not fit comes back as `ok: false, value: null` with the
 * outcome `invalid_output` - and the pages then render their non-AI view. A
 * malformed answer is a missing answer here, never a half-rendered page.
 *
 * The schemas are deliberately tight. `citedIds` is bounded because an answer that
 * cites forty things is not an answer, and every string is length-capped because
 * an unbounded field is how a page gets wrecked by one bad generation.
 */
import { z } from 'zod';

export const AskAnswerSchema = z.object({
  answer: z.string().min(1).max(700),
  citedIds: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const DigestProseSchema = z.object({
  headline: z.string().min(1).max(120),
  summary: z.string().min(1).max(800),
});
export type DigestProse = z.infer<typeof DigestProseSchema>;

export const ExplainSchema = z.object({
  reason: z.string().min(1).max(200),
});
export type Explain = z.infer<typeof ExplainSchema>;
