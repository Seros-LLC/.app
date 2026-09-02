import { TrackerNotConfigured } from './interface';
import type { TrackerTaskInput, TrackerWriteResult, TrackerWriter, TrackerOpenTask } from './interface';

/**
 * Linear, the v0 tracker.
 *
 * Chosen as the default because it is the cheapest of the roadmap's candidates
 * to build against and the fastest to demo. The choice is configuration
 * (SEROS_TRACKER), and business/ROADMAP.md is explicit that the five design
 * partners decide it - so nothing outside this file knows the tracker's name.
 *
 * Idempotency. Linear has no idempotency key on issueCreate, so the key is
 * written into the issue description as a marker and searched for before
 * creating. A timeout that actually succeeded upstream therefore resolves to
 * the existing issue on retry instead of creating a second one in a customer's
 * tracker, which ROADMAP/REVIEW call a trust incident.
 */

const API = 'https://api.linear.app/graphql';
const MARKER = (key: string) => `seros-idempotency-key: ${key}`;

interface GraphQlError { message?: string }

export class LinearTracker implements TrackerWriter {
  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly timeoutMs: number;

  constructor(opts?: { apiKey?: string; teamId?: string; timeoutMs?: number }) {
    const apiKey = opts?.apiKey ?? process.env.LINEAR_API_KEY ?? '';
    const teamId = opts?.teamId ?? process.env.LINEAR_TEAM_ID ?? '';
    if (!apiKey) throw new TrackerNotConfigured('LINEAR_API_KEY is required when SEROS_TRACKER=linear');
    if (!teamId) throw new TrackerNotConfigured('LINEAR_TEAM_ID is required when SEROS_TRACKER=linear');
    this.apiKey = apiKey;
    this.teamId = teamId;
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.SEROS_TRACKER_TIMEOUT_MS || 15_000);
  }

  getName(): string { return 'linear'; }
  async isReady(): Promise<boolean> { return Boolean(this.apiKey && this.teamId); }

  async write(input: TrackerTaskInput): Promise<TrackerWriteResult> {
    const existing = await this.findByKey(input.idempotencyKey);
    if (existing) return { ...existing, deduped: true };

    const data = await this.gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
      `mutation Create($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier url } }
       }`,
      { input: {
          teamId: this.teamId,
          title: input.title.slice(0, 250),
          description: this.description(input),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        } },
    );
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue) throw new Error('linear: issueCreate returned no issue');
    return { tracker: 'linear', externalId: issue.identifier || issue.id, externalUrl: issue.url };
  }

  async listOpenTasks(limit = 100): Promise<TrackerOpenTask[]> {
    const data = await this.gql<{ issues: { nodes: Array<{ identifier: string; title: string }> } }>(
      `query Open($teamId: ID!, $first: Int!) {
         issues(first: $first, filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "canceled"] } } }) {
           nodes { identifier title }
         }
       }`,
      { teamId: this.teamId, first: Math.min(limit, 250) },
    );
    return (data.issues?.nodes ?? []).map((n) => ({ externalId: n.identifier, title: n.title }));
  }

  /**
   * The task body the owner reads. Source link and quoted context are part of
   * the v0 draft contract: a task the owner has to ask a question about is the
   * problem the product exists to remove.
   */
  private description(input: TrackerTaskInput): string {
    const lines: string[] = [];
    if (input.outcome) lines.push(input.outcome, '');
    if (input.owner) lines.push(`Suggested owner: ${input.owner}`);
    if (input.dueDate) lines.push(`Due: ${input.dueDate}`);
    if (input.sourcePermalink) lines.push(`Source: ${input.sourcePermalink}`);
    if (input.context) lines.push('', '> ' + input.context.replace(/\n/g, '\n> '));
    lines.push('', '---', `Created by Seros after human confirmation ${input.confirmationId}.`, MARKER(input.idempotencyKey));
    return lines.join('\n');
  }

  private async findByKey(key: string): Promise<{ tracker: string; externalId: string; externalUrl: string } | null> {
    try {
      const data = await this.gql<{ issues: { nodes: Array<{ id: string; identifier: string; url: string }> } }>(
        `query Find($teamId: ID!, $q: String!) {
           issues(first: 1, filter: { team: { id: { eq: $teamId } }, description: { contains: $q } }) {
             nodes { id identifier url }
           }
         }`,
        { teamId: this.teamId, q: MARKER(key) },
      );
      const node = data.issues?.nodes?.[0];
      return node ? { tracker: 'linear', externalId: node.identifier || node.id, externalUrl: node.url } : null;
    } catch {
      // A failed lookup must not block the write; the worst case is the
      // duplicate this check is trying to avoid, and the claim lease already
      // makes that rare. Never turn a read failure into a lost task.
      return null;
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`linear: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: GraphQlError[] };
    if (body.errors?.length) throw new Error(`linear: ${body.errors.map((e) => e.message ?? 'error').join('; ')}`);
    if (!body.data) throw new Error('linear: empty response');
    return body.data;
  }
}
