import test from 'node:test';
import assert from 'node:assert/strict';
import { AltcoinPaperTracker, formatAltcoinPaperTrade } from '../src/altcoin-paper.js';

test('paper buy and sell notices preserve fractional IDR prices and readable layout', () => {
  const buy = formatAltcoinPaperTrade({ action: 'BUY', symbol: 'pepe', price: 0.0012, idr: 7684, changePct: 1.26 });
  const sell = formatAltcoinPaperTrade({ action: 'SELL', symbol: 'pepe', price: 0.00098, drawdownPct: -1.2, realizedPnl: -123 });
  assert.match(buy, /PEPE\/IDR/);
  assert.match(buy, /Rp0,0012/);
  assert.match(buy, /Rp7\.684/);
  assert.match(buy, /\n/);
  assert.match(sell, /PEPE\/IDR/);
  assert.match(sell, /Rp0,00098/);
  assert.match(sell, /-Rp123/);
  assert.match(sell, /\n/);
});

test('requires short-term price confirmation before entering despite a 15-minute rise', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  assert.equal(tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: false, at: 1000 }).action, null);
  assert.equal(tracker.state.cash, 31000);
});

test('prevents immediate re-entry after a trailing stop during cooldown', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25, cooldownMs: 900000 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  tracker.update({ symbol: 'skyai', price: 105, changePct: 0.1, trendConfirmed: false, at: 2000 });
  tracker.update({ symbol: 'skyai', price: 103.94, changePct: -0.2, trendConfirmed: false, at: 3000 });
  assert.equal(tracker.update({ symbol: 'skyai', price: 105, changePct: 1.2, trendConfirmed: true, at: 4000 }).action, null);
});

test('holds at three-percent profit while outlook rises, then sells on neutral outlook', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  assert.equal(tracker.update({ symbol: 'skyai', price: 103, outlook: 'CENDERUNG NAIK', at: 2000 }).action, null);
  assert.equal(tracker.state.positions.skyai.targetReached, true);
  assert.equal(tracker.update({ symbol: 'skyai', price: 104, outlook: 'CENDERUNG NAIK', at: 3000 }).action, null);
  const result = tracker.update({ symbol: 'skyai', price: 104.2, outlook: 'NETRAL / SIDEWAYS', at: 4000 });
  assert.equal(result.action, 'SELL');
  assert.equal(result.trade.signal, 'OUTLOOK_NEUTRAL');
  assert.equal(result.trade.realizedPnl, Math.floor(7750 * 104.2 / 100) - 7750);
});

test('holds after target trailing stop when outlook still tends upward', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  tracker.update({ symbol: 'skyai', price: 103, outlook: 'CENDERUNG NAIK', at: 2000 });
  const result = tracker.update({ symbol: 'skyai', price: 101.9, outlook: 'CENDERUNG NAIK', at: 3000 });
  assert.equal(result.action, null);
  assert.equal(tracker.state.positions.skyai.entryPrice, 100);
});

test('holds at one-percent entry loss when outlook still tends upward', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  const result = tracker.update({ symbol: 'skyai', price: 98.9, outlook: 'CENDERUNG NAIK', at: 2000 });
  assert.equal(result.action, null);
  assert.equal(tracker.state.positions.skyai.entryPrice, 100);
});

test('sells below target on five-percent entry loss when outlook is neutral', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  const result = tracker.update({ symbol: 'skyai', price: 95, outlook: 'NETRAL / SIDEWAYS', at: 2000 });
  assert.equal(result.action, 'SELL');
  assert.equal(result.trade.signal, 'HARD_STOP_5PCT');
});

test('opens a separate virtual altcoin position on qualifying upward momentum', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  const result = tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  assert.equal(result.action, 'BUY');
  assert.equal(result.trade.idr, 7750);
  assert.equal(tracker.state.cash, 23250);
  assert.equal(tracker.state.positions.skyai.symbol, 'skyai');
});

test('closes only that coin after a one-percent trailing drop from its peak', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  tracker.update({ symbol: 'skyai', price: 100, changePct: 1.2, trendConfirmed: true, at: 1000 });
  assert.equal(tracker.update({ symbol: 'skyai', price: 105, changePct: 0.1, outlook: 'CENDERUNG NAIK', at: 2000 }).action, null);
  const result = tracker.update({ symbol: 'skyai', price: 103.94, changePct: -0.2, at: 3000 });
  assert.equal(result.action, 'SELL');
  assert.equal(result.trade.realizedPnl, Math.floor(7750 * 103.94 / 100) - 7750);
  assert.equal(tracker.state.positions.skyai, undefined);
});

test('does not enter a non-rising coin and reports isolated portfolio state', () => {
  const tracker = new AltcoinPaperTracker({ startingCash: 31000, fraction: 0.25 });
  assert.equal(tracker.update({ symbol: 'xrp', price: 10, changePct: 0.4 }).action, null);
  const report = tracker.report({ xrp: 10 });
  assert.equal(report.startingCash, 31000);
  assert.equal(report.cash, 31000);
  assert.equal(report.positions.length, 0);
});
