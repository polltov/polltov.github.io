import { DurableObject } from 'cloudflare:workers';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export interface AdminEnv {
  ADMIN_USER: string;
  ADMIN_PASS: string;
  ADMIN_SESSIONS: DurableObjectNamespace<AdminSessions>;
  ADMIN_LOGIN_LIMIT: RateLimit;
}

export class AdminSessions extends DurableObject<AdminEnv> {
  constructor(ctx: DurableObjectState, env: AdminEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
  }

  create(tokenKey: string): number {
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM sessions WHERE expires_at <= ?', now);
    sql.exec('INSERT INTO sessions (token_key, expires_at) VALUES (?, ?)', tokenKey, expiresAt);
    return expiresAt;
  }

  isActive(tokenKey: string): boolean {
    const result = this.ctx.storage.sql.exec(
      'SELECT 1 FROM sessions WHERE token_key = ? AND expires_at > ?', tokenKey, Date.now(),
    );
    return result.toArray().length === 1;
  }

  revoke(tokenKey: string): void {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE token_key = ?', tokenKey);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenKey(token: string, env: AdminEnv): Promise<string> {
  // Rotating either admin secret invalidates the previous sessions.
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.ADMIN_PASS), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${env.ADMIN_USER}:${token}`));
  return hex(new Uint8Array(digest));
}

function sessions(env: AdminEnv) {
  return env.ADMIN_SESSIONS.getByName('admin');
}

export async function createAdminSession(user: unknown, pass: unknown, env: AdminEnv) {
  if (typeof user !== 'string' || typeof pass !== 'string' || !user || !pass ||
      user.length > 200 || pass.length > 1024 || !env.ADMIN_USER || !env.ADMIN_PASS) return null;

  const credentials = (name: string, password: string) =>
    crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([name, password])));
  const [supplied, configured] = await Promise.all([
    credentials(user, pass),
    credentials(env.ADMIN_USER, env.ADMIN_PASS),
  ]);
  if (!crypto.subtle.timingSafeEqual(supplied, configured)) return null;

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = await sessions(env).create(await tokenKey(token, env));
  return { user: env.ADMIN_USER, token, expiresAt };
}

async function requestTokenKey(req: Request, env: AdminEnv): Promise<string | null> {
  if (!env.ADMIN_USER || !env.ADMIN_PASS) return null;
  const token = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  return token ? tokenKey(token, env) : null;
}

export async function hasAdminSession(req: Request, env: AdminEnv): Promise<boolean> {
  const key = await requestTokenKey(req, env);
  return key ? sessions(env).isActive(key) : false;
}

export async function revokeAdminSession(req: Request, env: AdminEnv): Promise<void> {
  const key = await requestTokenKey(req, env);
  if (key) await sessions(env).revoke(key);
}
