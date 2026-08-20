/**
 * OAuth routes: Google and GitHub sign-in.
 */

import type { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { startSession } from '../auth';
import {
  ensureMemberForOAuth,
  linkOAuth,
  findMemberByOAuth,
  findMemberByEmail,
  getPasswordVersion,
} from '../oauth';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';

/**
 * Configure Passport strategies for Google and GitHub OAuth.
 */
export function configurePassport() {
  // Google OAuth
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/oauth/callback',
      passReqToCallback: true,
    }, async (_req: Request, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
      try {
        const workspaceId = WS();
        const db = openDb();
        const ws = await WorkspaceScope.ensure(db, workspaceId);

        const email = profile.emails?.[0]?.value?.toLowerCase() || null;
        const name = profile.displayName || email || 'Google User';

        let memberId: string;
        let isNewMember = false;

        // Try to find existing member by provider
        const existing = await findMemberByOAuth(db, workspaceId, 'google', profile.id);
        if (existing) {
          memberId = existing.memberId;
        } else {
          // Try to find by email in case they signed up with another provider
          if (email) {
            const byEmail = await findMemberByEmail(db, workspaceId, email);
            if (byEmail) {
              memberId = byEmail.memberId;
            } else {
              // Check if they have a password-based account
              const memberByEmail = await ws.memberByEmail(email);
              if (memberByEmail) {
                memberId = memberByEmail.memberId;
              } else {
                // Create new member
                memberId = await ensureMemberForOAuth(db, workspaceId, email, name);
                isNewMember = true;
              }
            }
          } else {
            memberId = await ensureMemberForOAuth(db, workspaceId, email, name);
            isNewMember = true;
          }
        }

        // Link the OAuth provider
        await linkOAuth(db, workspaceId, memberId, {
          provider: 'google',
          providerUserId: profile.id,
          email,
          name,
        });

        // Audit the OAuth login
        await ws.audit(
          isNewMember ? 'session.oauth.created' : 'session.oauth.login',
          'ok',
          { member_id: memberId, provider: 'google', provider_user_id: profile.id },
          { actorType: 'member', actorId: memberId, objectType: 'member', objectId: memberId }
        );

        return done(null, { memberId, workspaceId });
      } catch (err) {
        return done(err as any);
      }
    }));
  }

  // GitHub OAuth
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: '/oauth/callback',
      scope: ['user:email'],
      passReqToCallback: true,
    }, async (_req: Request, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
      try {
        const workspaceId = WS();
        const db = openDb();
        const ws = await WorkspaceScope.ensure(db, workspaceId);

        const email = profile.emails?.[0]?.value?.toLowerCase() || null;
        const name = profile.displayName || profile.username || email || 'GitHub User';

        let memberId: string;
        let isNewMember = false;

        // Try to find existing member by provider
        const existing = await findMemberByOAuth(db, workspaceId, 'github', profile.id);
        if (existing) {
          memberId = existing.memberId;
        } else {
          // Try to find by email in case they signed up with another provider
          if (email) {
            const byEmail = await findMemberByEmail(db, workspaceId, email);
            if (byEmail) {
              memberId = byEmail.memberId;
            } else {
              // Check if they have a password-based account
              const memberByEmail = await ws.memberByEmail(email);
              if (memberByEmail) {
                memberId = memberByEmail.memberId;
              } else {
                // Create new member
                memberId = await ensureMemberForOAuth(db, workspaceId, email, name);
                isNewMember = true;
              }
            }
          } else {
            memberId = await ensureMemberForOAuth(db, workspaceId, email, name);
            isNewMember = true;
          }
        }

        // Link the OAuth provider
        await linkOAuth(db, workspaceId, memberId, {
          provider: 'github',
          providerUserId: profile.id,
          email,
          name,
        });

        // Audit the OAuth login
        await ws.audit(
          isNewMember ? 'session.oauth.created' : 'session.oauth.login',
          'ok',
          { member_id: memberId, provider: 'github', provider_user_id: profile.id },
          { actorType: 'member', actorId: memberId, objectType: 'member', objectId: memberId }
        );

        return done(null, { memberId, workspaceId });
      } catch (err) {
        return done(err as any);
      }
    }));
  }
}

/**
 * OAuth callback handler - Passport authenticates the user, we log them in
 */
export async function oauthCallback(req: Request, res: Response, next: NextFunction) {
  passport.authenticate(['google', 'github'], (err: any, user: any) => {
    if (err || !user) {
      return res.redirect(303, '/login?err=oauth_failed');
    }

    req.logIn(user, async (loginErr: any) => {
      if (loginErr) {
        console.error(JSON.stringify({ level: 'error', event: 'oauth.login.failed', error: String(loginErr) }));
        return res.redirect(303, '/login?err=oauth_failed');
      }

      try {
        const db = openDb();
        const pv = await getPasswordVersion(db, user.workspaceId, user.memberId);
        const session = startSession(res, { 
          workspaceId: user.workspaceId, 
          memberId: user.memberId, 
          pv 
        });

        const scope = await WorkspaceScope.open(db, user.workspaceId);
        await scope.audit('session.oauth.login', 'ok', 
          { member_id: user.memberId, provider: req.query.provider as string || 'unknown' },
          { actorType: 'member', actorId: user.memberId, objectType: 'member', objectId: user.memberId }
        );

        return res.redirect(303, '/queue');
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', event: 'oauth.callback.failed', error: String(err) }));
        return res.redirect(303, '/login?err=oauth_failed');
      }
    });
  })(req, res, next);
}

/**
 * OAuth error handler
 */
export async function oauthError(req: Request, res: Response) {
  console.error(JSON.stringify({ level: 'error', event: 'oauth.error', error: req.query.error as string }));
  return res.redirect(303, '/login?err=oauth_denied');
}
