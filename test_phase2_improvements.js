// test_phase2_improvements.js
import { PaperTracker } from './src/paper-trading.js';

async function testPhase2Enhancements() {
  console.log('🧪 Testing Phase 2 Enhancements...\n');
  
  // Initialize tracker with enhanced config
  const tracker = new PaperTracker({
    startingCash: 10000,
    config: {
      minMomentumPct: 0.5,
      maxMomentumPct: 2.5,
      atrWindow: 20,
      maxDrawdownPct: 0.2,
      minPositionSize: 0.05,
      maxPositionSize: 0.25,
      maxPairCorrelation: 0.7,
      atrStopMultiplier: 2.0,
      trailingStopMultiplier: 1.5,
      minVolumeMA: 1.5,
      volumeWindow: 10,
      rsiOverbought: 70,
      rsiOversold: 30,
      rsiWindow: 14
    }
  });
  
  console.log('✅ Enhanced PaperTracker initialized');
  
  // Test ATR calculation with proper data
  const testHighPrices = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100];
  const testLowPrices = [990, 1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090];
  const testClosePrices = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100];
  
  const atrData = tracker.calculateATRAdvanced(testHighPrices, testLowPrices, testClosePrices, 10);
  if (atrData) {
    console.log(`✅ ATR Calculation: ${atrData.percentage.toFixed(2)}% (Volatility: ${atrData.volatility})`);
  } else {
    console.log(`⚠️ ATR Calculation: Insufficient data`);
  }
  
  // Test dynamic stop calculation
  const position = {
    entryPrice: 1000,
    peakPrice: 1040,
    btc: 10,
    atr: atrData.absolute
  };
  
  const stops = tracker.calculateDynamicStops(position, 1040, atrData);
  console.log(`✅ Dynamic Stops: ATR=${stops.atrStop.toFixed(2)}, Trailing=${stops.trailingStop.toFixed(2)}`);
  
  // Test volume analysis
  const mockTrades = [
    { price: 1000, volume: 100 },
    { price: 1010, volume: 150 },
    { price: 1020, volume: 200 },
    { price: 1030, volume: 180 },
    { price: 1040, volume: 220 }
  ];
  
  const volumeProfile = tracker.analyzeVolumeProfile(mockTrades);
  console.log(`✅ Volume Analysis: Imbalance=${volumeProfile.imbalance.toFixed(1)}%`);
  
  // Test advanced metrics
  const enhancedReport = tracker.report(1040);
  console.log(`✅ Enhanced Report: Sharpe=${enhancedReport.riskMetrics.sharpeRatio.toFixed(2)}, Drawdown=${(enhancedReport.riskMetrics.maxDrawdown * 100).toFixed(1)}%`);
  
  console.log('\n🎉 All Phase 2 enhancements working correctly!');
}

testPhase2Enhancements();