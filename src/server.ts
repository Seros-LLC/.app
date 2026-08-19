import express from 'express';
import { migrateDb, openDb } from './db/client';
import { webhookHandler, secret } from './routes/webhook';
import { queuePage, tasksPage, auditPage } from './routes/queue';
import { confirmHandler } from './routes/confirm';
import { demoPage, demoPost } from './routes/demo';
import { askPage, askPost } from './routes/ask';
import { digestPage } from './routes/digest';
import {
  loginPage, loginPost, logoutPost, setPasswordPage, setPasswordPost,
  passwordPage, passwordChangePost, membersPage, invitePost,
} from './routes/login';
import { requireSession, requireCsrf, rateLimit, sessionSecret } from './auth';
import { cronDrain } from './routes/cron';
import { page } from './views';

const PORT = Number(process.env.PORT || 3000);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Verified over the exact bytes it parses, before any body parser can touch it.
  app.post('/api/slack/events',
    rateLimit('webhook', 120, 60_000),
    express.raw({ type: '*/*', limit: '128kb' }),
    webhookHandler);

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // The scheduled worker, for serverless. Authorised by the platform's cron header
  // or a shared secret; never by a session, because no human drives it.
  app.all('/api/cron/drain', cronDrain);
  app.get('/login', loginPage);
  app.post('/login', rateLimit('login', 20, 60_000), loginPost);
  app.post('/logout', logoutPost);
  app.get('/set-password', setPasswordPage);
  app.post('/set-password', rateLimit('setpw', 10, 60_000), setPasswordPost);

  // everything below this line needs a session
  app.use(requireSession);
  app.get('/queue', queuePage);
  app.get('/tasks', tasksPage);
  app.get('/audit', auditPage);
  app.get('/password', passwordPage);
  app.post('/password', rateLimit('password', 20, 60_000), requireCsrf, passwordChangePost);
  app.get('/members', membersPage);
  app.post('/members/invite', rateLimit('invite', 20, 60_000), requireCsrf, invitePost);
  app.get('/ask', askPage);
  app.post('/ask', rateLimit('ask', 30, 60_000), requireCsrf, askPost);   // not a write, but it spends
  app.get('/digest', rateLimit('digest', 60, 60_000), digestPage);
  app.get('/demo', demoPage);
  app.post('/confirm', rateLimit('confirm', 120, 60_000), requireCsrf, confirmHandler);
  app.post('/demo', rateLimit('demo', 60, 60_000), requireCsrf, demoPost);
  app.get('/', (_req, res) => res.redirect(302, '/queue'));

  app.use((_req, res) => res.status(404).type('html')
    .send(page('Not found', '', '<h1>Not found</h1><p class="sub">No such page.</p>')));

  // Nothing leaks a stack trace or a message body to the client.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(JSON.stringify({ level: 'error', event: 'request.failed', error: String(err?.message ?? err) }));
    res.status(500).type('html').send(page('Error', '', '<h1>Something went wrong</h1><p class="sub">The failure was logged. Nothing was written.</p>'));
  });
  return app;
}

if (require.main === module) {
  secret();          // fail fast at boot, not with a permanent 401 in production
  sessionSecret();
  migrateDb();
  openDb();
  createApp().listen(PORT, () => {
    console.log(JSON.stringify({ level: 'info', event: 'server.listening', port: PORT }));
  });
}
