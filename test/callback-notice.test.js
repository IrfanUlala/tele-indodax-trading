import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackNotice } from '../src/callback-notice.js';

test('callback notice preserves short text', () => {
  assert.equal(callbackNotice('OK'), 'OK');
});

test('callback notice truncates long messages within Telegram-safe limit', () => {
  const result = callbackNotice('x'.repeat(500));
  assert.equal(result.length, 180);
  assert.equal(result.endsWith('…'), true);
});
