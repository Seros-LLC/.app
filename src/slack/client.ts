/**
 * The Slack boundary.
 *
 * Everything that talks to Slack goes through this interface, for the same
 * reason src/provider is the only thing that talks to a model: one place to
 * time out, one place to fail, one place a test can replace. No Slack type
 * escapes this directory.
 *
 * SEROS_SLACK selects the implementation - `http` (real) or `fake` (tests and
 * local development). Nothing else in the codebase knows which is in use.
 */

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  threadTs?: string;
  /** Bot and join/leave messages carry these; the caller skips them. */
  botId?: string;
  subtype?: string;
}

export interface SlackInstall {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  botToken: string;
  scopes: string;
}

export interface SlackClient {
  /** Exchanges the OAuth code for a bot token. */
  exchangeCode(code: string, redirectUri: string): Promise<SlackInstall>;
  /** Channels the bot can see. Public first; private only where invited. */
  listChannels(token: string, limit?: number): Promise<SlackChannel[]>;
  /** Messages in a channel, oldest-first, within a time window. */
  history(token: string, channelId: string, oldestEpochSec: number, limit?: number): Promise<SlackMessage[]>;
  /** A permalink back to the message, for the task the owner will read. */
  permalink(token: string, channelId: string, ts: string): Promise<string | null>;
  /** The tracker URL, replied into the thread the commitment came from. */
  postThreadReply(token: string, channelId: string, threadTs: string, text: string): Promise<boolean>;
}

const API = 'https://slack.com/api';

export class HttpSlackClient implements SlackClient {
  constructor(private readonly timeoutMs = Number(process.env.SEROS_SLACK_TIMEOUT_MS || 15_000)) {}

  async exchangeCode(code: string, redirectUri: string): Promise<SlackInstall> {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required');
    const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
    const data = await this.call<any>('oauth.v2.access', body, undefined);
    const token = data.access_token as string | undefined;
    if (!token) throw new Error('slack: oauth.v2.access returned no bot token');
    return {
      teamId: data.team?.id ?? '',
      teamName: data.team?.name ?? null,
      botUserId: data.bot_user_id ?? null,
      botToken: token,
      scopes: data.scope ?? '',
    };
  }

  async listChannels(token: string, limit = 200): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor = '';
    do {
      const body = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: String(Math.min(limit, 200)) });
      if (cursor) body.set('cursor', cursor);
      const data = await this.call<any>('conversations.list', body, token);
      for (const c of data.channels ?? []) out.push({ id: c.id, name: c.name ?? c.id, isPrivate: Boolean(c.is_private) });
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor && out.length < limit);
    return out;
  }

  async history(token: string, channelId: string, oldestEpochSec: number, limit = 500): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor = '';
    do {
      const body = new URLSearchParams({ channel: channelId, oldest: String(oldestEpochSec), limit: String(Math.min(200, limit)) });
      if (cursor) body.set('cursor', cursor);
      const data = await this.call<any>('conversations.history', body, token);
      for (const m of data.messages ?? []) {
        out.push({ ts: m.ts, user: m.user ?? '', text: typeof m.text === 'string' ? m.text : '',
                   threadTs: m.thread_ts, botId: m.bot_id, subtype: m.subtype });
      }
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor && out.length < limit);
    return out.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async permalink(token: string, channelId: string, ts: string): Promise<string | null> {
    try {
      const body = new URLSearchParams({ channel: channelId, message_ts: ts });
      const data = await this.call<any>('chat.getPermalink', body, token);
      return data.permalink ?? null;
    } catch {
      return null;                       // a missing link never blocks a task
    }
  }

  async postThreadReply(token: string, channelId: string, threadTs: string, text: string): Promise<boolean> {
    try {
      const body = new URLSearchParams({ channel: channelId, thread_ts: threadTs, text });
      await this.call<any>('chat.postMessage', body, token);
      return true;
    } catch {
      return false;
    }
  }

  private async call<T>(method: string, body: URLSearchParams, token: string | undefined): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${API}/${method}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`slack ${method}: HTTP ${res.status}`);
    const data = (await res.json()) as any;
    if (!data.ok) throw new Error(`slack ${method}: ${data.error ?? 'unknown_error'}`);
    return data as T;
  }
}

/** An in-process Slack, for tests and for running the app without an install. */
export class FakeSlackClient implements SlackClient {
  channels: SlackChannel[] = [
    { id: 'C-general', name: 'general', isPrivate: false },
    { id: 'C-delivery', name: 'delivery', isPrivate: false },
  ];
  messages = new Map<string, SlackMessage[]>();
  replies: Array<{ channelId: string; threadTs: string; text: string }> = [];

  async exchangeCode(_code: string, _redirectUri: string): Promise<SlackInstall> {
    return { teamId: 'T-fake', teamName: 'Fake Workspace', botUserId: 'B-fake', botToken: 'xoxb-fake', scopes: 'channels:history,channels:read' };
  }
  async listChannels(): Promise<SlackChannel[]> { return this.channels; }
  async history(_t: string, channelId: string, oldestEpochSec: number): Promise<SlackMessage[]> {
    return (this.messages.get(channelId) ?? []).filter((m) => Number(m.ts) >= oldestEpochSec);
  }
  async permalink(_t: string, channelId: string, ts: string): Promise<string | null> {
    return `https://fake.slack.invalid/archives/${channelId}/p${ts.replace('.', '')}`;
  }
  async postThreadReply(_t: string, channelId: string, threadTs: string, text: string): Promise<boolean> {
    this.replies.push({ channelId, threadTs, text });
    return true;
  }
}

let override: SlackClient | undefined;

/** Tests replace the client explicitly; nothing auto-detects a test environment. */
export function setSlackClient(c: SlackClient | undefined): void { override = c; }

export function slackClient(): SlackClient {
  if (override) return override;
  const choice = (process.env.SEROS_SLACK || 'fake').trim().toLowerCase();
  if (choice === 'http') return new HttpSlackClient();
  if (choice === 'fake') return new FakeSlackClient();
  throw new Error(`SEROS_SLACK=${JSON.stringify(choice)} is not a Slack client this build knows (http, fake)`);
}
