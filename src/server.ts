import express from 'express';
import { migrateDb, openDb } from './db/client';
import { webhookHandler } from './routes/webhook';
import { queuePage, tasksPage, auditPage } from './routes/queue';
import { confirmHandler } from './routes/confirm';
import { demoPage, demoPost } from './routes/demo';
import { page } from './views';

const PORT = Number(process.env.PORT || 3000);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Signature verification needs the exact bytes, so keep the raw body.
  app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.post('/api/slack/events', webhookHandler);
  app.get('/queue', queuePage);
  app.post('/confirm', confirmHandler);
  app.get('/tasks', tasksPage);
  app.get('/audit', auditPage);
  app.get('/demo', demoPage);
  app.post('/demo', demoPost);
  app.get('/', (_req, res) => res.redirect(302, '/queue'));
  app.use((_req, res) => res.status(404).type('html').send(page('Not found', '', '<h1>Not found</h1><p class="sub">No such page.</p>')));
  return app;
}

if (require.main === module) {
  migrateDb();
  openDb();
  createApp().listen(PORT, () => {
    console.log(JSON.stringify({ level: 'info', event: 'server.listening', port: PORT }));
  });
}
