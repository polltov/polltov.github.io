const PHONE_TEXT = /^\+?[\d\s()-]+$/u;

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function formatDigits(digits: string): string {
  if (!digits) return '';
  let formatted = '+7';
  if (digits.length > 1) formatted += ` (${digits.slice(1, 4)}`;
  if (digits.length >= 4) formatted += ')';
  if (digits.length > 4) formatted += ` ${digits.slice(4, 7)}`;
  if (digits.length > 7) formatted += `-${digits.slice(7, 9)}`;
  if (digits.length > 9) formatted += `-${digits.slice(9)}`;
  return formatted;
}

export function normalizeRussianPhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const text = value.trim();
  if (!PHONE_TEXT.test(text)) return null;

  const digits = phoneDigits(text);
  if (text.startsWith('+')) return /^7\d{10}$/.test(digits) ? formatDigits(digits) : null;
  if (digits.length === 10) return formatDigits(`7${digits}`);
  if (/^[78]\d{10}$/.test(digits)) return formatDigits(`7${digits.slice(1)}`);
  return null;
}

export function formatRussianPhoneInput(value: string): string {
  const digits = phoneDigits(value);
  if (!digits) return '';

  const complete = normalizeRussianPhone(value);
  if (complete) return complete;

  const text = value.trim();
  if (!PHONE_TEXT.test(text) || digits.length >= 11 || (text.startsWith('+') && !digits.startsWith('7'))) {
    return value;
  }

  return formatDigits(`7${/^[78]/.test(digits) ? digits.slice(1) : digits}`);
}

export function phoneMatches(phone: string, query: string): boolean {
  if (!PHONE_TEXT.test(query)) return false;
  const queryDigits = phoneDigits(normalizeRussianPhone(query) ?? query);
  const recordedDigits = phoneDigits(normalizeRussianPhone(phone) ?? phone);
  return queryDigits !== '' && recordedDigits.includes(queryDigits);
}
