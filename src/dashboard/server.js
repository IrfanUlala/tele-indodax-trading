// src/dashboard/server.js - Dashboard Express Server
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPaperTracker } from '../paper-trading.js';
import { loadAltcoinPaperTracker } from '../altcoin-paper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// Paper tracker instances (shared with main bot)
let paperTracker = null;
let altcoinPaperTracker = null;
let lastAltcoinPaperPrices = new Map();

export function setPaperTracker(tracker) {
  paperTracker = tracker;
}

export function setAltcoinPaperTracker(tracker, pricesMap) {
  altcoinPaperTracker = tracker;
  lastAltcoinPaperPrices = pricesMap;
}

export function getPaperTracker() {
  return paperTracker;
}

export function getAltcoinPaperTracker() {
  return altcoinPaperTracker;
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// API Routes

// Get current paper trading status
app.get('/api/status', (req, res) => {
  if (!paperTracker) {
    return res.status(503).json({ error: 'Paper tracker not initialized' });
  }
  
  try {
    const currentPrice = req.query.price ? parseFloat(req.query.price) : null;
    const report = paperTracker.report(currentPrice);
    
    // Include altcoin paper data if available
    let altcoinReport = null;
    if (altcoinPaperTracker) {
      const pricesObj = Object.fromEntries(lastAltcoinPaperPrices);
      altcoinReport = altcoinPaperTracker.report(pricesObj);
    }
    
    res.json({
      success: true,
      data: {
        ...report,
        regime: paperTracker.detectMarketRegime ? paperTracker.detectMarketRegime() : null,
        turtleStatus: paperTracker.applyTurtleDrawdownProtection ? paperTracker.applyTurtleDrawdownProtection() : null,
        config: paperTracker.config,
        altcoin: altcoinReport
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trade history
app.get('/api/trades', (req, res) => {
  if (!paperTracker) {
    return res.status(503).json({ error: 'Paper tracker not initialized' });
  }
  
  try {
    const ledger = paperTracker.state.ledger || [];
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const trades = ledger.slice(-limit - offset).slice(0, limit).reverse();
    
    res.json({
      success: true,
      data: {
        trades,
        total: ledger.length,
        limit,
        offset
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get performance metrics
app.get('/api/metrics', (req, res) => {
  if (!paperTracker) {
    return res.status(503).json({ error: 'Paper tracker not initialized' });
  }
  
  try {
    const currentPrice = req.query.price ? parseFloat(req.query.price) : null;
    const report = paperTracker.report(currentPrice);
    
    res.json({
      success: true,
      data: {
        riskMetrics: report.riskMetrics,
        efficiencyMetrics: report.efficiencyMetrics,
        timingMetrics: report.timingMetrics,
        winRate: report.winRate,
        totalTrades: report.closedTrades,
        totalPnL: report.pnl,
        maxDrawdown: report.maxDrawdown,
        currentDrawdown: report.drawdown
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get regime info
app.get('/api/regime', (req, res) => {
  if (!paperTracker || !paperTracker.detectMarketRegime) {
    return res.status(503).json({ error: 'Regime detection not available' });
  }
  
  try {
    const regime = paperTracker.detectMarketRegime();
    const adjustedParams = paperTracker.getRegimeAdjustedParams ? 
      paperTracker.getRegimeAdjustedParams({}) : {};
    
    // Handle both string (UNKNOWN) and object return types
    const regimeData = typeof regime === 'string' ? { regime } : regime;
    
    res.json({
      success: true,
      data: {
        ...regimeData,
        adjustedParams
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get turtle protection status
app.get('/api/turtle', (req, res) => {
  if (!paperTracker || !paperTracker.applyTurtleDrawdownProtection) {
    return res.status(503).json({ error: 'Turtle protection not available' });
  }
  
  try {
    const status = paperTracker.applyTurtleDrawdownProtection();
    
    res.json({
      success: true,
      data: {
        ...status,
        levels: paperTracker.config.turtleDrawdownLevels,
        reductions: paperTracker.config.turtleSizeReduction,
        recoveryThreshold: paperTracker.config.turtleRecoveryThreshold
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get altcoin paper trading status
app.get('/api/altcoin', (req, res) => {
  if (!altcoinPaperTracker) {
    return res.status(503).json({ error: 'Altcoin paper tracker not initialized' });
  }
  
  try {
    const pricesObj = Object.fromEntries(lastAltcoinPaperPrices);
    const report = altcoinPaperTracker.report(pricesObj);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      trackerInitialized: !!paperTracker
    }
  });
});

// Serve dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

export function startDashboardServer(customPort = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(customPort, () => {
      console.log(`📊 Dashboard running at http://localhost:${customPort}`);
      resolve(server);
    });
  });
}

export default app;