import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRussianPhoneInput, normalizeRussianPhone, phoneMatches } from '../src/lib/phone.ts';

test('normalizes a complete Russian number with or without a country prefix', () => {
  for (const input of ['+7 (999) 000-01-01', '+79990000101', '89990000101', '999 000 01 01']) {
    assert.equal(normalizeRussianPhone(input), '+7 (999) 000-01-01');
  }
  assert.equal(normalizeRussianPhone('812 000 01 01'), '+7 (812) 000-01-01');
});

test('rejects incomplete, overlong and unsupported phone numbers', () => {
  for (const input of ['+7', '+7 (999) 000-01-0', '+799900001017', '+19990000101', '9990000101 ext', 79990000101]) {
    assert.equal(normalizeRussianPhone(input), null);
  }
});

test('formats partial input and allows the number to be erased', () => {
  assert.equal(formatRussianPhoneInput('8'), '+7');
  assert.equal(formatRussianPhoneInput('+7 (999'), '+7 (999)');
  assert.equal(formatRussianPhoneInput('+7 (999) 000-01-0'), '+7 (999) 000-01-0');
  assert.equal(formatRussianPhoneInput(''), '');
});

test('matches old phone records and searches by digits with or without formatting', () => {
  assert.equal(phoneMatches('+7 (999) 000-01-01', '9990000101'), true);
  assert.equal(phoneMatches('+7 (999) 000-01-01', '8 999 000-01-01'), true);
  assert.equal(phoneMatches('89990000101', '+7 (999) 000-01-01'), true);
  assert.equal(phoneMatches('+7 (999) 000-01-01', '0000101'), true);
  assert.equal(phoneMatches('+7 (999) 000-01-01', 'Иван 01'), false);
});
