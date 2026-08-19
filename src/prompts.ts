/**
 * Prompts live here, versioned, because the meter records which version produced a
 * result and a rollback has to be a flag flip rather than a deploy.
 *
 * v2 exists because the evaluation harness said so. Against the 122-example golden
 * set, v1 scored 81.0% precision at 95.9% recall, and every false positive but two
 * came from one family: statements about where a person will BE, what they will NOT
 * do, and what a system will do on its own. The model rated those 100. No threshold
 * fixes a confident wrong answer, so the instruction changed instead.
 */
export const DETECT_PROMPT_VERSION = 'detect/v2';
export const DRAFT_PROMPT_VERSION = 'draft/v2';

export const DETECT_SYSTEM = [
  'You decide whether a chat message contains a COMMITMENT: the speaker undertaking to do a piece of work.',
  'Reply ONLY with JSON: {"isCommitment":boolean,"confidence":0-100,"reason":string}.',
  '',
  'It IS a commitment when the speaker themselves takes on work, whether or not a deadline is given,',
  'and whether phrased as "I will", "I\'ll", "on it", "leave it with me", "taking this one", or "I can have it ready".',
  '',
  'It is NOT a commitment when:',
  '- the message only says where the speaker will BE or will not be: attendance, travel, holiday, being on a call, being out of office. Being somewhere is not a deliverable.',
  '- the speaker says what they will NOT do, or declines.',
  '- the work belongs to someone else, is reported second hand ("Sarah said she\'d look into it"), or is being requested of someone else.',
  '- a system, bot, integration or scheduled process is what will act.',
  '- it is a question, a suggestion, a hypothetical, a plan the team is merely considering, or praise.',
  '- the work is already finished.',
  '',
  'Precision matters more than recall: when unsure, answer false. A missed commitment costs nothing; a wrong task in someone else\'s tracker costs trust.',
].join('\n');

export const draftSystem = (now = new Date()) => {
  const iso = now.toISOString().slice(0, 10);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()];
  return [
    'You turn a chat message into a task draft. Reply ONLY with JSON:',
    '{"title":string,"outcome":string,"proposedOwner":string|null,"dueDate":"YYYY-MM-DD"|null,"confidence":0-100}.',
    `Today is ${iso}, a ${day}. Resolve "tomorrow" or a named weekday against that date.`,
    'If the message states no deadline at all, dueDate MUST be null. Never guess one.',
    'proposedOwner is whoever undertook the work, never the person it is being sent to. Use null if unclear.',
    'The title is what someone would read in a tracker: short, concrete, no pleasantries.',
  ].join('\n');
};
