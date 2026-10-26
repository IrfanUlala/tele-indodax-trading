import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTracker } from '../src/paper-trading.js';
import { rankIdrPairs, risingCandidates, scanTopPairs, formatAltcoinReport, formatAltcoinAlert } from '../src/altcoin-scanner.js';

test('formats altcoin alert with a qualified 15-minute directional outlook', () => {
  const message = formatAltcoinAlert({ symbol: 'threshold', changePct: 1.11, price: 91, volumeIdr: 2588135597, outlook: { direction: 'CENDERUNG NAIK', changePct: 1.11, reason: 'Harga bergerak naik pada jendela observasi 15 menit.' } });
  assert.ok(message.includes('Arah terpantau 15 menit ke depan: *CENDERUNG NAIK*'));
  assert.match(message, /bukan prediksi pasti/i);
  assert.match(message, /\n/);
  assert.match(message, /THRESHOLD\/IDR/);
  assert.match(message, /\+1,11%/);
  assert.match(message, /Rp2\.588\.135\.597/);
  assert.doesNotMatch(message, /\\\\n/);
});

test('formats altcoin report as readable multiline Indonesian output', () => {
  const report = formatAltcoinReport({
    items: [
      { symbol: 'eth', price: 50000000, volumeIdr: 1250000000, changePct: 1.23 },
      { symbol: 'xrp', price: 9000, volumeIdr: 100000, changePct: null },
    ], thresholdPct: 1, updatedAt: '2026-10-26T04:30:00.000Z',
  });
  assert.match(report, /\n/);
  assert.match(report, /ETH\/IDR/);
  assert.match(report, /\+1,23%/);
  assert.match(report, /mengumpulkan data/i);
  assert.doesNotMatch(report, /\\\\n/);
});

 test('formats empty altcoin report explicitly', () => {
  assert.match(formatAltcoinReport({ items: [], thresholdPct: 1 }), /belum tersedia/i);
});

test('ranks non-BTC IDR pairs by quote volume and selects the configured top count', () => {
  const tickers = { ticker: { ethidr: { vol_idr: '100' }, xrpidr: { vol_idr: '300' }, btcidr: { vol_idr: '999' } } };
  assert.deepEqual(rankIdrPairs(tickers, 1).map(pair => pair.symbol), ['xrp']);
});

test('ranks Indodax underscore IDR symbols and excludes BTC', () => {
  const result = rankIdrPairs({ tickers: { btc_idr: { vol_idr: '999' }, sol_idr: { vol_idr: '500' }, xrp_idr: { vol_idr: '300' } } }, 1);
  assert.deepEqual(result.map(item => item.symbol), ['sol']);
});

test('scanner report limits rising candidates to top volume IDR pairs', () => {
  const payload = { tickers: { btc_idr: { vol_idr: 999 }, eth_idr: { vol_idr: 100 }, xrp_idr: { vol_idr: 300 } } };
  const histories = new Map([['eth', [{ price: 100, at: 0 }, { price: 102, at: 60_000 }]], ['xrp', [{ price: 100, at: 0 }, { price: 99, at: 60_000 }]]]);
  const result = scanTopPairs(payload, histories, { now: 60_000, limit: 1, thresholdPct: 1 });
  assert.equal(result[0].symbol, 'xrp');
  assert.equal(result[0].changePct, null);
});

test('detects only upward movers using observations for the same pair', () => {
  const histories = new Map([
    ['eth', [{ price: 100, at: 0 }, { price: 102, at: 60_000 }]],
    ['xrp', [{ price: 100, at: 0 }, { price: 99, at: 60_000 }]],
  ]);
  const results = risingCandidates(histories, { now: 60_000, windowMs: 15 * 60_000, thresholdPct: 1 });
  assert.deepEqual(results.map(result => result.symbol), ['eth']);
  assert.equal(results[0].changePct, 2);
});
import { marketOutlook } from '../src/prediction.js';

test('paper tracker buys with 25 percent of virtual cash on WATCH_BUY and records ledger', () => {
  const tracker = new PaperTracker({ startingCash: 50000, fraction: 0.25 });
  const result = tracker.onSignal({ type: 'WATCH_BUY' }, 1000000000, 1000, 'CENDERUNG NAIK');
  assert.equal(result.action, 'BUY');
  assert.ok(tracker.state.cash < 50000);
  assert.ok(tracker.state.position.btc > 0);
  assert.equal(tracker.state.ledger.length, 1);
  assert.equal(tracker.state.ledger[0].action, 'BUY');
});

test('paper tracker sells virtual position on WATCH_SELL and records realized result', () => {
  const tracker = new PaperTracker({ startingCash: 50000, fraction: 0.25 });
  tracker.onSignal({ type: 'WATCH_BUY' }, 1000000000, 1000, 'CENDERUNG NAIK');
  const result = tracker.onSignal({ type: 'WATCH_SELL' }, 1100000000, 2000, 'CENDERUNG TURUN');
  assert.equal(result.action, 'SELL');
  assert.equal(tracker.state.position, null);
  assert.ok(tracker.state.cash > 50000);
  assert.equal(tracker.state.ledger.length, 2);
  assert.ok(tracker.state.ledger[1].realizedPnl > 0);
});

test('does not simulate repeated buys while already holding a position', () => {
  const tracker = new PaperTracker({ startingCash: 50000, fraction: 0.25 });
  tracker.onSignal({ type: 'WATCH_BUY' }, 1000000000, 1000, 'CENDERUNG NAIK');
  assert.equal(tracker.onSignal({ type: 'WATCH_BUY' }, 900000000, 2000, 'CENDERUNG NAIK').action, null);
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
