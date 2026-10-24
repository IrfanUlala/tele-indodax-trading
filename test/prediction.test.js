import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTracker } from '../src/paper-trading.js';
import { marketOutlook } from '../src/prediction.js';

test('paper tracker buys with 25 percent of virtual cash on WATCH_BUY and records ledger', () => {
  const tracker = new PaperTracker({ startingCash: 31000, fraction: 0.25 });
  const result = tracker.onSignal({ type: 'WATCH_BUY', changePct: 1.2 }, 1000000000, 1000);
  assert.equal(result.action, 'BUY');
  assert.equal(tracker.state.cash, 23250);
  assert.equal(tracker.state.position.btc, 0.00000775);
  assert.equal(tracker.state.ledger.length, 1);
  assert.equal(tracker.state.ledger[0].action, 'BUY');
});

test('paper tracker sells virtual position on WATCH_SELL and records realized result', () => {
  const tracker = new PaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.onSignal({ type: 'WATCH_BUY' }, 1000000000, 1000);
  const result = tracker.onSignal({ type: 'WATCH_SELL' }, 1100000000, 2000);
  assert.equal(result.action, 'SELL');
  assert.equal(tracker.state.position, null);
  assert.equal(tracker.state.cash, 31775);
  assert.equal(tracker.state.ledger.length, 2);
  assert.equal(tracker.state.ledger[1].realizedPnl, 775);
});

test('does not simulate repeated buys while already holding a position', () => {
  const tracker = new PaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.onSignal({ type: 'WATCH_BUY' }, 1000000000, 1000);
  assert.equal(tracker.onSignal({ type: 'WATCH_BUY' }, 900000000, 2000).action, null);
  assert.equal(tracker.state.ledger.length, 1);
});

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
