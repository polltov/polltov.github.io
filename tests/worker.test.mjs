import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { unstable_dev } from 'wrangler';

const user = 'test-admin';
const pass = 'Тестовый пароль';
let worker;

before(async () => {
  worker = await unstable_dev('worker/src/index.ts', {
    config: 'worker/wrangler.toml',
    ip: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    local: true,
    persist: false,
    logLevel: 'error',
    vars: { ADMIN_USER: user, ADMIN_PASS: pass },
    experimental: { disableDevRegistry: true, disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker?.stop();
});

function post(path, data) {
  return worker.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function signIn() {
  const response = await post('/api/admin/session', { user, pass });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const session = await response.json();
  assert.equal(session.user, user);
  assert.ok(session.expiresAt > Date.now());
  assert.ok(session.expiresAt <= Date.now() + 8 * 60 * 60 * 1000);
  return { Authorization: `Bearer ${session.token}` };
}

test('a correct password creates a time-limited session and signing out revokes it', async () => {
  assert.equal((await worker.fetch('/api/leads')).status, 401);
  assert.equal((await post('/api/admin/session', { user, pass: 'wrong' })).status, 401);

  const headers = await signIn();
  assert.equal((await worker.fetch('/api/leads', { headers })).status, 200);
  assert.equal((await worker.fetch('/api/admin/session', { method: 'DELETE', headers })).status, 204);
  assert.equal((await worker.fetch('/api/leads', { headers })).status, 401);
});

test('validates phone input, lists every batch and can delete a lead from a later batch', async () => {
  const details = { name: 'Тестовая заявка', phone: '89990000101', service: 'Онлайн-трансляции', consent: true };
  assert.equal((await post('/api/lead', { ...details, phone: '+7' })).status, 400);

  for (let offset = 0; offset < 101; offset += 20) {
    const size = Math.min(20, 101 - offset);
    const responses = await Promise.all(Array.from({ length: size }, () => post('/api/lead', details)));
    for (const response of responses) assert.equal(response.status, 200);
  }

  const headers = await signIn();
  const first = await (await worker.fetch('/api/leads', { headers })).json();
  assert.equal(first.leads.length, 100);
  assert.ok(first.cursor);
  assert.equal(first.leads[0].phone, '+7 (999) 000-01-01');

  const secondUrl = `/api/leads?${new URLSearchParams({ cursor: first.cursor })}`;
  const second = await (await worker.fetch(secondUrl, { headers })).json();
  assert.equal(second.cursor, null);
  assert.equal(second.leads.length, 1);
  const lead = second.leads[0];
  assert.ok(!first.leads.some(({ id }) => id === lead.id));

  const deleteUrl = `/api/lead?${new URLSearchParams({ id: lead.id, createdAt: lead.createdAt })}`;
  assert.equal((await worker.fetch(deleteUrl, { method: 'DELETE', headers })).status, 200);
  const remaining = await (await worker.fetch('/api/leads', { headers })).json();
  assert.equal(remaining.leads.length, 100);
  assert.equal(remaining.cursor, null);
});

test('defaults to new and persists each admin status without changing the lead record', async () => {
  const sent = await post('/api/lead', {
    name: 'Заявка со статусом', phone: '+7 (999) 000-02-14',
    service: 'Презентационные ролики', consent: true, status: 'closed',
  });
  assert.equal(sent.status, 200);
  const { id } = await sent.json();
  const headers = await signIn();

  async function fetchLead() {
    let cursor = null;
    do {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
      const response = await worker.fetch(`/api/leads${query}`, { headers });
      assert.equal(response.status, 200);
      const batch = await response.json();
      const lead = batch.leads.find((item) => item.id === id);
      if (lead) return lead;
      cursor = batch.cursor;
    } while (cursor);
  }

  const initial = await fetchLead();
  assert.equal(initial.status, 'new');
  const endpoint = `/api/lead?${new URLSearchParams({ id, createdAt: initial.createdAt })}`;
  const patch = (status, auth = headers) => worker.fetch(endpoint, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

  const preflight = await worker.fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://res-prod.ru' } });
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /\bPATCH\b/);
  assert.equal((await patch('closed', {})).status, 401);
  assert.equal((await patch('unknown')).status, 400);
  assert.deepEqual(await fetchLead(), initial);

  for (const status of ['in_progress', 'rejected', 'closed', 'new']) {
    const changed = await patch(status);
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).status, status);
    assert.deepEqual(await fetchLead(), { ...initial, status });
  }

  assert.equal((await patch('closed')).status, 200);
  assert.equal((await worker.fetch(endpoint, { method: 'DELETE', headers })).status, 200);
  assert.equal((await patch('in_progress')).status, 404);
  assert.equal(await fetchLead(), undefined);
});
