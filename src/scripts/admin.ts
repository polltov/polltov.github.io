import { LEADS_API } from '../config/api';
import { DEFAULT_LEAD_STATUS, isLeadStatus, LEAD_STATUSES, type LeadStatus } from '../lib/lead-status';
import { normalizeRussianPhone, phoneDigits, phoneMatches } from '../lib/phone';

type Session = { token: string; user: string; expiresAt: number };
type Lead = { id: string; createdAt: string; name: string; phone: string; service: string; status: LeadStatus; ip?: string };
type LeadBatch = { leads: Array<Omit<Lead, 'status'> & { status?: unknown }>; cursor: string | null };
type StatusFilter = LeadStatus | 'all';
type Operation = { session: Session; controller: AbortController };

const SESSION_KEY = 'resprod_admin_session';
const PAGE_SIZE = 25;
const EXPIRED = 'Сессия истекла. Войдите снова.';
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const statusLabels = Object.fromEntries(LEAD_STATUSES.map(({ id, label }) => [id, label])) as Record<LeadStatus, string>;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing admin element: ${id}`);
  return node as T;
}

const loginCard = element('login-card');
const loginForm = element<HTMLFormElement>('login-form');
const loginStatus = element('login-status');
const loginButton = element<HTMLButtonElement>('btn-login');
const remember = element<HTMLInputElement>('remember');
const toolbar = element('admin-actions');
const userLabel = element('admin-user-label');
const leadsCard = element('leads-card');
const tbody = element<HTMLTableSectionElement>('leads-tbody');
const list = element('leads-list');
const count = element('leads-count');
const status = element('leads-status');
const empty = element('leads-empty');
const filter = element<HTMLInputElement>('leads-filter');
const statusFilters = element('lead-status-filters');
const statusButtons = statusFilters.querySelectorAll<HTMLButtonElement>('button[data-status-filter]');
const pagination = element('leads-pagination');
const pageLabel = element('leads-page');
const prev = element<HTMLButtonElement>('leads-prev');
const next = element<HTMLButtonElement>('leads-next');
const refresh = element<HTMLButtonElement>('btn-refresh');
const download = element<HTMLButtonElement>('btn-export');
const logout = element<HTMLButtonElement>('btn-logout');

let session: Session | null = null;
let expiryTimer: number | undefined;
let pending: Operation | null = null;
let leads: Lead[] | null = null;
let statusFilter: StatusFilter = 'all';
let page = 1;

function setStatus(target: HTMLElement, message: string, error = false) {
  target.textContent = message;
  target.classList.toggle('text-red-700', error);
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<Session>;
  return typeof result.token === 'string' && /^[0-9a-f]{64}$/.test(result.token) &&
    typeof result.user === 'string' && typeof result.expiresAt === 'number' &&
    Number.isFinite(result.expiresAt) && result.expiresAt > Date.now();
}

function storeSession(nextSession: Session | null) {
  try {
    if (nextSession) sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A browser with storage disabled can still use the page for this visit.
  }
}

function restoreSession(): Session | null {
  for (const storage of ['sessionStorage', 'localStorage'] as const) {
    try {
      window[storage].removeItem('resprod_admin_auth');
    } catch {
      // Storage access is optional.
    }
  }
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (isSession(stored)) return stored;
  } catch {
    // Ignore unavailable storage or an invalid saved session.
  }
  storeSession(null);
  return null;
}

function updateControls() {
  const busy = pending !== null;
  refresh.disabled = !session || busy;
  download.disabled = !session || busy || !leads?.length;
  for (const control of tbody.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) {
    control.disabled = busy;
  }
}

function renderKpis() {
  const now = Date.now();
  const weekStart = now - 7 * 86400000;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const totals = new Map<string, number>();
  let weekCount = 0;
  let todayCount = 0;

  for (const lead of leads ?? []) {
    const time = Date.parse(lead.createdAt);
    if (time >= weekStart && time <= now) weekCount++;
    if (time >= today && time <= now) todayCount++;
    if (lead.service) totals.set(lead.service, (totals.get(lead.service) ?? 0) + 1);
  }

  let topService = '—';
  let topCount = 0;
  for (const [service, total] of totals) {
    if (total > topCount) {
      topService = service;
      topCount = total;
    }
  }
  element('kpi-total').textContent = String(leads?.length ?? 0);
  element('kpi-week').textContent = String(weekCount);
  element('kpi-today').textContent = String(todayCount);
  element('kpi-top').textContent = topService;
}

function addCell(row: HTMLTableRowElement, label: string, value: string | HTMLElement, className = '') {
  const cell = row.insertCell();
  cell.setAttribute('role', 'cell');
  cell.className = className;
  const mobileLabel = document.createElement('span');
  mobileLabel.className = 'lead-cell-label';
  mobileLabel.setAttribute('aria-hidden', 'true');
  mobileLabel.textContent = label;
  cell.append(mobileLabel, value);
}

function statusSelect(lead: Lead): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'lead-status-select';
  select.dataset.leadId = lead.id;
  select.dataset.leadTone = lead.status;
  select.setAttribute('aria-label', `Статус заявки ${lead.name}`);
  for (const { id, label } of LEAD_STATUSES) {
    select.add(new Option(label, id, false, id === lead.status));
  }
  select.addEventListener('change', () => void saveLeadStatus(lead, select));
  return select;
}

function createRow(lead: Lead): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.setAttribute('role', 'row');
  row.className = 'hover:bg-lime/20';
  const time = Date.parse(lead.createdAt);
  addCell(row, 'Дата', Number.isFinite(time) ? dateFormat.format(time) : '—', 'text-ink/70');
  addCell(row, 'Имя', lead.name, 'font-medium');

  const phone = normalizeRussianPhone(lead.phone);
  if (phone) {
    const link = document.createElement('a');
    link.href = `tel:+${phoneDigits(phone)}`;
    link.className = 'underline decoration-ink/45 underline-offset-4';
    link.textContent = lead.phone;
    addCell(row, 'Телефон', link);
  } else {
    addCell(row, 'Телефон', lead.phone);
  }
  addCell(row, 'Тип ролика', lead.service);
  addCell(row, 'Статус', statusSelect(lead));
  addCell(row, 'IP', lead.ip || '—', 'text-sm text-ink/70');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lead-delete min-h-11 text-sm text-ink/75 underline-offset-4 hover:text-red-700 hover:underline';
  button.textContent = 'Удалить';
  button.setAttribute('aria-label', `Удалить заявку ${lead.name}`);
  button.addEventListener('click', () => void deleteLead(lead));
  addCell(row, 'Действия', button, 'md:text-right');
  return row;
}

function renderStatusFilters(all: Lead[]) {
  statusFilters.hidden = leads === null;
  const totals = new Map<LeadStatus, number>();
  for (const { status } of all) totals.set(status, (totals.get(status) ?? 0) + 1);
  for (const button of statusButtons) {
    const value = button.dataset.statusFilter;
    button.setAttribute('aria-pressed', String(value === statusFilter));
    const counter = button.querySelector('[data-status-count]');
    if (counter) counter.textContent = String(value === 'all' ? all.length : totals.get(value as LeadStatus) ?? 0);
  }
}

function renderRows() {
  const all = leads ?? [];
  const query = filter.value.trim().toLowerCase();
  const narrowed = statusFilter !== 'all' || query !== '';
  const results = all.filter((lead) => {
    if (statusFilter !== 'all' && lead.status !== statusFilter) return false;
    return !query || `${lead.name} ${lead.phone} ${lead.service}`.toLowerCase().includes(query) || phoneMatches(lead.phone, query);
  });
  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  page = Math.min(page, pageCount);
  const start = (page - 1) * PAGE_SIZE;

  renderStatusFilters(all);
  count.textContent = !leads ? '' : narrowed ? `${results.length} из ${all.length} заявок` : `${all.length} заявок`;
  tbody.replaceChildren(...results.slice(start, start + PAGE_SIZE).map(createRow));
  list.hidden = results.length === 0;
  empty.hidden = !leads || results.length !== 0;
  if (!all.length) empty.textContent = 'Пока ни одной заявки.';
  else empty.textContent = query ? 'По этому запросу ничего не найдено.' : 'Заявок с этим статусом пока нет.';
  pagination.hidden = pageCount <= 1;
  pageLabel.textContent = `Страница ${page} из ${pageCount}`;
  prev.disabled = page === 1;
  next.disabled = page >= pageCount;
  updateControls();
}

function clearSession(message = '') {
  pending?.controller.abort();
  pending = null;
  window.clearTimeout(expiryTimer);
  session = null;
  storeSession(null);
  leads = null;
  page = 1;
  statusFilter = 'all';
  filter.value = '';
  userLabel.textContent = '';
  toolbar.hidden = true;
  leadsCard.hidden = true;
  leadsCard.removeAttribute('aria-busy');
  loginCard.hidden = false;
  loginForm.reset();
  setStatus(loginStatus, message);
  setStatus(status, '');
  renderKpis();
  renderRows();
}

function activeSession(): Session | null {
  if (session && session.expiresAt <= Date.now()) clearSession(EXPIRED);
  return session;
}

function beginOperation(message: string): Operation | null {
  const current = activeSession();
  if (!current || pending) return null;
  pending = { session: current, controller: new AbortController() };
  leadsCard.setAttribute('aria-busy', 'true');
  setStatus(status, message);
  updateControls();
  return pending;
}

function finishOperation(operation: Operation) {
  if (pending !== operation) return;
  pending = null;
  leadsCard.removeAttribute('aria-busy');
  updateControls();
}

async function request(operation: Operation, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${operation.session.token}`);
  const response = await fetch(`${LEADS_API}${path}`, {
    ...init,
    headers,
    signal: operation.controller.signal,
  });
  if (response.status === 401 && session === operation.session) clearSession(EXPIRED);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function loadLeads() {
  const operation = beginOperation('Загружаем заявки…');
  if (!operation) return;
  try {
    const found = new Map<string, Lead>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
      const response = await request(operation, `/api/leads${query}`);
      const batch: LeadBatch = await response.json();
      if (!Array.isArray(batch.leads) || (batch.cursor !== null && typeof batch.cursor !== 'string')) {
        throw new Error('Invalid lead batch');
      }
      for (const lead of batch.leads) {
        found.set(lead.id, { ...lead, status: isLeadStatus(lead.status) ? lead.status : DEFAULT_LEAD_STATUS });
      }
      cursor = batch.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Repeated lead cursor');
        cursors.add(cursor);
      }
    } while (cursor);

    if (pending !== operation) return;
    leads = [...found.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    setStatus(status, '');
    renderKpis();
    renderRows();
  } catch {
    if (pending === operation) setStatus(status, 'Не удалось загрузить заявки. Нажмите «Обновить».', true);
  } finally {
    finishOperation(operation);
  }
}

function leadPath(lead: Lead): string {
  return `/api/lead?${new URLSearchParams({ id: lead.id, createdAt: lead.createdAt })}`;
}

async function saveLeadStatus(lead: Lead, control: HTMLSelectElement) {
  const value = control.value;
  if (!isLeadStatus(value) || value === lead.status) {
    control.value = lead.status;
    return;
  }
  const hadFocus = document.activeElement === control;
  const operation = beginOperation('Сохраняем статус…');
  if (!operation) {
    control.value = lead.status;
    return;
  }

  let saved = false;
  try {
    const response = await request(operation, leadPath(lead), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: value }),
    });
    const result: { status?: unknown } = await response.json();
    if (!isLeadStatus(result.status)) throw new Error('Invalid lead status');
    if (pending !== operation) return;
    lead.status = result.status;
    saved = true;
    setStatus(status, 'Статус заявки сохранён.');
  } catch {
    if (pending === operation) {
      control.value = lead.status;
      setStatus(status, 'Не удалось сохранить статус. Попробуйте ещё раз.', true);
    }
  } finally {
    finishOperation(operation);
  }

  if (saved) {
    const restoreFocus = hadFocus && (document.activeElement === control || document.activeElement === document.body);
    renderRows();
    if (restoreFocus) {
      const replacement = tbody.querySelector<HTMLSelectElement>(`select[data-lead-id="${CSS.escape(lead.id)}"]`);
      const selectedFilter = statusFilters.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      (replacement ?? selectedFilter)?.focus({ preventScroll: true });
    }
  }
}

async function deleteLead(lead: Lead) {
  if (!activeSession() || pending || !window.confirm('Удалить заявку?')) return;
  const operation = beginOperation('Удаляем заявку…');
  if (!operation) return;
  try {
    await request(operation, leadPath(lead), { method: 'DELETE' });
    if (pending !== operation) return;
    leads = (leads ?? []).filter(({ id }) => id !== lead.id);
    setStatus(status, 'Заявка удалена.');
    renderKpis();
    renderRows();
  } catch {
    if (pending === operation) setStatus(status, 'Не удалось удалить заявку. Попробуйте ещё раз.', true);
  } finally {
    finishOperation(operation);
  }
}

function openSession(nextSession: Session) {
  session = nextSession;
  loginForm.reset();
  loginCard.hidden = true;
  toolbar.hidden = false;
  leadsCard.hidden = false;
  userLabel.textContent = nextSession.user;
  expiryTimer = window.setTimeout(() => clearSession(EXPIRED), nextSession.expiresAt - Date.now());
  void loadLeads();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;
  const fields = new FormData(loginForm);
  const user = String(fields.get('user') ?? '').trim();
  const pass = String(fields.get('pass') ?? '');
  if (!user || !pass) return;

  const shouldRemember = remember.checked;
  loginButton.disabled = true;
  setStatus(loginStatus, 'Проверяем вход…');
  try {
    const response = await fetch(`${LEADS_API}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 401) {
      setStatus(loginStatus, 'Неверный логин или пароль.', true);
      return;
    }
    if (response.status === 429) {
      setStatus(loginStatus, 'Слишком много попыток. Попробуйте через минуту.', true);
      return;
    }
    if (!response.ok) throw new Error('Login failed');
    const nextSession: unknown = await response.json();
    if (!isSession(nextSession)) throw new Error('Invalid session response');
    storeSession(shouldRemember ? nextSession : null);
    openSession(nextSession);
  } catch {
    setStatus(loginStatus, 'Не удалось войти. Проверьте соединение и попробуйте ещё раз.', true);
  } finally {
    loginButton.disabled = false;
  }
});

logout.addEventListener('click', async () => {
  const current = activeSession();
  if (!current) return;
  clearSession();
  try {
    const response = await fetch(`${LEADS_API}/api/admin/session`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${current.token}` },
      keepalive: true,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Logout failed');
  } catch {
    if (!session && !loginStatus.textContent) {
      setStatus(loginStatus, 'Сервер не подтвердил выход. Сессия завершится по истечении срока.', true);
    }
  }
});

refresh.addEventListener('click', loadLeads);
for (const button of statusButtons) {
  button.addEventListener('click', () => {
    const value = button.dataset.statusFilter;
    if (!activeSession() || (value !== 'all' && !isLeadStatus(value))) return;
    statusFilter = value;
    page = 1;
    renderRows();
  });
}
filter.addEventListener('input', () => {
  if (!activeSession()) return;
  page = 1;
  renderRows();
});
prev.addEventListener('click', () => {
  if (!activeSession() || page <= 1) return;
  page--;
  renderRows();
});
next.addEventListener('click', () => {
  if (!activeSession() || next.disabled) return;
  page++;
  renderRows();
});

download.addEventListener('click', () => {
  if (!activeSession() || !leads?.length || pending) return;
  const rows = [['createdAt', 'name', 'phone', 'service', 'ip', 'id', 'status']];
  for (const lead of leads) {
    rows.push([lead.createdAt, lead.name, lead.phone, lead.service, lead.ip ?? '', lead.id, statusLabels[lead.status]]);
  }
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  link.href = url;
  link.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
});

const saved = restoreSession();
if (saved) openSession(saved);
