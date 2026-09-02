/**
 * The tracker boundary.
 *
 * v0 writes to exactly one tracker (business/ROADMAP.md, "Tracker write"). This
 * interface exists so the choice is configuration rather than a code change, and
 * so the worker can be tested without a network.
 *
 * The contract the worker relies on:
 *   - `write` either returns an external id and url, or throws. It never returns
 *     success without an id, because `tasks.write_state='created'` is set from
 *     that answer and must mean the issue exists.
 *   - `write` is called at most once per task under a claim, and carries an
 *     `idempotencyKey` so an adapter can recognise its own earlier attempt after
 *     a timeout that actually succeeded upstream.
 */

/** Everything a tracker needs to create the task a human confirmed. */
export interface TrackerTaskInput {
  workspaceId: string;
  taskId: string;
  confirmationId: string;
  /** Stable per task. An adapter should use it to avoid creating a duplicate. */
  idempotencyKey: string;
  title: string;
  outcome: string;
  /** Workspace member id of the suggested owner, or null when unknown. */
  owner: string | null;
  /** ISO date, or null. v0 never guesses a date (ROADMAP.md, "Routing"). */
  dueDate: string | null;
  /** Permalink back to the message the commitment came from, when known. */
  sourcePermalink: string | null;
  /** Quoted source context for the owner, when retention still holds it. */
  context: string | null;
  labels: string[];
}

/** What the tracker answered. An id is mandatory: see the note above. */
export interface TrackerWriteResult {
  tracker: string;
  externalId: string;
  externalUrl: string;
  /** True when the adapter found its own earlier attempt instead of creating. */
  deduped?: boolean;
}

/** An open task already in the tracker, for dedupe before drafting. */
export interface TrackerOpenTask {
  externalId: string;
  title: string;
}

export interface TrackerWriter {
  getName(): string;
  /** Creates the task. Throws on any failure; never invents an id. */
  write(input: TrackerTaskInput): Promise<TrackerWriteResult>;
  /** Configuration is present and usable. Does not prove the token is valid. */
  isReady(): Promise<boolean>;
  /** Open tasks, for deduplication (ROADMAP.md, "Detection"). Optional in v0. */
  listOpenTasks?(limit?: number): Promise<TrackerOpenTask[]>;
}

/** Thrown when a tracker is selected but not configured. */
export class TrackerNotConfigured extends Error {}
