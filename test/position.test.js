import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMovementAlert, percentChange } from '../src/position.js';

test('computes percent change from the manual entry price', () => {
  assert.equal(percentChange(100, 100.5), 0.5);
  assert.equal(percentChange(100, 99.5), -0.5);
});
test('rejects invalid entry and current prices', () => {
  assert.equal(percentChange(0, 100), null);
});
test('alerts at each new upward half-percent threshold', () => {
  assert.equal(nextMovementAlert(0.49, 0), null);
  assert.equal(nextMovementAlert(0.5, 0), 1);
  assert.equal(nextMovementAlert(1.01, 1), 2);
});
test('alerts at each new downward half-percent threshold', () => {
  assert.equal(nextMovementAlert(-0.5, 0), -1);
  assert.equal(nextMovementAlert(-1.01, -1), -2);
});
test('does not repeat an already notified threshold', () => {
  assert.equal(nextMovementAlert(0.55, 1), null);
});
