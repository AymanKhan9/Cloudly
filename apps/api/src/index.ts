import { Hono } from 'hono'
import { prisma, budgetStatus, config, listSettings, setSetting, deleteSetting, settingSpec } from "@repo/db";
import { setup } from './setup';
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { authMiddleware, userFromSessionCookie, type AuthEnv } from './middleware/auth_middleware';
import { hashToken, SESSION_COOKIE_NAME, SESSION_TTL_MS } from './session';
import { listInstallationRepos } from './github';

const app = new Hono<AuthEnv>()

for (const path of ['/runs/*', '/threads', '/threads/*', '/repos', '/budget', '/settings/*']) {
  app.use(path, authMiddleware);
}

export const HARNESSES = [
  { id: 'native-claude', name: 'Claude Code', cost: 'exact' },
  { id: 'native-codex', name: 'Codex', cost: 'estimated' },
  { id: 'gemini-acp', name: 'Gemini CLI', cost: 'estimated' },
] as const;

const HarnessId = z.enum(['native-claude', 'native-codex', 'gemini-acp']);

const CreateRunSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repo'),
  baseBranch: z.string().min(1).max(255),
  prompt: z.string().trim().min(1).max(8000),
  harness: HarnessId,
});

const NewThreadSchema = CreateRunSchema;
const MessageSchema = z.object({ prompt: z.string().trim().min(1).max(8000) });

const BudgetSchema = z.object({
  monthlyLimitUsd: z.number().min(0).max(100_000),
  alertEmail: z.email().nullable(),
});

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];

const RUN_LIST_FIELDS = {
  id: true, status: true, createdAt: true, repo: true, baseBranch: true, prompt: true,
  harness: true, costUsd: true, prUrl: true, branch: true, error: true, cancelRequested: true,
} as const;

app.route('/setup', setup)

app.get('/health', (c) => c.json({ ok: true }))

app.get('/harnesses', (c) => c.json({ harnesses: HARNESSES }))

app.get('/runs', async (c) => {
  const runs = await prisma.run.findMany({
    where: { userId: c.get('user').id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: RUN_LIST_FIELDS,
  });
  return c.json({ runs: runs.map((r) => ({ ...r, costUsd: r.costUsd?.toNumber() ?? null })) });
})

app.post('/runs', zValidator('json', CreateRunSchema), async (c) => {
  const user = c.get('user');
  const budget = await budgetStatus(user.id);
  if (budget.state === 'storm') {
    return c.json({ message: 'Monthly spend limit reached. Raise it in Settings to start new runs.', budget }, 402);
  }

  const { repo, baseBranch, prompt, harness } = c.req.valid('json');
  const run = await prisma.run.create({
    data: { repo, baseBranch, prompt, harness, status: 'queued', userId: user.id },
  });
  return c.json({ id: run.id }, 201);
})

async function ownedRun(id: string, userId: string) {
  return prisma.run.findFirst({ where: { id, userId } });
}

app.get('/runs/:id', async (c) => {
  const user = c.get('user');
  const run = await ownedRun(c.req.param('id'), user.id);
  if (!run) return c.json({ message: 'Run not found' }, 404);
  const ordinal = await prisma.run.count({ where: { userId: user.id, createdAt: { lte: run.createdAt } } });
  return c.json({ run: { ...run, costUsd: run.costUsd?.toNumber() ?? null, ordinal } });
})

app.post('/runs/:id/cancel', async (c) => {
  const run = await ownedRun(c.req.param('id'), c.get('user').id);
  if (!run) return c.json({ message: 'Run not found' }, 404);
  if (TERMINAL_STATUSES.includes(run.status)) {
    return c.json({ message: `Run already ${run.status}` }, 409);
  }
  if (run.status === 'queued') {
    await prisma.run.update({ where: { id: run.id }, data: { cancelRequested: true, status: 'cancelled' } });
  } else {
    await prisma.run.update({ where: { id: run.id }, data: { cancelRequested: true } });
  }
  return c.json({ message: 'Cancel requested' });
})

app.get('/runs/:id/events', async (c) => {
  const id = c.req.param('id');
  const run = await ownedRun(id, c.get('user').id);
  if (!run) return c.json({ message: 'Run not found' }, 404);

  const lastEventIdHeader = c.req.header('Last-Event-ID');
  let lastSeq = lastEventIdHeader !== undefined ? parseInt(lastEventIdHeader, 10) : -1;
  if (Number.isNaN(lastSeq)) lastSeq = -1;

  const response = streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      const events = await prisma.runEvent.findMany({
        where: { runId: id, seq: { gt: lastSeq } },
        orderBy: { seq: 'asc' },
      });

      for (const event of events) {
        await stream.writeSSE({
          id: String(event.seq),
          event: 'run-event',
          data: JSON.stringify({ seq: event.seq, kind: event.kind, data: event.data, ts: event.ts }),
        });
        lastSeq = event.seq;
      }

      const current = await prisma.run.findUnique({
        where: { id },
        select: { status: true, costUsd: true, prUrl: true, error: true },
      });
      if (current) {
        await stream.writeSSE({
          event: 'run-status',
          data: JSON.stringify({ ...current, costUsd: current.costUsd?.toNumber() ?? null }),
        });
        if (TERMINAL_STATUSES.includes(current.status)) break;
      }

      // Keeps bytes flowing so Bun's idle-connection timeout doesn't close a
      // quiet stream; EventSource ignores comment lines.
      if (events.length === 0) await stream.write(': ping\n\n');
      await stream.sleep(750);
    }
    await stream.close();
  });
  // Without no-transform, any gzip layer in front (Next's rewrite proxy,
  // a CDN) buffers the stream and the browser receives nothing until it ends.
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
})


// ---------- Threads: a conversation = many turns (runs) on one branch and PR ----------

const ACTIVE_STATUSES = ['queued', 'running', 'finalizing'];

function threadTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}

const TURN_FIELDS = {
  id: true, prompt: true, status: true, createdAt: true, costUsd: true,
  prUrl: true, error: true, cancelRequested: true,
} as const;

async function threadView(threadId: string, userId: string) {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, userId },
    include: { runs: { orderBy: { createdAt: 'asc' }, select: TURN_FIELDS } },
  });
  if (!thread) return null;
  const { runs, ...meta } = thread;
  return {
    thread: { ...meta, agentSessionId: undefined },
    turns: runs.map((r) => ({ ...r, costUsd: r.costUsd?.toNumber() ?? null })),
  };
}

app.get('/threads', async (c) => {
  const threads = await prisma.thread.findMany({
    where: { userId: c.get('user').id },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
  });
  return c.json({
    threads: threads.map(({ runs, agentSessionId: _a, ...t }) => ({ ...t, lastStatus: runs[0]?.status ?? 'queued' })),
  });
})

app.post('/threads', zValidator('json', NewThreadSchema), async (c) => {
  const user = c.get('user');
  const budget = await budgetStatus(user.id);
  if (budget.state === 'storm') {
    return c.json({ message: 'Monthly spend limit reached. Raise it in Settings to start new sessions.', budget }, 402);
  }
  const { repo, baseBranch, prompt, harness } = c.req.valid('json');
  const id = crypto.randomUUID();
  await prisma.thread.create({
    data: {
      id, userId: user.id, repo, baseBranch, harness,
      title: threadTitle(prompt),
      branch: `agent/thread-${id.slice(0, 8)}`,
      runs: { create: { repo, baseBranch, prompt, harness, status: 'queued', userId: user.id } },
    },
  });
  return c.json({ id }, 201);
})

app.get('/threads/:id', async (c) => {
  const view = await threadView(c.req.param('id'), c.get('user').id);
  if (!view) return c.json({ message: 'Session not found' }, 404);
  return c.json(view);
})

app.post('/threads/:id/messages', zValidator('json', MessageSchema), async (c) => {
  const user = c.get('user');
  const thread = await prisma.thread.findFirst({ where: { id: c.req.param('id'), userId: user.id } });
  if (!thread) return c.json({ message: 'Session not found' }, 404);

  const active = await prisma.run.count({ where: { threadId: thread.id, status: { in: ACTIVE_STATUSES as any } } });
  if (active > 0) return c.json({ message: 'Wait for the current turn to finish, or cancel it.' }, 409);

  const budget = await budgetStatus(user.id);
  if (budget.state === 'storm') {
    return c.json({ message: 'Monthly spend limit reached. Raise it in Settings to continue.', budget }, 402);
  }

  const { prompt } = c.req.valid('json');
  const run = await prisma.run.create({
    data: {
      repo: thread.repo, baseBranch: thread.baseBranch, prompt, harness: thread.harness,
      status: 'queued', userId: user.id, threadId: thread.id,
    },
  });
  await prisma.thread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  return c.json({ id: run.id }, 201);
})

// One stream for the whole conversation: every turn's events in order, plus
// the thread/turn summaries whenever they change.
app.get('/threads/:id/events', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('user').id;
  if (!(await threadView(threadId, userId))) return c.json({ message: 'Session not found' }, 404);

  const response = streamSSE(c, async (stream) => {
    const lastSeq = new Map<string, number>();
    let lastSummary = '';

    while (!stream.aborted) {
      const view = await threadView(threadId, userId);
      if (!view) break;

      let sent = 0;
      for (const turn of view.turns) {
        const events = await prisma.runEvent.findMany({
          where: { runId: turn.id, seq: { gt: lastSeq.get(turn.id) ?? -1 } },
          orderBy: { seq: 'asc' },
        });
        for (const e of events) {
          await stream.writeSSE({
            event: 'turn-event',
            data: JSON.stringify({ runId: turn.id, seq: e.seq, kind: e.kind, data: e.data, ts: e.ts }),
          });
          lastSeq.set(turn.id, e.seq);
          sent++;
        }
      }

      const summary = JSON.stringify(view);
      if (summary !== lastSummary) {
        await stream.writeSSE({ event: 'thread-status', data: summary });
        lastSummary = summary;
      } else if (sent === 0) {
        await stream.write(': ping\n\n');
      }
      await stream.sleep(750);
    }
    await stream.close();
  });
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
})

app.get('/repos', async (c) => {
  try {
    return c.json({ repos: await listInstallationRepos() });
  } catch (error) {
    console.error('listing installation repos failed:', error);
    return c.json({ message: 'Could not list repositories from the GitHub App installation' }, 502);
  }
})

app.get('/budget', async (c) => {
  const user = c.get('user');
  const [status, budget] = await Promise.all([
    budgetStatus(user.id),
    prisma.budget.findUnique({ where: { userId: user.id } }),
  ]);
  return c.json({ ...status, alertEmail: budget?.alertEmail ?? null });
})

app.put('/budget', zValidator('json', BudgetSchema), async (c) => {
  const user = c.get('user');
  const { monthlyLimitUsd, alertEmail } = c.req.valid('json');
  await prisma.budget.upsert({
    where: { userId: user.id },
    // A changed limit re-arms both thresholds for this month.
    update: { monthlyLimitUsd, alertEmail, warnedMonth: null, stoppedMonth: null },
    create: { userId: user.id, monthlyLimitUsd, alertEmail },
  });
  return c.json({ ...(await budgetStatus(user.id)), alertEmail });
})

// Keys and connections entered in the browser. Values are write-only: once
// saved, only the last four characters of a secret ever come back.
app.get('/settings/secrets', async (c) => c.json({ settings: await listSettings() }))

app.put('/settings/secrets/:name', zValidator('json', z.object({ value: z.string().trim().min(1).max(20_000) })), async (c) => {
  const name = c.req.param('name');
  if (!settingSpec(name)) return c.json({ message: 'Unknown setting' }, 404);
  await setSetting(name, c.req.valid('json').value);
  return c.json({ ok: true });
})

app.delete('/settings/secrets/:name', async (c) => {
  const name = c.req.param('name');
  if (!settingSpec(name)) return c.json({ message: 'Unknown setting' }, 404);
  await deleteSetting(name);
  return c.json({ ok: true });
})

function randomToken(byteLength = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength))).toString("base64url");
}

app.get('/auth/github/login', async (c) => {
  const state = randomToken();
  const codeVerifier = randomToken();
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = Buffer.from(challengeBytes).toString("base64url");

  setCookie(c, "oauth_state", state, { httpOnly: true, sameSite: "Lax", maxAge: 600, path: '/' });
  setCookie(c, "oauth_verifier", codeVerifier, { httpOnly: true, sameSite: "Lax", maxAge: 600, path: '/' });

  const clientId = await config("GITHUB_CLIENT_ID");
  if (!clientId) return c.redirect(`${process.env.WEB_ORIGIN}/setup`);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${process.env.API_ORIGIN}/auth/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return c.redirect(url.toString());
})

function signinError(reason: string) {
  return `${process.env.WEB_ORIGIN}/signin?error=${encodeURIComponent(reason)}`;
}

app.get('/auth/github/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const storedState = getCookie(c, 'oauth_state');
  const codeVerifier = getCookie(c, 'oauth_verifier');
  deleteCookie(c, 'oauth_state', { path: '/' });
  deleteCookie(c, 'oauth_verifier', { path: '/' });

  if (!state || !code || !storedState || state !== storedState || !codeVerifier) {
    return c.redirect(signinError('expired'));
  }

  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: await config("GITHUB_CLIENT_ID"),
        client_secret: await config("GITHUB_CLIENT_SECRET"),
        code,
        redirect_uri: `${process.env.API_ORIGIN}/auth/github/callback`,
        code_verifier: codeVerifier,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      console.error('GitHub token exchange failed:', tokenData);
      return c.redirect(signinError('github'));
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
    });
    if (!userResponse.ok) return c.redirect(signinError('github'));
    const githubUser = await userResponse.json();

    const allowedLogins = ((await config('ALLOWED_GITHUB_LOGINS')) ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowedLogins.includes(String(githubUser.login).toLowerCase())) {
      return c.redirect(signinError('not-allowed'));
    }

    const user = await prisma.user.upsert({
      where: { githubId: githubUser.id },
      update: { login: githubUser.login, avatarUrl: githubUser.avatar_url },
      create: { githubId: githubUser.id, login: githubUser.login, avatarUrl: githubUser.avatar_url },
    });

    const sessionToken = randomToken();
    await prisma.session.create({
      data: {
        id: await hashToken(sessionToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.WEB_ORIGIN?.startsWith('https://') ?? false,
      maxAge: SESSION_TTL_MS / 1000,
      path: '/',
    });
    return c.redirect(`${process.env.WEB_ORIGIN}/app`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    return c.redirect(signinError('server'));
  }
})

app.get('/me', async (c) => {
  return c.json({ user: await userFromSessionCookie(getCookie(c, SESSION_COOKIE_NAME)) });
})

app.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (token) {
    await prisma.session.delete({ where: { id: await hashToken(token) } }).catch(() => {});
  }
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
})

export default {
  port: Number(process.env.API_PORT ?? 8787),
  hostname: process.env.API_HOST ?? "127.0.0.1",
  fetch: app.fetch,
}
