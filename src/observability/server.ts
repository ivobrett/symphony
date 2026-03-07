import Fastify from 'fastify';
import { RuntimeSnapshot } from './snapshot';
import { logger } from './logger';

export interface ServerOptions {
  port: number;
  getSnapshot: () => RuntimeSnapshot;
  triggerRefresh: () => void;
}

export async function startHttpServer(opts: ServerOptions): Promise<() => Promise<void>> {
  const app = Fastify({ logger: false });

  app.get('/', async (_req, reply) => {
    const snap = opts.getSnapshot();
    const html = renderDashboard(snap);
    return reply.type('text/html').send(html);
  });

  app.get('/api/v1/state', async () => {
    return opts.getSnapshot();
  });

  app.get<{ Params: { identifier: string } }>('/api/v1/:identifier', async (req, reply) => {
    const snap = opts.getSnapshot();
    const { identifier } = req.params;
    const row = snap.running.find((r) => r.issue_identifier === identifier)
      ?? snap.retrying.find((r) => r.issue_identifier === identifier);
    if (!row) {
      return reply.status(404).send({ error: { code: 'issue_not_found', message: `Issue "${identifier}" not found` } });
    }
    return row;
  });

  app.post('/api/v1/refresh', async (_req, reply) => {
    opts.triggerRefresh();
    return reply.status(202).send({ status: 'accepted' });
  });

  await app.listen({ port: opts.port, host: '127.0.0.1' });
  logger.info({ port: opts.port }, `HTTP server listening on port ${opts.port}`);

  return () => app.close();
}

function renderDashboard(snap: RuntimeSnapshot): string {
  const runningRows = snap.running.map((r) => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${esc(r.state)}</td>
      <td>${r.turn_count}</td>
      <td>${esc(r.last_event ?? '')}</td>
      <td>${esc(r.last_message ?? '')}</td>
      <td>${r.tokens.total_tokens.toLocaleString()}</td>
      <td>${esc(r.started_at)}</td>
    </tr>`).join('');

  const retryRows = snap.retrying.map((r) => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${r.attempt}</td>
      <td>${esc(r.due_at)}</td>
      <td>${esc(r.error ?? '')}</td>
    </tr>`).join('');

  const totals = snap.claude_totals;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: monospace; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1, h2 { color: #58a6ff; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { border: 1px solid #30363d; padding: 6px 12px; text-align: left; }
    th { background: #161b22; color: #8b949e; }
    tr:hover td { background: #161b22; }
    .totals { display: flex; gap: 2rem; margin-bottom: 2rem; }
    .metric { background: #161b22; border: 1px solid #30363d; padding: 1rem; border-radius: 6px; }
    .metric span { font-size: 1.4rem; color: #58a6ff; }
    .ts { color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p class="ts">Generated: ${esc(snap.generated_at)} &mdash; auto-refresh every 10s</p>

  <div class="totals">
    <div class="metric">Running<br><span>${snap.counts.running}</span></div>
    <div class="metric">Retrying<br><span>${snap.counts.retrying}</span></div>
    <div class="metric">Total Tokens<br><span>${totals.total_tokens.toLocaleString()}</span></div>
    <div class="metric">Runtime<br><span>${formatSeconds(totals.seconds_running)}</span></div>
  </div>

  <h2>Active Sessions</h2>
  <table>
    <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Last Message</th><th>Tokens</th><th>Started</th></tr></thead>
    <tbody>${runningRows || '<tr><td colspan="7">No active sessions</td></tr>'}</tbody>
  </table>

  <h2>Retry Queue</h2>
  <table>
    <thead><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
    <tbody>${retryRows || '<tr><td colspan="4">No retries scheduled</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}
