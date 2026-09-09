/**
 * src/audit-replay.ts — the seven-day capture-rate replay (`npm run replay:capture`).
 *
 * The founder sits with a prospect, points this at their workspace, and the tool
 * answers one question honestly: "how many commitments did the last N days of
 * your Slack contain that nobody tracked?" Ingestion is otherwise live-webhook
 * only, so a workspace connected five minutes ago has an empty queue and there
 * is nothing to show. This reads BACKWARDS through Slack history instead.
 *
 * NOT src/replay.ts. That file is webhook nonce/replay-attack protection and is
 * unrelated to this one; the shared word is a collision, not a relationship.
 *
 * THREE RULES, and they are the whole design:
 *
 *  1. READ-ONLY. This tool never creates a draft, a confirmation or a task. It
 *     does not call scope.createDraft() or scope.confirm(), and it must never
 *     learn how: a replay that wrote tracker work would be Seros creating tasks
 *     no human confirmed, which is the one thing the product promises it cannot
 *     do (ADR 0002, PRODUCT.md "Human confirmation is mandatory").
 *  2. SELECTED CHANNELS ONLY. The channel picker is the permission record, so
 *     this reads exactly what `scope.selectedChannels()` returns and nothing
 *     else — the same promise the webhook keeps in src/routes/webhook.ts.
 *  3. THE SAME DETECTOR AS THE WORKER. The number quoted to a prospect is only
 *     worth quoting if it is the number the product would actually have
 *     produced, so detection goes through `complete(..., DetectionSchema)` with
 *     DETECT_SYSTEM and the worker's own detectThreshold().
 *
 * COUNTS AND IDS ONLY on stdout, never message content — the same house rule as
 * src/limits-cli.ts. Every line is one JSON object.
 */
import { migrateDbAsync, openDb } from './db/client';
import { WorkspaceScope } from './db/scope';
import { open as openSecret } from './crypto';
import { slackClient } from './slack/client';
import { complete, dbMeterContext, DetectionSchema } from './provider/index';
import { DETECT_SYSTEM } from './prompts';
import { detectThreshold } from './worker';

const DEFAULT_DAYS = 7;
const DAY_SEC = 86_400;

const USAGE = `usage:
  npm run replay:capture -- <workspaceId> [--days N]

  Replays the last N days (default ${DEFAULT_DAYS}) of the channels the admin selected,
  runs the production detector over them, and reports how many commitments are
  in there. It writes no drafts, no confirmations and no tasks.`;

export interface ChannelReport {
  channelId: string;
  messagesScanned: number;
  messagesSkipped: number;
  commitmentsDetected: number;
  detectorUnavailable: number;
  /** Slack timestamps of the detected messages: ids, never text. */
  detectedTs: string[];
}

export interface ReplayReport {
  workspaceId: string;
  days: number;
  oldestEpochSec: number;
  threshold: number;
  channelsScanned: number;
  messagesScanned: number;
  messagesSkipped: number;
  commitmentsDetected: number;
  detectorUnavailable: number;
  channels: ChannelReport[];
}

export interface ParsedArgs {
  workspaceId: string | undefined;
  days: number;
}

/** `<workspaceId> [--days N]`, with SEROS_WORKSPACE as the fallback tenant. */
export function parseArgs(argv: string[]): ParsedArgs {
  let workspaceId: string | undefined;
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--days' || a === '-d') {
      days = readDays(argv[++i]);
    } else if (a.startsWith('--days=')) {
      days = readDays(a.slice('--days='.length));
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${JSON.stringify(a)}`);
    } else if (workspaceId === undefined) {
      workspaceId = a;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    }
  }
  return { workspaceId: workspaceId ?? process.env.SEROS_WORKSPACE, days };
}

function readDays(raw: string | undefined): number {
  const n = Number(raw);
  // `n > 0` is false for NaN, but say so out loud rather than quietly using 7:
  // a typo'd window would silently change the number a prospect is quoted.
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0 || n > 365) {
    throw new Error(`--days must be a number 1-365, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Bot posts, joins/leaves and empty lines are not commitments anybody made. */
function worthDetecting(m: { text: string; botId?: string; subtype?: string }): boolean {
  if (m.botId || m.subtype) return false;
  return m.text.trim().length > 0;
}

/**
 * Read the selected channels and count what the detector finds.
 *
 * Exported so tests can drive it against the fake Slack client without going
 * through a process. It takes a db handle and returns a report; it writes no
 * tenant rows other than the audit trail and the ActionMeter rows the provider
 * writes for itself (invariant 15: a model call that is not metered does not
 * happen).
 */
export async function replayCapture(
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  opts: { days?: number; now?: number; limit?: number } = {},
): Promise<ReplayReport> {
  const days = opts.days ?? DEFAULT_DAYS;
  const now = opts.now ?? Date.now();
  const oldestEpochSec = Math.floor(now / 1000) - Math.round(days * DAY_SEC);
  const threshold = detectThreshold();

  const scope = await WorkspaceScope.open(db, workspaceId);

  const conn = await scope.connection();
  if (!conn) throw new Error(`workspace ${workspaceId} has no live Slack connection`);
  const token = openSecret(conn.tokenEnc);
  if (!token) throw new Error('the stored Slack token could not be opened (SEROS_ENCRYPTION_KEY changed?)');

  // The permission record, and the ONLY list this tool is allowed to read.
  const selected = await scope.selectedChannels();

  const slack = slackClient();
  const meter = dbMeterContext(db, workspaceId);

  const report: ReplayReport = {
    workspaceId, days, oldestEpochSec, threshold,
    channelsScanned: selected.length,
    messagesScanned: 0, messagesSkipped: 0, commitmentsDetected: 0, detectorUnavailable: 0,
    channels: [],
  };

  for (const ch of selected) {
    const c: ChannelReport = {
      channelId: ch.channelId, messagesScanned: 0, messagesSkipped: 0,
      commitmentsDetected: 0, detectorUnavailable: 0, detectedTs: [],
    };
    const history = opts.limit === undefined
      ? await slack.history(token, ch.channelId, oldestEpochSec)
      : await slack.history(token, ch.channelId, oldestEpochSec, opts.limit);

    for (const m of history) {
      if (!worthDetecting(m)) { c.messagesSkipped++; continue; }
      c.messagesScanned++;
      const det = await complete(
        meter,
        { tier: 'cheap', purpose: 'detect', system: DETECT_SYSTEM, user: m.text },
        DetectionSchema,
      );
      if (!det.ok || det.value === null) {
        // A provider outage is reported as an outage, not as "no commitments".
        c.detectorUnavailable++;
        continue;
      }
      if (det.value.isCommitment && det.value.confidence >= threshold) {
        c.commitmentsDetected++;
        c.detectedTs.push(m.ts);
      }
    }

    report.channels.push(c);
    report.messagesScanned += c.messagesScanned;
    report.messagesSkipped += c.messagesSkipped;
    report.commitmentsDetected += c.commitmentsDetected;
    report.detectorUnavailable += c.detectorUnavailable;
  }

  // Counts only. Reading a customer's history is an act that belongs in the log.
  await scope.audit('replay.capture', 'ok', {
    days, channels: report.channelsScanned,
    messages_scanned: report.messagesScanned,
    commitments_detected: report.commitmentsDetected,
    detector_unavailable: report.detectorUnavailable,
  }, { actorType: 'operator' });

  return report;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); return; }
  const { workspaceId, days } = parseArgs(argv);
  if (!workspaceId) { console.error(USAGE); process.exitCode = 2; return; }

  await migrateDbAsync();
  const db = openDb();
  const report = await replayCapture(db, workspaceId, { days });

  for (const c of report.channels) {
    console.log(JSON.stringify({
      workspace_id: report.workspaceId, event: 'replay.channel',
      channel_id: c.channelId,
      messages_scanned: c.messagesScanned, messages_skipped: c.messagesSkipped,
      commitments_detected: c.commitmentsDetected,
      detector_unavailable: c.detectorUnavailable,
      detected_ts: c.detectedTs,
    }));
  }

  console.log(JSON.stringify({
    workspace_id: report.workspaceId, event: 'replay.done',
    days: report.days, oldest_epoch_sec: report.oldestEpochSec,
    detect_threshold: report.threshold,
    channels_scanned: report.channelsScanned,
    messages_scanned: report.messagesScanned,
    messages_skipped: report.messagesSkipped,
    commitments_detected: report.commitmentsDetected,
    detector_unavailable: report.detectorUnavailable,
    // Said plainly, because it is the promise the demo is making:
    wrote_drafts: 0, wrote_confirmations: 0, wrote_tasks: 0,
  }));

  // A window where the detector could not answer is not a clean result.
  if (report.detectorUnavailable > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'replay.capture_failed', error: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
