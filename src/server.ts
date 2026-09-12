import express from 'express';
import { join } from 'node:path';
import { migrateDbAsync, openDb } from './db/client';
import { webhookHandler, secret } from './routes/webhook';
import { queuePage, tasksPage, auditPage } from './routes/queue';
import { confirmHandler } from './routes/confirm';
import { askPage, askPost } from './routes/ask';
import { digestPage } from './routes/digest';
import {
  loginPage, loginPost, signupPage, signupPost, logoutPost, setPasswordPage, setPasswordPost,
  passwordPage, passwordChangePost, membersPage, invitePost,
} from './routes/login';
import { requireSession, requireCsrf, rateLimit, sessionSecret, asyncHandler } from './auth';
import { cronDrain } from './routes/cron';
import { checkHostedCredential } from './provider/transports';
import { page, empty, notice } from './views';
import { connectPage, connectStart, connectCallback, disconnect, channelsPage, channelsSave } from './routes/connect';
import { WorkspaceScope } from './db/scope';


const PORT = Number(process.env.PORT || 3000);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Fail closed here, at construction. Every signed cookie the app issues - the
  // session (src/auth.ts) above all - is signed with this secret, and a missing
  // or short one must stop the process rather than surface later as a
  // per-request 500.
  sessionSecret();

  app.set('trust proxy', 1);

  // Verified over the exact bytes it parses, before any body parser can touch it.
  app.post('/api/slack/events',
    rateLimit('webhook', 120, 60_000),
    express.raw({ type: '*/*', limit: '128kb' }),
    webhookHandler);

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.static(join(__dirname, '../public')));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Two different questions, deliberately separate. The bare form answers "is
  // this process up?" and stays cheap enough for an uptime pinger to hammer.
  // `?deep=1` also asks the model provider whether our credential still works,
  // which is the failure that used to be invisible: an expired key meant no
  // drafts, and this endpoint cheerfully reported ok.
  app.get('/health', asyncHandler(async (req, res) => {
    if (req.query.deep !== '1') return res.json({ ok: true, ts: Date.now() });
    const cred = await checkHostedCredential();
    // An unreachable provider is not the app being broken, so it does not fail
    // the check; a refused credential is, and needs someone to act.
    const ok = cred.state !== 'invalid';
    res.status(ok ? 200 : 503).json({ ok, ts: Date.now(), provider: cred });
  }));

  // The scheduled worker, for serverless. Authorised by the platform's cron header
  // or a shared secret; never by a session, because no human drives it.
  app.all('/api/cron/drain', cronDrain);
  app.get('/login', loginPage);
  app.post('/login', rateLimit('login', 20, 60_000), loginPost);
  app.get('/signup', signupPage);
  app.post('/signup', rateLimit('signup', 5, 60_000), asyncHandler(signupPost));
  app.post('/logout', logoutPost);
  app.get('/set-password', setPasswordPage);
  app.post('/set-password', rateLimit('setpw', 10, 60_000), setPasswordPost);

  // everything below this line needs a session
  app.use(asyncHandler(requireSession));
  app.get('/queue', queuePage);
  app.get('/tasks', tasksPage);
  app.get('/audit', auditPage);
  app.get('/password', passwordPage);
  app.post('/password', rateLimit('password', 20, 60_000), requireCsrf, passwordChangePost);
  app.get('/members', membersPage);
  app.get('/connect', asyncHandler(connectPage));
  app.post('/connect/slack', rateLimit('connect', 20, 60_000), requireCsrf, asyncHandler(connectStart));
  app.get('/connect/slack/callback', asyncHandler(connectCallback));
  app.post('/connect/slack/disconnect', rateLimit('connect', 20, 60_000), requireCsrf, asyncHandler(disconnect));
  app.get('/channels', asyncHandler(channelsPage));
  app.post('/channels', rateLimit('channels', 40, 60_000), requireCsrf, asyncHandler(channelsSave));
  app.post('/members/invite', rateLimit('invite', 20, 60_000), requireCsrf, invitePost);
  app.get('/ask', askPage);
  app.post('/ask', rateLimit('ask', 30, 60_000), requireCsrf, askPost);   // not a write, but it spends
  app.get('/digest', rateLimit('digest', 60, 60_000), digestPage);
  app.post('/confirm', rateLimit('confirm', 120, 60_000), requireCsrf, confirmHandler);
  app.get('/', (_req, res) => res.redirect(302, '/queue'));

  app.use((_req, res) => res.status(404).type('html')
    .send(page('Not found', '', `<h1>That page is not here</h1>
      <p class="sub">The address may be old, or it may have been typed incorrectly.</p>
      ${empty('Get back to your workspace',
          'Your drafts, tasks, connections, and audit log are still available.',
          '<a class="button primary" href="/queue">Open the queue &rarr;</a>')}`)));

  // Nothing leaks a stack trace or a message body to the client.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(JSON.stringify({ level: 'error', event: 'request.failed', error: String(err?.message ?? err) }));
    res.status(500).type('html').send(page('Something went wrong', '', `<h1>Something went wrong</h1>
      <p class="sub">We logged the failure. Your existing data is safe.</p>
      ${notice('info', 'Before you try again', 'If you were making a change, check the queue or refresh the page first. Then try again.')}
      <div class="row"><a class="button primary" href="/queue">Return to the queue</a></div>`));
  });
  return app;
}

if (require.main === module) {
  secret();          // fail fast at boot, not with a permanent 401 in production
  sessionSecret();
  // The migration is a promise on Postgres, so the listener is opened only after it
  // has actually finished: serving requests against half-created tables is worse
  // than starting a second later.
  migrateDbAsync().then(() => {
    openDb();
    createApp().listen(PORT, () => {
      console.log(JSON.stringify({ level: 'info', event: 'server.listening', port: PORT }));
    });
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'server.migrate_failed', error: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
