import fs from 'node:fs';
import path from 'node:path';

const FEE_RATE = 0.001; // 0.1% maker/taker (Indodax default)
const MIN_NOTIONAL_IDR = 10000; // Indodax minimum order

// Performance enhancement configuration
const CONFIG = {
  // Dynamic thresholds
  minMomentumPct: 0.05,
  maxMomentumPct: 2.5,
  atrWindow: 20,
  
  // Risk management
  maxDrawdownPct: 0.2, // 20% max portfolio drawdown
  minPositionSize: 0.05, // 5% minimum position
  maxPositionSize: 0.25, // 25% maximum position
  
  // Correlation
  maxPairCorrelation: 0.7,
  
  // Advanced stops
  atrStopMultiplier: 2.0,
  trailingStopMultiplier: 1.5,
  
  // Entry optimization
  minVolumeMA: 1.5,
  volumeWindow: 10,
  
  // RSI filtering
  rsiOverbought: 70,
  rsiOversold: 30,
  rsiWindow: 14,
  
  // Take profit / Stop loss (percentage)
  takeProfitPct: 0.5,
  stopLossPct: 5.0,
  
  // Regime detection
  regimeDetectionWindow: 50,
  regimeVolatilityThreshold: 0.02,
  regimeTrendThreshold: 0.01,
  
  // Turtle drawdown protection
  turtleDrawdownLevels: [0.10, 0.15, 0.20, 0.25],
  turtleSizeReduction: [0.5, 0.3, 0.2, 0.1],
  turtleRecoveryThreshold: 0.05
};

export class PaperTracker {
  constructor({ startingCash = 31000, fraction = 0.25, state = null, save = null, feeRate = FEE_RATE, config = CONFIG } = {}) {
    if (!(startingCash > 0) || !(fraction > 0 && fraction <= 1)) throw new Error('Invalid paper trading settings.');
    this.startingCash = startingCash;
    this.fraction = fraction;
    this.feeRate = feeRate;
    this.save = save;
    this.config = config;
    
    // Initialize state with performance tracking
    this.state = state ?? { 
      cash: startingCash, 
      position: null, 
      ledger: [],
      // Performance tracking
      totalTrades: 0,
      winTrades: 0,
      lossTrades: 0,
      totalPnL: 0,
      maxDrawdown: 0,
      peakEquity: startingCash,
      // Correlation tracking
      activePairs: [],
      // Advanced metrics
      atr: null,
      volumeMA: null,
      rsi: null,
      lastUpdate: Date.now()
    };
    this.state.ledger ??= [];
    
    // Initialize correlation tracking if pairs present
    if (this.state.activePairs?.length > 0) {
      this._initCorrelationTracking();
    }
  }

  // Performance enhancement helper methods
  
  // Calculate Average True Range for volatility-based thresholds
  calculateATR(highPrices, lowPrices, closePrices, window = this.config.atrWindow) {
    if (highPrices.length < window || lowPrices.length < window) return null;
    
    let atr = 0;
    for (let i = highPrices.length - window; i < highPrices.length; i++) {
      const high = highPrices[i];
      const low = lowPrices[i];
      const prevClose = closePrices[i - 1];
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      
      atr += tr;
    }
    
    return atr / window;
  }
  
  // Calculate RSI for overbought/oversold filtering
  calculateRSI(prices, window = this.config.rsiWindow) {
    if (prices.length < window + 1) return null;
    
    let gain = 0;
    let loss = 0;
    
    for (let i = prices.length - window; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) {
        gain += change;
      } else {
        loss += Math.abs(change);
      }
    }
    
    const avgGain = gain / window;
    const avgLoss = loss / window;
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  // Calculate simple moving average for volume confirmation
  calculateSMA(prices, window) {
    if (prices.length < window) return null;
    const sum = prices.slice(-window).reduce((a, b) => a + b, 0);
    return sum / window;
  }
  
  // Enhanced ATR calculation with volatility classification
  calculateATRAdvanced(highPrices, lowPrices, closePrices, period = this.config.atrWindow) {
    if (highPrices.length < period || lowPrices.length < period) return null;
    
    let atr = 0;
    for (let i = highPrices.length - period; i < highPrices.length; i++) {
      const high = highPrices[i];
      const low = lowPrices[i];
      const prevClose = closePrices[i - 1];
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      
      atr += tr;
    }
    
    const absoluteATR = atr / period;
    const normalizedATR = (absoluteATR / closePrices[closePrices.length - 1]) * 100;
    
    return {
      absolute: absoluteATR,
      percentage: normalizedATR,
      period: period,
      volatility: this._classifyVolatility(normalizedATR)
    };
  }
  
  _classifyVolatility(atrPercent) {
    if (atrPercent < 0.5) return 'LOW';
    if (atrPercent < 1.5) return 'MEDIUM';
    if (atrPercent < 3.0) return 'HIGH';
    return 'EXTREME';
  }
  
  // Dynamic stop calculation based on ATR
  calculateDynamicStops(position, currentPrice, atrData) {
    const currentATR = atrData.absolute;
    const volatilityMultiplier = this._getVolatilityMultiplier(atrData.volatility);
    
    const atrStopPrice = position.entryPrice - (currentATR * this.config.atrStopMultiplier);
    const trailDistance = (currentATR * this.config.trailingStopMultiplier) / 100;
    const trailingStopPrice = position.peakPrice - trailDistance;
    
    return {
      atrStop: atrStopPrice,
      trailingStop: trailingStopPrice,
      finalStop: Math.max(atrStopPrice, trailingStopPrice)
    };
  }
  
  _getVolatilityMultiplier(volatility) {
    const multipliers = {
      'LOW': 2.5,
      'MEDIUM': 2.0, 
      'HIGH': 1.5,
      'EXTREME': 1.2
    };
    return multipliers[volatility] || 2.0;
  }
  
  // Volume profile analysis
  analyzeVolumeProfile(trades, timeframe = '15m') {
    const volumeData = this._aggregateVolumeByPrice(trades);
    const volumeProfile = this._createVolumeProfile(volumeData);
    
    return {
      imbalance: this._calculateVolumeImbalance(volumeProfile),
      accumulation: this._calculateAccumulation(volumeProfile),
      entrySignals: this._generateEntrySignals(volumeProfile),
      optimalRanges: this._findOptimalEntryRanges(volumeProfile)
    };
  }
  
  _aggregateVolumeByPrice(trades) {
    const volumeMap = new Map();
    
    trades.forEach(trade => {
      const priceKey = Math.floor(trade.price / 100) * 100;
      volumeMap.set(priceKey, (volumeMap.get(priceKey) || 0) + trade.volume);
    });
    
    return volumeMap;
  }
  
  _createVolumeProfile(volumeMap) {
    return Array.from(volumeMap.entries())
      .sort((a, b) => a[0] - b[0]);
  }
  
  _calculateVolumeImbalance(volumeProfile) {
    let totalVolume = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    
    for (const [price, volume] of volumeProfile) {
      totalVolume += volume;
      
      if (price < 1000) {
        buyVolume += volume;
      } else {
        sellVolume += volume;
      }
    }
    
    return ((buyVolume - sellVolume) / totalVolume) * 100;
  }
  
  _calculateAccumulation(volumeProfile) {
    let accumulation = 0;
    let totalVolume = 0;
    
    for (let i = volumeProfile.length - 1; i >= 0; i--) {
      const [price, volume] = volumeProfile[i];
      accumulation += volume * price;
      totalVolume += volume;
    }
    
    return (accumulation / totalVolume) / 1000;
  }
  
  _generateEntrySignals(volumeProfile) {
    const imbalance = this._calculateVolumeImbalance(volumeProfile);
    const accumulation = this._calculateAccumulation(volumeProfile);
    
    const signals = [];
    
    if (imbalance > 10 && accumulation > 1) {
      signals.push('STRONG_BUY');
    } else if (imbalance > 5 && accumulation > 0.5) {
      signals.push('BUY');
    }
    
    if (imbalance < -10 && accumulation > 1) {
      signals.push('STRONG_SELL');
    } else if (imbalance < -5 && accumulation > 0.5) {
      signals.push('SELL');
    }
    
    return signals;
  }
  
  _findOptimalEntryRanges(volumeProfile) {
    const ranges = [];
    
    for (let i = 0; i < volumeProfile.length; i++) {
      const [price, volume] = volumeProfile[i];
      
      if (volume > 100) {
        ranges.push({
          price: price,
          volume: volume,
          liquidity: volume / (i + 1)
        });
      }
    }
    
    return ranges.sort((a, b) => b.liquidity - a.liquidity).slice(0, 3);
  }
  
  // Initialize correlation tracking
  _initCorrelationTracking() {
    // This would be called when adding active pairs
    // For now, just placeholder for future implementation
    this.state.correlations = {};
  }
  
  // Calculate correlation between two price series
  calculateCorrelation(series1, series2) {
    if (series1.length !== series2.length || series1.length < 2) return 0;
    
    const n = series1.length;
    const mean1 = series1.reduce((a, b) => a + b, 0) / n;
    const mean2 = series2.reduce((a, b) => a + b, 0) / n;
    
    let covariance = 0;
    let stdDev1 = 0;
    let stdDev2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = series1[i] - mean1;
      const diff2 = series2[i] - mean2;
      covariance += diff1 * diff2;
      stdDev1 += diff1 * diff1;
      stdDev2 += diff2 * diff2;
    }
    
    const denominator = Math.sqrt(stdDev1 * stdDev2);
    if (denominator === 0) return 0;
    
    return covariance / denominator / n;
  }
  
  // Check if adding a pair would exceed correlation threshold
  isPairWithinCorrelation(newPairPriceHistory, activePairsData) {
    for (const [pairSymbol, pairData] of Object.entries(activePairsData)) {
      const correlation = this.calculateCorrelation(
        newPairPriceHistory,
        pairData.priceHistory || []
      );
      
      if (Math.abs(correlation) > this.config.maxPairCorrelation) {
        return false; // Too correlated
      }
    }
    return true; // Within limits
  }
  
  // Update advanced metrics with new price data
  updateAdvancedMetrics(price, high, low, volume, timestamp) {
    const prices = this.state.priceHistory || [];
    prices.push(price);
    this.state.priceHistory = prices.slice(-50); // Keep last 50 prices
    
    const highPrices = this.state.highPrices || [];
    highPrices.push(high);
    this.state.highPrices = highPrices.slice(-50);
    
    const lowPrices = this.state.lowPrices || [];
    lowPrices.push(low);
    this.state.lowPrices = lowPrices.slice(-50);
    
    const volumes = this.state.volumes || [];
    volumes.push(volume);
    this.state.volumes = volumes.slice(-this.config.volumeWindow);
    
    // Update advanced indicators
    this.state.atr = this.calculateATR(
      this.state.highPrices,
      this.state.lowPrices,
      prices,
      this.config.atrWindow
    );
    
    this.state.volumeMA = this.calculateSMA(this.state.volumes, this.config.volumeWindow);
    this.state.rsi = this.calculateRSI(prices, this.config.rsiWindow);
    this.state.lastUpdate = timestamp;
  }
  
  // Get dynamic momentum threshold based on volatility
  getDynamicMomentumThreshold() {
    const baseMin = this.config.minMomentumPct;
    const baseMax = this.config.maxMomentumPct;
    
    if (!this.state.atr) {
      return { min: baseMin, max: baseMax };
    }
    
    // Volatility-based adjustment - use current price for proper percentage
    const currentPrice = this.state.priceHistory?.[this.state.priceHistory.length - 1] || 1450000000;
    const atrPercent = (this.state.atr / currentPrice) * 100;
    const dynamicMin = Math.max(baseMin, atrPercent * 0.5);
    const dynamicMax = Math.min(baseMax, atrPercent * 2.0);
    
    return {
      min: dynamicMin,
      max: dynamicMax
    };
  }
  
  // Calculate optimal position size using Kelly criterion
  calculateKellyPosition(winRate, avgWin, avgLoss) {
    if (winRate === 0 || (avgWin - (1 - winRate) * avgLoss) <= 0) {
      return this.config.minPositionSize;
    }
    
    const kellyFraction = winRate + ((winRate * avgWin - (1 - winRate) * avgLoss) / avgWin);
    
    return Math.max(
      this.config.minPositionSize,
      Math.min(this.config.maxPositionSize, kellyFraction)
    );
  }
  
  // Helper methods for enhanced metrics
  calculateSharpeRatio(trades) {
    if (trades.length < 2) return 0;
    
    const returns = trades.map(trade => trade.realizedPnl / trade.entryPrice);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = this._calculateStdDev(returns, avgReturn);
    
    return stdDev === 0 ? 0 : (avgReturn / stdDev) * Math.sqrt(252);
  }
  
  calculateSortinoRatio(trades) {
    if (trades.length < 2) return 0;
    
    const returns = trades.map(trade => trade.realizedPnl / trade.entryPrice);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    const downsideReturns = returns.filter(r => r < 0);
    const downsideStdDev = this._calculateStdDev(downsideReturns, 0);
    
    return downsideStdDev === 0 ? 0 : (avgReturn / downsideStdDev) * Math.sqrt(252);
  }
  
  calculateValueAtRisk(returns, confidenceLevel) {
    returns.sort((a, b) => a - b);
    const index = Math.ceil(returns.length * confidenceLevel);
    return returns[index - 1] || 0;
  }
  
  calculateCVaR(returns, confidenceLevel) {
    const varValue = this.calculateValueAtRisk(returns, confidenceLevel);
    const worseReturns = returns.filter(r => r <= varValue);
    return worseReturns.reduce((sum, r) => sum + r, 0) / worseReturns.length || 0;
  }
  
  calculateVolatility(returns) {
    if (returns.length < 2) return 0;
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    return Math.sqrt(variance);
  }
  
  calculateCapitalTurnover(trades) {
    if (!trades.length) return 0;
    
    const totalProfit = trades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    return totalProfit / this.startingCash;
  }
  
  calculateROE(trades) {
    const totalProfit = trades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    return totalProfit / this.startingCash;
  }
  
  calculateAverageTradeTime(trades) {
    if (!trades.length) return 0;
    
    const totalHours = trades.reduce((sum, trade) => {
      const tradeTime = new Date(trade.at) - new Date(trade.openTimestamp || trade.at);
      return sum + (tradeTime / (1000 * 60 * 60));
    }, 0);
    
    return totalHours / trades.length;
  }
  
  calculateWinLossRatio(trades) {
    const wins = trades.filter(t => t.realizedPnl > 0).length;
    const losses = trades.filter(t => t.realizedPnl <= 0).length;
    return losses === 0 ? wins : wins / losses;
  }
  
  calculateExpectancy(trades) {
    if (!trades.length) return 0;
    
    const winRate = this._calculateWinRate(trades);
    const avgWin = this._calculateAverageWins(trades);
    const avgLoss = this._calculateAverageLosses(trades);
    
    return (winRate * avgWin) - ((1 - winRate) * avgLoss);
  }
  
  _calculateStdDev(values, mean) {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }
  
  _calculateWinRate(trades) {
    const wins = trades.filter(t => t.realizedPnl > 0).length;
    return wins / trades.length || 0;
  }
  
  _calculateAverageWins(trades) {
    const wins = trades.filter(t => t.realizedPnl > 0);
    if (!wins.length) return 0;
    return wins.reduce((sum, trade) => sum + trade.realizedPnl, 0) / wins.length;
  }
  
  _calculateMarketTimingAccuracy(closedTrades) {
    if (!closedTrades.length) return 0;
    
    let correctPredictions = 0;
    let totalPredictions = 0;
    
    closedTrades.forEach(trade => {
      // Simple logic: if trade was profitable and outlook was positive, or if trade was loss-making and outlook was negative
      if (trade.signal && trade.profitPct) {
        const wasProfitable = trade.realizedPnl > 0;
        const outlookPositive = trade.signal === 'CENDERUNG NAIK';
        
        if ((wasProfitable && outlookPositive) || (!wasProfitable && !outlookPositive)) {
          correctPredictions++;
        }
        totalPredictions++;
      }
    });
    
    return totalPredictions ? correctPredictions / totalPredictions * 100 : 0;
  }
  
  _calculateEntryTimingEfficiency(closedTrades) {
    if (!closedTrades.length) return 0;
    
    const avgHours = this.calculateAverageTradeTime(closedTrades);
    return avgHours / 24; // Convert to days
  }
  
  _calculateExitTimingEfficiency(closedTrades) {
    return this._calculateEntryTimingEfficiency(closedTrades); // Same logic for now
  }
  
  _calculateAverageLosses(trades) {
    const losses = trades.filter(t => t.realizedPnl < 0);
    if (!losses.length) return 0;
    return losses.reduce((sum, trade) => sum + trade.realizedPnl, 0) / losses.length;
  }
  
  // Fase 3: Market regime detection
  detectMarketRegime() {
    const prices = this.state.priceHistory || [];
    if (prices.length < this.config.regimeDetectionWindow) return 'UNKNOWN';
    
    const window = this.config.regimeDetectionWindow;
    const recentPrices = prices.slice(-window);
    
    // Calculate returns
    const returns = [];
    for (let i = 1; i < recentPrices.length; i++) {
      returns.push((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]);
    }
    
    // Volatility
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    // Trend strength
    const firstPrice = recentPrices[0];
    const lastPrice = recentPrices[recentPrices.length - 1];
    const trendStrength = Math.abs((lastPrice - firstPrice) / firstPrice);
    const trendDirection = lastPrice > firstPrice ? 'UP' : 'DOWN';
    
    // Volume trend
    const volumes = this.state.volumes || [];
    const recentVolumes = volumes.slice(-window);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeTrend = recentVolumes[recentVolumes.length - 1] / avgVolume;
    
    // Classify regime
    let regime = 'RANGING';
    
    if (volatility > this.config.regimeVolatilityThreshold) {
      regime = 'VOLATILE';
    } else if (trendStrength > this.config.regimeTrendThreshold) {
      regime = `TRENDING_${trendDirection}`;
    }
    
    return {
      regime,
      volatility,
      trendStrength,
      trendDirection,
      volumeTrend,
      timestamp: Date.now()
    };
  }
  
  // Fase 3: Get regime-adjusted parameters
  getRegimeAdjustedParams(baseParams) {
    const regimeData = this.detectMarketRegime();
    const adjusted = { ...baseParams };
    
    switch (regimeData.regime) {
      case 'TRENDING_UP':
        adjusted.momentumMultiplier = 1.2;
        adjusted.stopMultiplier = 1.5;
        adjusted.positionSizeMultiplier = 1.3;
        break;
      case 'TRENDING_DOWN':
        adjusted.momentumMultiplier = 0.8;
        adjusted.stopMultiplier = 0.8;
        adjusted.positionSizeMultiplier = 0.7;
        break;
      case 'VOLATILE':
        adjusted.momentumMultiplier = 1.5;
        adjusted.stopMultiplier = 2.0;
        adjusted.positionSizeMultiplier = 0.5;
        break;
      case 'RANGING':
      default:
        adjusted.momentumMultiplier = 1.0;
        adjusted.stopMultiplier = 1.0;
        adjusted.positionSizeMultiplier = 1.0;
        break;
    }
    
    return { ...adjusted, regime: regimeData.regime };
  }
  
  // Fase 3: Enhanced Turtle-style drawdown protection
  applyTurtleDrawdownProtection() {
    const currentEquity = this.state.cash + 
      (this.state.position ? this.state.position.btc * (this.state.position?.peakPrice || this.state.position?.entryPrice) : 0);
    
    const drawdownPct = (this.state.peakEquity - currentEquity) / this.state.peakEquity;
    
    // Check each turtle level
    for (let i = 0; i < this.config.turtleDrawdownLevels.length; i++) {
      const level = this.config.turtleDrawdownLevels[i];
      const reduction = this.config.turtleSizeReduction[i];
      
      if (drawdownPct >= level) {
        // Apply size reduction
        if (this.state.position) {
          this.state.position.sizeMultiplier = reduction;
        }
        this.state.turtleLevel = i + 1;
        this.state.turtleActive = true;
        
        console.log(`🐢 TURTLE PROTECTION LEVEL ${i + 1}: Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(level * 100).toFixed(1)}%, reducing size to ${(reduction * 100).toFixed(0)}%`);
        return { level: i + 1, reduction, drawdown: drawdownPct };
      }
    }
    
    // Recovery check - if drawdown reduced below recovery threshold, reset
    if (this.state.turtleActive && drawdownPct < this.config.turtleRecoveryThreshold) {
      if (this.state.position) {
        this.state.position.sizeMultiplier = 1.0;
      }
      this.state.turtleActive = false;
      this.state.turtleLevel = 0;
      console.log(`🐢 TURTLE RECOVERY: Drawdown ${(drawdownPct * 100).toFixed(1)}% < ${(this.config.turtleRecoveryThreshold * 100).toFixed(1)}%, restoring full size`);
      return { recovered: true, drawdown: drawdownPct };
    }
    
    return { active: this.state.turtleActive, level: this.state.turtleLevel || 0, drawdown: drawdownPct };
  }
  
  // Enhanced position adjustment with Turtle protection
  adjustPositionForDrawdown() {
    // First apply Turtle protection
    const turtleResult = this.applyTurtleDrawdownProtection();
    
    // Then apply original logic if not in Turtle mode
    if (!turtleResult.active) {
      const currentEquity = this.state.cash + 
        (this.state.position ? this.state.position.btc * (this.state.position?.peakPrice || this.state.position?.entryPrice) : 0);
      
      const drawdownPct = (this.state.peakEquity - currentEquity) / this.state.peakEquity;
      
      if (drawdownPct > this.config.maxDrawdownPct) {
        this.state.position.sizeMultiplier = Math.max(0.1, 1 - drawdownPct / this.config.maxDrawdownPct);
      } else if (currentEquity > this.state.peakEquity * 1.2) {
        this.state.position.sizeMultiplier = Math.min(1.0, (this.state.position.sizeMultiplier || 1.0) * 1.1);
      }
    }
  }

  persist() { this.save?.(this.state); }

  onSignal(signal, price, at = Date.now(), outlook = 'BELUM CUKUP DATA') {
    // Enhanced with performance features
    if (!Number.isFinite(price) || price <= 0) return { action: null, reason: 'Harga tidak valid.' };
    
    // Note: updateAdvancedMetrics should be called by the caller with proper high/low/volume
    // before calling onSignal. We no longer call it here with zeros as it corrupts ATR.
    
    // Apply dynamic momentum threshold
    const dynamicThresholds = this.getDynamicMomentumThreshold();
    const adjustedMomentum = signal?.changePct || 0;
    
    // RSI filtering
    const rsi = this.state.rsi;
    if (rsi !== null && rsi > this.config.rsiOverbought) {
      return { action: null, reason: 'RSI overbought (>70), skip entry.' };
    }
    
    const position = this.state.position;
        if (position) {
          position.peakPrice = Math.max(position.peakPrice ?? position.entryPrice, price);
          const profitPct = ((price - position.entryPrice) / position.entryPrice) * 100;
          const targetReached = profitPct >= this.config.takeProfitPct;
          const drawdownPct = ((price - position.peakPrice) / position.peakPrice) * 100;

          // HARD STOP LOSS: 5% from entry price - ALWAYS triggers regardless of target/outlook
          const hardStopLossPct = this.config.stopLossPct; // 5%
          const hardStopTriggered = profitPct <= -hardStopLossPct;

          // Dynamic stop-loss using ATR (only after target reached)
          const atrStopPrice = position.entryPrice - (this.state.atr || 0) * this.config.atrStopMultiplier;
          const trailingStopPrice = position.peakPrice * (1 - this.config.trailingStopMultiplier / 100);

          const atrStopTriggered = price <= atrStopPrice && targetReached;
          const trailingStopTriggered = price <= trailingStopPrice && targetReached;
          const outlookExit = targetReached && outlook !== 'CENDERUNG NAIK';

          // Stop triggered if: hard stop (always) OR (after target: ATR/trailing/outlook)
          const stopTriggered = hardStopTriggered || (targetReached ? (atrStopTriggered || trailingStopTriggered || outlookExit) : false);

          let signal_reason;
          if (hardStopTriggered) {
            signal_reason = 'HARD_STOP_5PCT';
          } else if (targetReached) {
            if (atrStopTriggered) {
              signal_reason = 'ATR_STOP';
            } else if (trailingStopTriggered) {
              signal_reason = 'TRAILING_STOP';
            } else if (outlookExit) {
              signal_reason = 'OUTLOOK_NOT_UP';
            } else {
              signal_reason = 'TRAILING_STOP'; // fallback
            }
          } else if (signal?.type === 'WATCH_SELL') {
            signal_reason = 'WATCH_SELL';
          } else {
            signal_reason = 'OUTLOOK_NOT_UP';
          }

          if (stopTriggered || (signal?.type === 'WATCH_SELL') || outlookExit) {
        const proceeds = Math.floor(position.btc * price);
        const fee = Math.floor(proceeds * this.feeRate);
        const net = proceeds - fee;
        const realizedPnl = net - position.spent;
        
        this.state.cash += net;
        this.state.position = null;
        this.state.ledger.push({ action: 'SELL', at: new Date(at).toISOString(), price, idr: proceeds, btc: position.btc, signal: signal_reason, changePct: signal.changePct ?? null, entryPrice: position.entryPrice, peakPrice: position.peakPrice, profitPct, drawdownPct: targetReached ? drawdownPct : null, fee, net, realizedPnl });
        this.persist();
        return { action: 'SELL', trade: this.state.ledger[this.state.ledger.length - 1] };
      }
    }
    
    // Enhanced buy signal logic with filters
    if (signal?.type === 'WATCH_BUY' && !this.state.position && this.state.cash > 0) {
      // Check dynamic momentum threshold
      if (adjustedMomentum < dynamicThresholds.min) {
        return { action: null, reason: `Momentum ${adjustedMomentum.toFixed(2)}% di bawah threshold dinamis ${dynamicThresholds.min.toFixed(2)}%` };
      }
      
      // Volume confirmation
      if (this.state.volumeMA && (signal.volume || 0) < this.state.volumeMA * this.config.minVolumeMA) {
        return { action: null, reason: `Volume ${signal.volume || 0} di bawah MA${this.config.volumeWindow} (${Math.round(this.state.volumeMA)})` };
      }
      
      const spent = Math.floor(this.state.cash * this.fraction);
      if (spent < MIN_NOTIONAL_IDR) return { action: null, reason: `Saldo simulasi ${spent} IDR < minimum order ${MIN_NOTIONAL_IDR} IDR.` };
      
      const fee = Math.floor(spent * this.feeRate);
      const cost = spent + fee;
      if (cost > this.state.cash) return { action: null, reason: `Saldo simulasi tidak cukup untuk fee ${fee} IDR.` };
      
      const btc = spent / price;
      if (spent <= 0 || btc <= 0) return { action: null, reason: 'Saldo virtual tidak mencukupi.' };
      
      const trade = { action: 'BUY', at: new Date(at).toISOString(), price, idr: spent, btc, signal: signal.type, changePct: signal.changePct ?? null, fee };
      this.state.cash -= cost;
      this.state.position = { entryPrice: price, btc, spent: cost, openedAt: trade.at, peakPrice: price };
      this.state.ledger.push(trade);
      this.persist();
      return { action: 'BUY', trade };
    }
    
    return { action: null, reason: this.state.position ? 'Posisi simulasi masih terbuka.' : 'Tidak ada sinyal untuk simulasi transaksi.' };
  }

  report(price) {
    const position = this.state.position;
    const unrealized = position && Number.isFinite(price) ? Math.floor(position.btc * price) - position.spent : 0;
    const equity = this.state.cash + (position && Number.isFinite(price) ? Math.floor(position.btc * price) : 0);
    
    // Update peak equity for drawdown tracking
    if (equity > this.state.peakEquity) {
      this.state.peakEquity = equity;
    }
    
    const drawdown = (this.state.peakEquity - equity) / this.state.peakEquity;
    if (drawdown > this.state.maxDrawdown) {
      this.state.maxDrawdown = drawdown;
    }
    
    // Update performance metrics
    this.state.totalPnL = equity - this.startingCash;
    const closed = this.state.ledger.filter(item => item.action === 'SELL');
    const wins = closed.filter(item => item.realizedPnl > 0).length;
    const losses = closed.filter(item => item.realizedPnl <= 0).length;
    
    this.state.totalTrades = closed.length;
    this.state.winTrades = wins;
    this.state.lossTrades = losses;
    
    // Enhanced metrics calculation
    const riskMetrics = {
      sharpeRatio: this.calculateSharpeRatio(closed),
      sortinoRatio: this.calculateSortinoRatio(closed),
      var95: this.calculateValueAtRisk(
        closed.map(t => t.realizedPnl / t.entryPrice), 0.05),
      cvar95: this.calculateCVaR(
        closed.map(t => t.realizedPnl / t.entryPrice), 0.05),
      maxDrawdown: this.state.maxDrawdown,
      volatility: this.calculateVolatility(
        closed.map(t => t.realizedPnl / t.entryPrice))
    };
    
    const efficiencyMetrics = {
      capitalTurnover: this.calculateCapitalTurnover(closed),
      roe: this.calculateROE(closed),
      avgTradeTime: this.calculateAverageTradeTime(closed),
      winLossRatio: this.calculateWinLossRatio(closed),
      expectancy: this.calculateExpectancy(closed)
    };
    
    const timingMetrics = {
      marketTimingAccuracy: this._calculateMarketTimingAccuracy(closed),
      entryTiming: this._calculateEntryTimingEfficiency(closed),
      exitTiming: this._calculateExitTimingEfficiency(closed)
    };
    
    return { 
      // Original metrics
      cash: this.state.cash, 
      position, 
      unrealized, 
      equity, 
      pnl: equity - this.startingCash,
      drawdown: drawdown,
      maxDrawdown: this.state.maxDrawdown,
      closedTrades: closed.length, 
      wins, 
      winRate: closed.length ? wins / closed.length * 100 : null, 
      ledger: this.state.ledger,
      
      // Enhanced metrics
      riskMetrics,
      efficiencyMetrics,
      timingMetrics
    };
  }
}

export function loadPaperTracker({ file, startingCash = 31000, fraction = 0.25, feeRate = FEE_RATE } = {}) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  };
  return new PaperTracker({ startingCash, fraction, state, save, feeRate });
}

export function formatPaperReport(report, currentPrice) {
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;
  const lines = ['🧪 PAPER TRADING BTC/IDR — SIMULASI', `Saldo virtual: ${money(report.cash)}`];
  if (report.position) lines.push(`Posisi simulasi: ${report.position.btc.toLocaleString('id-ID', { maximumFractionDigits: 8 })} BTC @ ${money(report.position.entryPrice)}`, `Perubahan belum terealisasi: ${report.unrealized >= 0 ? '+' : '-'}${money(Math.abs(report.unrealized))}`);
  else lines.push('Posisi simulasi: tidak ada');
  lines.push(`Nilai ekuitas simulasi: ${money(report.equity)}`, `Untung/rugi total simulasi: ${report.pnl >= 0 ? '+' : '-'}${money(Math.abs(report.pnl))}`, `Transaksi tertutup: ${report.closedTrades}`, `Akurasi transaksi tertutup: ${report.winRate === null ? 'belum ada hasil' : `${report.winRate.toLocaleString('id-ID', { maximumFractionDigits: 1 })}% (${report.wins}/${report.closedTrades} untung)`}`, `Harga terakhir: ${currentPrice ? money(currentPrice) : 'belum tersedia'}`, `Drawdown: ${(report.drawdown * 100).toFixed(1)}%`, 'Simulasi saja; tidak ada dana atau order Indodax yang digunakan.');
  return lines.join('\n');
}