// Test the enhanced paper trading functionality
import { PaperTracker, loadPaperTracker } from './src/paper-trading.js';

// Test 1: Basic initialization and signal handling
console.log('=== Test 1: Basic Initialization ===');
const tracker = new PaperTracker({ startingCash: 10000 });
console.log('Initial cash:', tracker.state.cash);

// Test 2: Invalid price handling
console.log('\n=== Test 2: Invalid Price Handling ===');
const result = tracker.onSignal({ type: 'WATCH_BUY', changePct: 1.5 }, -100);
console.log('Result for invalid price:', result.reason);

// Test 3: Valid signal with metrics
console.log('\n=== Test 3: Valid Signal Processing ===');
// Set up some metrics for testing
tracker.state.priceHistory = [1000, 1010, 1020, 1030, 1040];
tracker.state.highPrices = [1000, 1010, 1020, 1030, 1040];
tracker.state.lowPrices = [1000, 1010, 1020, 1030, 1040];
tracker.state.volumes = [1000, 1100, 1200, 1300, 1400];

tracker.updateAdvancedMetrics(1040, 1040, 1000, 1300, Date.now());
console.log('ATR:', tracker.state.atr);
console.log('Volume MA:', tracker.state.volumeMA);
console.log('RSI:', tracker.state.rsi);

// Test 4: Dynamic threshold calculation
console.log('\n=== Test 4: Dynamic Threshold Calculation ===');
const thresholds = tracker.getDynamicMomentumThreshold();
console.log('Dynamic momentum thresholds:', thresholds);

// Test 5: Kelly position sizing
console.log('\n=== Test 5: Kelly Position Sizing ===');
const kellySize = tracker.calculateKellyPosition(0.6, 500, 300);
console.log('Kelly position size (60% win rate):', kellySize);

// Test 6: Correlation check
console.log('\n=== Test 6: Correlation Check ===');
const pair1History = [1000, 1010, 1020, 1030, 1040];
const pair2History = [2000, 2010, 2020, 2030, 2040];
const correlation = tracker.calculateCorrelation(pair1History, pair2History);
console.log('Correlation between pair1 and pair2:', correlation.toFixed(3));

console.log('\n=== All Enhancement Tests Completed ===');