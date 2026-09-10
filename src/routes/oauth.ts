/**
 * OAuth routes: Google and GitHub sign-in.
 */

import type { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { openDb } from '../db/client';
import { WorkspaceScope } from '../db/scope';
import { accountForOAuth } from '../db/system';
import { startSession } from '../auth';

const LINK_INTENT_TTL_MS = 10 * 60 * 1000;
type OAuthProvider = 'google' | 'github';
type LinkIntent = { provider: OAuthProvider; workspaceId: string; memberId: string; expiresAt: number };

function linkIntent(req: Request, provider: OAuthProvider): LinkIntent | null {
  const intent = (req.session as any)?.serosOAuthLink as LinkIntent | undefined;
  if (!intent || intent.provider !== provider || intent.expiresAt < Date.now()) return null;
  return intent;
}

function clearLinkIntent(req: Request) {
  if (req.session) delete (req.session as any).serosOAuthLink;
}
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
        // Only an immutable provider subject that was linked by an authenticated
        // account owner may sign in. A short-lived link intent is created only by
        // POST /auth/:provider/link after Seros session + CSRF validation; email
        // is profile data, never account proof.
        const existing = await accountForOAuth(db, 'google', profile.id);
        const intent = linkIntent(_req, 'google');
        clearLinkIntent(_req); // single-use whether linking succeeds or not
        if (intent && existing && (existing.workspaceId !== intent.workspaceId || existing.memberId !== intent.memberId)) return done(null, false);
        const account = existing ?? intent;
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
        // Never treat a provider email as proof of an existing Seros account.
        // A valid, single-use linking intent proves the Seros account owner chose
        // this provider identity during an authenticated linking flow.
        const existing = await accountForOAuth(db, 'github', profile.id);
        const intent = linkIntent(_req, 'github');
        clearLinkIntent(_req);
        if (intent && existing && (existing.workspaceId !== intent.workspaceId || existing.memberId !== intent.memberId)) return done(null, false);
        const account = existing ?? intent;
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

export function oauthStart(provider: OAuthProvider) {
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

/** Begin a provider-link flow for the already authenticated Seros account. */
export function oauthLinkStart(provider: OAuthProvider) {
  return (req: Request, res: Response, next: NextFunction) => {
    const s = req.serosSession;
    if (!s) return res.redirect(303, '/login');
    const prefix = provider === 'google' ? 'GOOGLE' : 'GITHUB';
    if (!process.env[`${prefix}_CLIENT_ID`] || !process.env[`${prefix}_CLIENT_SECRET`]) {
      return res.redirect(303, `/password?err=${provider}_not_configured`);
    }
    (req.session as any).serosOAuthLink = {
      provider, workspaceId: s.workspaceId, memberId: s.memberId,
      expiresAt: Date.now() + LINK_INTENT_TTL_MS,
    } satisfies LinkIntent;
    const scope = provider === 'google' ? ['profile', 'email'] : ['user:email'];
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
