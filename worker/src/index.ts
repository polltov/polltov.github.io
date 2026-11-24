import { DEFAULT_LEAD_STATUS, isLeadStatus, type LeadStatus } from '../../src/lib/lead-status';
import { normalizeRussianPhone } from '../../src/lib/phone';
import { createAdminSession, hasAdminSession, revokeAdminSession, type AdminEnv } from './admin-session';
import type { LeadStatusStore } from './lead-status-store';

export { AdminSessions } from './admin-session';
export { LeadStatusStore } from './lead-status-store';

export interface Env extends AdminEnv {
  LEADS: KVNamespace;
  LEAD_STATUS_STORE: DurableObjectNamespace<LeadStatusStore>;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
}

type Lead = {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  service: string;
  userAgent?: string;
  origin?: string;
  ip?: string;
};

const LEAD_PREFIX = 'lead:';
const LEAD_BATCH_SIZE = 100;

const ALLOWED_ORIGINS = new Set([
  'https://res-prod.ru',
  'https://www.res-prod.ru',
  'https://polltov.github.io',
  'http://localhost:4321',
  'http://localhost:4333',
  'http://127.0.0.1:4321',
  'http://127.0.0.1:4333',
  'http://127.0.0.1:4334',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://res-prod.ru';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function leadKey(createdAt: string, id: string): string {
  return `${LEAD_PREFIX}${createdAt}:${id}`;
}

function requestedLeadKey(url: URL): string | null {
  const id = url.searchParams.get('id') ?? '';
  const createdAt = url.searchParams.get('createdAt') ?? '';
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)) {
    return null;
  }
  return leadKey(createdAt, id);
}

function leadStatuses(env: Env) {
  return env.LEAD_STATUS_STORE.getByName('leads');
}

async function handleLogin(req: Request, env: Env, headers: Record<string, string>) {
  const key = req.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await env.ADMIN_LOGIN_LIMIT.limit({ key });
  if (!success) return json({ ok: false, error: 'too many attempts' }, 429, { ...headers, 'Retry-After': '60' });

  let body: { user?: unknown; pass?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400, headers);
  }

  const session = await createAdminSession(body?.user, body?.pass, env);
  return session ? json(session, 200, headers) : json({ ok: false, error: 'unauthorized' }, 401, headers);
}

async function handleLead(req: Request, env: Env, headers: Record<string, string>) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400, headers);
  }

  const name = String(body?.name ?? '').trim().slice(0, 200);
  const phone = normalizeRussianPhone(body?.phone);
  const service = String(body?.service ?? '').trim().slice(0, 200);
  const consent = body?.consent === true;

  if (!name || !service) {
    return json({ ok: false, error: 'missing fields' }, 400, headers);
  }
  if (!phone) {
    return json({ ok: false, error: 'invalid phone' }, 400, headers);
  }
  if (!consent) {
    return json({ ok: false, error: 'consent required' }, 400, headers);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const lead: Lead = {
    id,
    createdAt,
    name,
    phone,
    service,
    userAgent: req.headers.get('User-Agent') || undefined,
    origin: req.headers.get('Origin') || undefined,
    ip: req.headers.get('CF-Connecting-IP') || undefined,
  };

  await env.LEADS.put(leadKey(createdAt, id), JSON.stringify(lead));

  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    const text = [
      '🎬 Новая заявка с сайта RES.PROD',
      '',
      `Имя: ${name}`,
      `Телефон: ${phone}`,
      `Тип ролика: ${service}`,
    ].join('\n');
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
    }).catch(() => null);
  }

  return json({ ok: true, id }, 200, headers);
}

async function handleList(url: URL, env: Env, headers: Record<string, string>) {
  const cursor = url.searchParams.get('cursor') || undefined;
  const list = await env.LEADS.list({ prefix: LEAD_PREFIX, limit: LEAD_BATCH_SIZE, cursor });
  const nextCursor = list.list_complete ? null : list.cursor;
  if (!list.keys.length) return json({ leads: [], cursor: nextCursor }, 200, headers);

  const keys = list.keys.map(({ name }) => name);
  const [values, statuses] = await Promise.all([
    env.LEADS.get(keys, 'text'),
    leadStatuses(env).getMany(keys),
  ]);
  const leads: Array<Lead & { status: LeadStatus }> = [];
  for (const [key, value] of values) {
    if (!value) continue;
    try {
      const lead: Lead | null = JSON.parse(value);
      if (lead && typeof lead.id === 'string' && typeof lead.createdAt === 'string' &&
          typeof lead.name === 'string' && typeof lead.phone === 'string' && typeof lead.service === 'string' &&
          leadKey(lead.createdAt, lead.id) === key) {
        leads.push({
          ...lead,
          ip: typeof lead.ip === 'string' ? lead.ip : undefined,
          status: statuses[key] ?? DEFAULT_LEAD_STATUS,
        });
      }
    } catch {
      // A malformed record must not hide the rest of the batch.
    }
  }
  return json({ leads, cursor: nextCursor }, 200, headers);
}

async function handleStatus(req: Request, key: string, env: Env, headers: Record<string, string>) {
  let body: { status?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400, headers);
  }
  const status = body?.status;
  if (!isLeadStatus(status)) return json({ ok: false, error: 'invalid status' }, 400, headers);
  if (!await env.LEADS.get(key)) return json({ ok: false, error: 'lead not found' }, 404, headers);

  await leadStatuses(env).set(key, status);
  return json({ ok: true, status }, 200, headers);
}

async function handleDelete(key: string, env: Env, headers: Record<string, string>) {
  await env.LEADS.delete(key);
  await leadStatuses(env).clear(key);
  return json({ ok: true }, 200, headers);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const headers = corsHeaders(origin);
    const adminHeaders = { ...headers, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === '/api/lead' && req.method === 'POST') {
      return handleLead(req, env, headers);
    }
    if (url.pathname === '/api/admin/session' && req.method === 'POST') {
      return handleLogin(req, env, adminHeaders);
    }
    if (url.pathname === '/api/admin/session' && req.method === 'DELETE') {
      await revokeAdminSession(req, env);
      return new Response(null, { status: 204, headers: adminHeaders });
    }
    const isList = url.pathname === '/api/leads' && req.method === 'GET';
    const isLeadEdit = url.pathname === '/api/lead' && (req.method === 'DELETE' || req.method === 'PATCH');
    if (isList || isLeadEdit) {
      if (!await hasAdminSession(req, env)) return json({ ok: false, error: 'unauthorized' }, 401, adminHeaders);
      if (isList) return handleList(url, env, adminHeaders);
      const key = requestedLeadKey(url);
      if (!key) return json({ ok: false, error: 'invalid lead key' }, 400, adminHeaders);
      return req.method === 'PATCH' ? handleStatus(req, key, env, adminHeaders) : handleDelete(key, env, adminHeaders);
    }
    if (url.pathname === '/' || url.pathname === '/healthz') {
      return json({ ok: true, service: 'res-prod-leads' }, 200, headers);
    }

    return new Response('Not found', { status: 404, headers });
  },
};
