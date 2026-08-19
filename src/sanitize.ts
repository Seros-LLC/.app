/**
 * Guards over model output. The model proposes; these functions refuse.
 *
 * DATA-MODEL.md: suggested_due_date is set only when a date is explicit in the
 * text, never guessed. A 7b model will cheerfully invent "2023-04-21" for
 * "before the demo on Friday", so a date is dropped unless we can tie it to
 * something actually written down.
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function sanitizeDueDate(text: string, proposed: string | null, now = new Date()): string | null {
  if (!proposed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed)) return null;
  const d = new Date(proposed + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (d < today) return null;                                   // never a date in the past
  if (d.getTime() - today.getTime() > 365 * 86400_000) return null;

  const lower = text.toLowerCase();

  // 1. the text states a real calendar date
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(lower)) return proposed;
  if (/\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/.test(lower)) return proposed;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/.test(lower)) return proposed;

  // 2. "tomorrow" / "today"
  const dayDelta = Math.round((d.getTime() - today.getTime()) / 86400_000);
  if (/\btoday\b/.test(lower) && dayDelta === 0) return proposed;
  if (/\btomorrow\b/.test(lower) && dayDelta === 1) return proposed;

  // 3. a named weekday, and the proposed date really is that weekday, within a week
  const named = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (named >= 0 && dayDelta >= 0 && dayDelta <= 7 && d.getUTCDay() === named) return proposed;

  return null;   // relative, vague, or hallucinated -> the human fills it in
}

/**
 * The owner must be someone we actually know. A model reading "send the deck to
 * Priya" will happily propose Priya, who is the recipient, not the person who
 * undertook anything. Unless the proposal maps to a real member, the author of
 * the message owns it, because the author is who made the commitment.
 */
export function resolveOwner(
  proposed: string | null,
  authorId: string,
  members: { id: string; name: string }[],
): { owner: string; mapping: 'explicit' | 'author_fallback' } {
  if (proposed) {
    const p = proposed.trim().toLowerCase();
    const hit = members.find((m) => m.id.toLowerCase() === p || m.name.toLowerCase() === p);
    if (hit) return { owner: hit.id, mapping: 'explicit' };
  }
  return { owner: authorId, mapping: 'author_fallback' };
}
