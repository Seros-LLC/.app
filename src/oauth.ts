/**
 * OAuth provider management.
 *
 * Every statement here goes through WorkspaceScope. This file used to import
 * `members` and `member_credentials` directly and take a workspace id as an
 * argument, which tools/check-tenancy.ts fails the build for: a workspace id a
 * caller passes in is a convention, and a convention is what a tenancy bug looks
 * like before it happens.
 */

import type { WorkspaceScope } from './db/scope';

export type OAuthProvider = 'google' | 'github';
export type OAuthInfo = {
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  name: string | null;
};

/**
 * The member for an OAuth identity, created on first sign-in.
 *
 * New accounts are created as `viewer`. A viewer cannot confirm (ADR 0002 and
 * src/routes/confirm.ts enforce that), so signing in with Google never grants
 * the one privilege the product sells; an admin promotes deliberately.
 */
export async function ensureMemberForOAuth(scope: WorkspaceScope, email: string | null, name: string | null): Promise<string> {
  const memberId = email
    ? `${email.toLowerCase().split('@')[0]}-${Buffer.from(email.toLowerCase()).toString('base64url').slice(0, 8)}`
    : `oauth-${Math.random().toString(36).slice(2, 10)}`;
  const existing = await scope.member(memberId);
  if (!existing) await scope.addMember(memberId, name || email || 'OAuth User', 'viewer');
  return memberId;
}

export async function linkOAuth(scope: WorkspaceScope, memberId: string, info: OAuthInfo): Promise<void> {
  await scope.linkOAuth(memberId, info);
}

export async function findMemberByOAuth(scope: WorkspaceScope, provider: OAuthProvider, providerUserId: string) {
  return (await scope.memberByOAuth(provider, providerUserId)) ?? null;
}

export async function findMemberByEmail(scope: WorkspaceScope, email: string): Promise<{ memberId: string } | null> {
  const memberId = await scope.memberIdByOAuthEmail(email);
  return memberId ? { memberId } : null;
}

export async function getPasswordVersion(scope: WorkspaceScope, memberId: string): Promise<number> {
  return scope.passwordVersion(memberId);
}
