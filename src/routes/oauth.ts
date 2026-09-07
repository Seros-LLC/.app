/**
 * OAuth routes: Google and GitHub sign-in.
 */

import type { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { accountForEmail, accountForOAuth } from '../db/system';
import { startSession } from '../auth';
import { linkOAuth, getPasswordVersion } from '../oauth';

const WS = () => process.env.SEROS_WORKSPACE || 'demo';

/**
 * Configure Passport strategies for Google and GitHub OAuth.
 */
export function configurePassport() {
  const publicUrl = process.env.SEROS_PUBLIC_URL || '';
  const googleCallback = publicUrl ? `${publicUrl.replace(/\/$/, '')}/oauth/callback?provider=google` : '/oauth/callback?provider=google';
  const githubCallback = publicUrl ? `${publicUrl.replace(/\/$/, '')}/oauth/callback?provider=github` : '/oauth/callback?provider=github';

  // Google OAuth
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use('google', new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: googleCallback,
      // State is configured on the strategy, not only at authenticate() time:
      // otherwise passport-oauth2 installs a NullStore and sends no state value.
      state: true,
      passReqToCallback: true,
    }, async (_req: Request, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
      try {
        const db = openDb();
        const email = profile.emails?.[0]?.value?.toLowerCase() || null;
        const name = profile.displayName || email || 'Google User';
        // Provider identity/email resolution is the one tightly bounded global
        // account lookup. Tenant rows are read only after opening this scope.
        const account = (await accountForOAuth(db, 'google', profile.id))
          ?? (email ? await accountForEmail(db, email) : null);
        if (!account) return done(null, false);
        const workspaceId = account.workspaceId;
        const memberId = account.memberId;
        const ws = await WorkspaceScope.open(db, workspaceId);
        const member = await ws.member(memberId);
        if (!member || member.status !== 'active') return done(null, false);

        await linkOAuth(ws, memberId, {
          provider: 'google',
          providerUserId: profile.id,
          email,
          name,
        });

        // Audit the OAuth login
        await ws.audit(
          'session.oauth.login',
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
    passport.use('github', new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: githubCallback,
      scope: ['user:email'],
      state: true,
      passReqToCallback: true,
    }, async (_req: Request, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
      try {
        const db = openDb();
        const email = profile.emails?.[0]?.value?.toLowerCase() || null;
        const name = profile.displayName || profile.username || email || 'GitHub User';
        const account = (await accountForOAuth(db, 'github', profile.id))
          ?? (email ? await accountForEmail(db, email) : null);
        if (!account) return done(null, false);
        const workspaceId = account.workspaceId;
        const memberId = account.memberId;
        const ws = await WorkspaceScope.open(db, workspaceId);
        const member = await ws.member(memberId);
        if (!member || member.status !== 'active') return done(null, false);

        await linkOAuth(ws, memberId, {
          provider: 'github',
          providerUserId: profile.id,
          email,
          name,
        });

        // Audit the OAuth login
        await ws.audit(
          'session.oauth.login',
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

export function oauthStart(provider: 'google' | 'github') {
  return (req: Request, res: Response, next: NextFunction) => {
    const prefix = provider === 'google' ? 'GOOGLE' : 'GITHUB';
    if (!process.env[`${prefix}_CLIENT_ID`] || !process.env[`${prefix}_CLIENT_SECRET`]) {
      return res.redirect(303, `/login?err=${provider}_not_configured`);
    }
    const scope = provider === 'google' ? ['profile', 'email'] : ['user:email'];
    // The callback creates a session. Require Passport's signed OAuth state value
    // so a cross-site request cannot bind an attacker's provider account to it.
    return passport.authenticate(provider, { scope, state: {} })(req, res, next);
  };
}

/**
 * OAuth callback handler - Passport authenticates the user, we log them in
 */
export async function oauthCallback(req: any, res: Response, next: NextFunction) {
  const provider = (req.query.provider as string)
    || (req.path.includes('google') ? 'google' : req.path.includes('github') ? 'github' : '');
  if (!['google', 'github'].includes(provider)) {
    return res.redirect(303, '/login?err=oauth_failed');
  }

  // A callback can be requested directly, including after credentials have been
  // removed. Do not ask Passport for a strategy that configurePassport() never
  // registered: Passport throws for an unknown strategy, turning a harmless GET
  // into a 500. Match oauthStart() and fail closed at the login page instead.
  const prefix = provider === 'google' ? 'GOOGLE' : 'GITHUB';
  if (!process.env[`${prefix}_CLIENT_ID`] || !process.env[`${prefix}_CLIENT_SECRET`]) {
    return res.redirect(303, `/login?err=${provider}_not_configured`);
  }

  passport.authenticate(provider, (err: any, user: any) => {
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
        const scope = await WorkspaceScope.open(db, user.workspaceId);
        const pv = await getPasswordVersion(scope, user.memberId);
        startSession(res, {
          workspaceId: user.workspaceId,
          memberId: user.memberId,
          pv
        });

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
