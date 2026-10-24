import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSignal } from '../src/signals.js';

test('does not signal with insufficient observations', () => {
  assert.equal(calculateSignal([{ price: 100 }]).type, 'WAIT');
});
test('flags rising BTC as a watch-only buy signal', () => {
  const signal = calculateSignal([{ price: 100 }, { price: 102 }], 1);
  assert.equal(signal.type, 'WATCH_BUY');
  assert.match(signal.reason, /bukan rekomendasi atau order/);
});
test('flags falling BTC as a watch-only sell signal', () => {
  assert.equal(calculateSignal([{ price: 100 }, { price: 98 }], 1).type, 'WATCH_SELL');
});
test('holds when movement stays within threshold', () => {
  assert.equal(calculateSignal([{ price: 100 }, { price: 100.5 }], 1).type, 'HOLD');
});
test('rejects invalid prices into WAIT', () => {
  assert.equal(calculateSignal([{ price: 0 }, { price: 100 }]).type, 'WAIT');
});
