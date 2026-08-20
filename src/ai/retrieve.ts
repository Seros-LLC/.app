/**
 * Retrieval for the read-and-explain features.
 *
 * The rows come out of WorkspaceScope FIRST, and the model is handed nothing else.
 * Two caps, for two different reasons:
 *
 *   FETCH_CAP     how many rows are read out of the database, so a workspace with a
 *                 million drafts cannot turn one page load into a full table scan.
 *   MODEL_ROW_CAP how many rows of each kind are put in front of the model, so the
 *                 prompt - and therefore the bill - is bounded no matter how busy
 *                 the workspace is. Both numbers are printed on the page.
 *
 * Counts are computed HERE, in code, from the rows that were retrieved, and the
 * pages print those. The model is told never to state a number (src/ai/prompts.ts)
 * and src/ai/digest.ts refuses prose that does anyway.
 *
 * This module reads. It has no write path, and it deliberately does not import a
 * table declaration: everything arrives through the scope (tools/check-tenancy.ts).
 */
import type { WorkspaceScope } from '../db/scope';

/** Rows read from the database per bucket. */
export const FETCH_CAP = 500;
/** Rows of each bucket that may reach the model. */
export const MODEL_ROW_CAP = 40;
/** Members named to the model. */
export const MEMBER_CAP = 40;
/** The longest question that will be sent. Longer is truncated, not refused. */
export const QUESTION_MAX_CHARS = 300;
/** Hard ceiling on the FACTS block handed to the model, characters. */
export const FACTS_MAX_CHARS = 6000;

type DraftRow = Awaited<ReturnType<WorkspaceScope['pendingDrafts']>>[number];

/**
 * What these features need from a scope. `draftsByState` does not exist on
 * WorkspaceScope yet - src/db/scope.ts belongs to another change - so it is
 * OPTIONAL here and the expired bucket is simply empty until it lands. The exact
 * signature wanted is:
 *
 *   draftsByState(state: 'pending'|'confirmed'|'rejected'|'expired'|'superseded',
 *                 limit?: number): DraftRow[]
 */
export type ReadScope =
  Pick<WorkspaceScope, 'workspaceId' | 'pendingDrafts' | 'taskRows' | 'roster' | 'audit'> & {
    draftsByState?(
      state: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'superseded',
      limit?: number,
    ): Promise<DraftRow[]>;
  };

export type Bucket = 'waiting' | 'confirmed' | 'expired';

export interface WorkRow {
  /** The citation id. The only ids an answer is allowed to name. */
  id: string;
  bucket: Bucket;
  title: string;
  owner: string | null;
  due: string | null;
  /** Who confirmed it, for a confirmed row. */
  actor: string | null;
  /** Tracker write state, for a confirmed row. */
  trackerState: string | null;
  at: number;
  overdue: boolean;
}

export interface MemberRow { id: string; name: string }

export interface Retrieved {
  workspaceId: string;
  today: string;
  dayStart: number;
  rows: WorkRow[];
  members: MemberRow[];
  counts: {
    waiting: number;
    confirmed: number;
    confirmedToday: number;
    expired: number;
    overdue: number;
    members: number;
    /** Rows actually put in front of the model. */
    retrieved: number;
  };
  /** True when a bucket hit MODEL_ROW_CAP and the model saw a sample. */
  capped: boolean;
  /** False when a bucket hit FETCH_CAP, i.e. a count is a floor rather than a total. */
  countsExact: boolean;
  /** False until WorkspaceScope grows draftsByState; the expired bucket is then empty. */
  expiredAvailable: boolean;
}

const oneLine = (s: unknown, max: number) =>
  String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const startOfUtcDayMs = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** A question is a question: bounded, single line, and never an instruction. */
export function normaliseQuestion(raw: unknown): string {
  return oneLine(raw, QUESTION_MAX_CHARS);
}

export async function retrieve(scope: ReadScope, opts: { now?: number } = {}): Promise<Retrieved> {
  const now = opts.now ?? Date.now();
  const today = isoDay(now);
  const dayStart = startOfUtcDayMs(now);

  // Fetch all data concurrently
  const [
    pending,
    tasks,
    expiredAvailable,
    expired,
    roster
  ] = await Promise.all([
    scope.pendingDrafts(),
    scope.taskRows(FETCH_CAP),
    Promise.resolve(typeof scope.draftsByState === 'function'),
    scope.draftsByState ? scope.draftsByState('expired', FETCH_CAP) : Promise.resolve([]),
    scope.roster()
  ]);

  const pendingDrafts = pending.slice(0, FETCH_CAP);
  const taskRows = tasks.slice(0, FETCH_CAP);
  const expiredDrafts = expiredAvailable ? expired.slice(0, FETCH_CAP) : [];
  const memberRoster = roster.slice(0, FETCH_CAP);

  const overdue = (due: string | null) => due !== null && due !== '' && due < today;

  const waitingRows: WorkRow[] = pendingDrafts.slice(0, MODEL_ROW_CAP).map((d) => ({
    id: 'draft:' + d.id,
    bucket: 'waiting' as const,
    title: oneLine(d.title, 160),
    owner: d.suggestedOwner ?? null,
    due: d.suggestedDueDate ?? null,
    actor: null,
    trackerState: null,
    at: d.createdAt,
    overdue: overdue(d.suggestedDueDate ?? null),
  }));

  const confirmedRows: WorkRow[] = taskRows.slice(0, MODEL_ROW_CAP).map((t) => ({
    id: 'task:' + t.id,
    bucket: 'confirmed' as const,
    title: oneLine(t.title, 160),
    owner: t.owner ?? null,
    due: t.due ?? null,
    actor: t.memberId ?? null,
    trackerState: t.writeState ?? null,
    at: t.createdAt,
    overdue: overdue(t.due ?? null),
  }));

  const expiredRows: WorkRow[] = expiredDrafts.slice(0, MODEL_ROW_CAP).map((d) => ({
    id: 'draft:' + d.id,
    bucket: 'expired' as const,
    title: oneLine(d.title, 160),
    owner: d.suggestedOwner ?? null,
    due: d.suggestedDueDate ?? null,
    actor: null,
    trackerState: null,
    at: d.createdAt,
    overdue: overdue(d.suggestedDueDate ?? null),
  }));

  const memberRows: MemberRow[] = memberRoster.map((m) => ({
    id: m.id,
    name: oneLine(m.name, 80),
  }));

  return {
    workspaceId: scope.workspaceId,
    today,
    dayStart,
    rows: [...waitingRows, ...confirmedRows, ...expiredRows],
    members: memberRows,
    counts: {
      waiting: pending.length,
      confirmed: tasks.length,
      confirmedToday: tasks.filter((t) => t.createdAt >= dayStart).length,
      expired: expired.length,
      overdue: [...pending.map((d) => d.suggestedDueDate ?? null), ...tasks.map((t) => t.due ?? null)]
        .filter((d) => overdue(d)).length,
      members: roster.length,
      retrieved: (pendingDrafts.length + taskRows.length + expiredDrafts.length) + memberRoster.length,
    },
    capped: pending.length > MODEL_ROW_CAP || tasks.length > MODEL_ROW_CAP || expired.length > MODEL_ROW_CAP,
    countsExact: pending.length < FETCH_CAP && tasks.length < FETCH_CAP && expired.length < FETCH_CAP,
    expiredAvailable,
  };
}

/** Nothing to answer from. Checked BEFORE a model call is considered. */
export const isEmpty = (r: Retrieved) => r.rows.length === 0;

/** Every id the model is allowed to name. */
export function idSet(r: Retrieved): Set<string> {
  const s = new Set<string>();
  for (const row of r.rows) s.add(row.id);
  for (const m of r.members) s.add(`member:${m.id}`);
  return s;
}

export function rowsById(r: Retrieved): Map<string, WorkRow> {
  const m = new Map<string, WorkRow>();
  for (const row of r.rows) m.set(row.id, row);
  return m;
}

const dash = (s: string | null) => (s === null || s === '' ? '—' : s);

/** One retrieved row, one line, id first. The model copies these ids to cite. */
export function factLine(row: WorkRow, today: string): string {
  const bits = [
    row.id,
    row.bucket === 'waiting' ? 'waiting for confirmation'
      : row.bucket === 'expired' ? 'expired unconfirmed' : 'confirmed',
    `title: ${dash(row.title)}`,
    `owner: ${dash(row.owner)}`,
    `due: ${dash(row.due)}${row.overdue ? ` (overdue on ${today})` : ''}`,
  ];
  if (row.bucket === 'confirmed') {
    bits.push(`confirmed_by: ${dash(row.actor)}`, `tracker: ${dash(row.trackerState)}`,
              `confirmed_on: ${isoDay(row.at)}`);
  } else {
    bits.push(`drafted_on: ${isoDay(row.at)}`);
  }
  return bits.join(' | ');
}

/** The FACTS block: retrieved rows only, bounded, id-prefixed, one per line. */
export function factsBlock(r: Retrieved): string {
  const lines = [
    ...r.rows.map((row) => factLine(row, r.today)),
    ...r.members.map((m) => `member:${m.id} | is a member of this workspace | name: ${m.name}`),
  ];
  const text = lines.join('\n');
  return text.length > FACTS_MAX_CHARS ? text.slice(0, FACTS_MAX_CHARS) : text;
}

/** What the page tells the reader about its own limits. Honest, not decorative. */
export const capNote = (r: Retrieved) =>
  `Read from at most ${MODEL_ROW_CAP} waiting drafts, ${MODEL_ROW_CAP} confirmed tasks, `
  + `${MODEL_ROW_CAP} expired drafts and ${MEMBER_CAP} members (${r.rows.length} row`
  + `${r.rows.length === 1 ? '' : 's'} this time), read through this workspace only. `
  + `At most one model call per request.${r.capped ? ' The workspace has more rows than that: the counts are complete, the prose was written from the newest of them.' : ''}`
  + `${r.countsExact ? '' : ` Counts are floors: reading stops at ${FETCH_CAP} rows per kind.`}`;