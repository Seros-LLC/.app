import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { dialect, resultRows } from './db/client';
import { sessionSecret } from './auth';

export function subjectHash(bucket: string, subject: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(`ratelimit:${bucket}:${subject || 'unknown'}`).digest('hex');
}

/** Atomically consumes one fixed-window admission across all app instances. */
export async function admitRateLimit(db: Db, bucket: string, subject: string, max: number, windowMs: number, now = Date.now()): Promise<{ admitted: boolean; resetAt: number }> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const q = sql`INSERT INTO rate_limit_windows (bucket, subject_hash, window_start, hits)
    VALUES (${bucket}, ${subjectHash(bucket, subject)}, ${windowStart}, 1)
    ON CONFLICT(bucket, subject_hash, window_start) DO UPDATE SET hits = rate_limit_windows.hits + 1
      WHERE rate_limit_windows.hits < ${max}
    RETURNING hits`;
  const rows = dialect() === 'pg' ? resultRows(await (db as any).execute(q)) : db.all(q);
  return { admitted: (rows as any[]).length === 1, resetAt: windowStart + windowMs };
}
