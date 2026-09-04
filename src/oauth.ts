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
