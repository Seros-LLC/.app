import type { TrackerTaskInput, TrackerWriteResult, TrackerWriter, TrackerOpenTask } from './interface';

/**
 * The tracker used by tests and local development.
 *
 * It is a real implementation of the contract - it returns an id, records what
 * it was asked to write, and can be told to fail - not a stub that always
 * succeeds. Tests assert on `writes`, and the worker cannot tell it apart from
 * a network adapter.
 */
export class FakeTrackerWriter implements TrackerWriter {
  readonly writes: TrackerTaskInput[] = [];
  private failNext = 0;
  private counter = 0;

  constructor(private readonly name: string = 'fake') {}

  getName(): string { return this.name; }
  async isReady(): Promise<boolean> { return true; }

  /** Make the next `n` calls throw, the way a provider outage would. */
  failFor(n: number): void { this.failNext = n; }

  async write(input: TrackerTaskInput): Promise<TrackerWriteResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('fake tracker: upstream unavailable');
    }
    // An adapter must not create twice for one idempotency key.
    const prior = this.writes.find((w) => w.idempotencyKey === input.idempotencyKey);
    if (prior) {
      return { tracker: this.name, externalId: `FAKE-${this.indexOfKey(input.idempotencyKey)}`,
               externalUrl: `https://tracker.invalid/FAKE-${this.indexOfKey(input.idempotencyKey)}`, deduped: true };
    }
    this.writes.push(input);
    this.counter += 1;
    const id = `FAKE-${this.counter}`;
    return { tracker: this.name, externalId: id, externalUrl: `https://tracker.invalid/${id}` };
  }

  async listOpenTasks(limit = 100): Promise<TrackerOpenTask[]> {
    return this.writes.slice(0, limit).map((w, i) => ({ externalId: `FAKE-${i + 1}`, title: w.title }));
  }

  private indexOfKey(key: string): number {
    return this.writes.findIndex((w) => w.idempotencyKey === key) + 1;
  }
}
