import test from 'node:test';
import assert from 'node:assert/strict';
import { marketOutlook } from '../src/prediction.js';

test('needs at least three observations before giving an outlook', () => {
  assert.equal(marketOutlook([{ price: 100, at: 1 }]).direction, 'BELUM CUKUP DATA');
});
test('labels rising recent market as tendency only', () => {
  const t = Date.now();
  assert.equal(marketOutlook([{ price: 100, at: t - 10000 }, { price: 100.1, at: t - 5000 }, { price: 100.5, at: t }]).direction, 'CENDERUNG NAIK');
});
test('labels falling recent market as tendency only', () => {
  const t = Date.now();
  assert.equal(marketOutlook([{ price: 100, at: t - 10000 }, { price: 99.9, at: t - 5000 }, { price: 99.5, at: t }]).direction, 'CENDERUNG TURUN');
});
test('labels small movement neutral', () => {
  const t = Date.now();
  assert.equal(marketOutlook([{ price: 100, at: t - 10000 }, { price: 100.05, at: t - 5000 }, { price: 100.1, at: t }]).direction, 'NETRAL / SIDEWAYS');
});
