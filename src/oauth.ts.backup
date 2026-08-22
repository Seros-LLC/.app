/**
 * OAuth provider management.
 *
 * Manages OAuth providers (Google, GitHub) linked to member accounts.
 */

import { and, eq } from 'drizzle-orm';
import { affectedRows } from './db/client';
import { memberCredentials, oauthProviders, members } from './db/schema';

type Db = ReturnType<typeof import('./db/client').openDb>;

export type OAuthProvider = 'google' | 'github';
export type OAuthInfo = {
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  name: string | null;
};

/**
 * Ensure a member exists for the given email, or create one.
 */
export async function ensureMemberForOAuth(db: Db, workspaceId: string, email: string | null, name: string | null): Promise<string> {
  const memberId = email ? email.toLowerCase().split('@')[0] + '-' + Buffer.from(email).toString('base64url').slice(0, 8) : 'oauth-' + Math.random().toString(36).slice(2, 10);

  const existing = await db.select().from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.id, memberId)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(members).values({
      workspaceId,
      id: memberId,
      name: name || email || 'OAuth User',
      role: 'viewer',
      status: 'active',
    });
  }

  return memberId;
}

/**
 * Link an OAuth provider to a member.
 */
export async function linkOAuth(db: Db, workspaceId: string, memberId: string, info: OAuthInfo): Promise<void> {
  const now = Date.now();
  await db.insert(oauthProviders)
    .values({
      workspaceId,
      memberId,
      provider: info.provider,
      providerUserId: info.providerUserId,
      email: info.email,
      name: info.name,
      createdAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Find a member by OAuth provider and user ID.
 */
export async function findMemberByOAuth(db: Db, workspaceId: string, provider: OAuthProvider, providerUserId: string): Promise<{ memberId: string; member: any } | null> {
  const rows = await db.select()
    .from(oauthProviders)
    .where(and(
      eq(oauthProviders.workspaceId, workspaceId),
      eq(oauthProviders.provider, provider),
      eq(oauthProviders.providerUserId, providerUserId)
    ))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const member = await db.select().from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.id, row.memberId)))
    .limit(1);

  if (member.length === 0) return null;

  return { memberId: row.memberId, member: member[0]! } as { memberId: string; member: any };
}

/**
 * Find a member by email across all OAuth providers.
 */
export async function findMemberByEmail(db: Db, workspaceId: string, email: string): Promise<{ memberId: string } | null> {
  const rows = await db.select()
    .from(oauthProviders)
    .where(and(
      eq(oauthProviders.workspaceId, workspaceId),
      eq(oauthProviders.email, email.toLowerCase())
    ))
    .limit(1);

  if (rows.length === 0) return null;

  return { memberId: rows[0]!.memberId } as { memberId: string };
}

/**
 * Get password version for a member (for session invalidation).
 */
export async function getPasswordVersion(db: Db, workspaceId: string, memberId: string): Promise<number> {
  const row = await db.select().from(memberCredentials)
    .where(and(
      eq(memberCredentials.workspaceId, workspaceId),
      eq(memberCredentials.memberId, memberId)
    ))
    .limit(1);
  return (row[0]?.passwordSetAt ?? 0) as number;
}
