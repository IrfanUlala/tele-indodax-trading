import 'dotenv/config';
import express from 'express';
import { Bot } from 'grammy';
import WebSocket from 'ws';
import { calculateSignal } from './signals.js';
import { nextMovementAlert, percentChange } from './position.js';
import { marketOutlook } from './prediction.js';
import { IndodaxPrivateApi, formatWallet } from './indodax.js';
import { TradeFlow, OrderControl, validateLiveConfig } from './trade-flow.js';
import { formatStatus } from './status.js';
import { formatPaperReport, loadPaperTracker } from './paper-trading.js';
import { formatAltcoinPaperReport, formatAltcoinPaperTrade, loadAltcoinPaperTracker } from './altcoin-paper.js';
import { formatLiveAltcoinReport, formatLiveAltcoinTrade, loadLiveAltcoinTracker } from './altcoin-live.js';
import { callbackNotice } from './callback-notice.js';
import { rankIdrPairs, scanTopPairs, formatAltcoinReport as renderAltcoinReport, formatAltcoinAlert } from './altcoin-scanner.js';
import { startDashboardServer, setPaperTracker, setAltcoinPaperTracker } from './dashboard/server.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const priceHistoryFile = path.join(logDir, 'price-history.jsonl');

function recordPriceHistory(symbol, price, source, at = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;
  const entry = { symbol, price, source, at, timestamp: new Date(at).toISOString() };
  try {
    fs.appendFileSync(priceHistoryFile, JSON.stringify(entry) + '\n');
  } catch (error) {
    console.error('Price history record failed:', error.message);
  }
}
const orderControl = new OrderControl({ file: path.join(dataDir, 'order-control.json'), auditFile: path.join(logDir, 'orders.jsonl') });
const liveConfig = validateLiveConfig(process.env);
const btcTicker = async () => {
  const response = await fetch('https://indodax.com/api/ticker/btcidr', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Ticker HTTP ${response.status}`);
  const data = await response.json();
  return Number(data?.ticker?.last);
};
const fetchBtcPairMetadata = async () => {
  const response = await fetch('https://indodax.com/api/pairs', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Pair metadata HTTP ${response.status}`);
  const pairs = await response.json();
  return pairs.find(pair => pair.id === 'btcidr') ?? null;
};
const pairMetadata = await fetchBtcPairMetadata().catch(error => { console.error('BTC pair metadata unavailable; live orders will be blocked:', error.message); return null; });
const dataFile = path.join(dataDir, 'position.json');
function readPosition() { try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { return null; } }
function writePosition(value) { fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(dataFile, JSON.stringify(value, null, 2), { mode: 0o600 }); }
let position = readPosition();
let pendingSell = false;
const movementStep = 0.5;
const heldTier = new Map();

function watchPosition(price) {
  if (!position || pendingSell) return;
  const changePct = percentChange(position.entryPrice, price);
  if (changePct === null) return;
  const tier = nextMovementAlert(changePct, position.lastNotifiedTier ?? 0, movementStep);
  if (tier === null) return;
  position.lastNotifiedTier = tier;
  writePosition(position);
  const direction = tier > 0 ? 'NAIK' : 'TURUN';
  const text = `BTC/IDR — PERGERAKAN ${direction} ${Math.abs(tier) * movementStep}% dari harga beli manual
Harga beli: Rp${position.entryPrice.toLocaleString('id-ID')}
Harga sekarang: Rp${price.toLocaleString('id-ID')}
Perubahan: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%

Ini notifikasi perubahan, bukan rekomendasi. Pilih tindakan manual:`;
  void sendTelegram(text, [[{ text: 'Jual (catat manual)', callback_data: `pos_sell_${tier}` }, { text: 'Pertahankan', callback_data: `pos_hold_${tier}` }]]);
}

function acknowledgePosition(tier, action) {
  if (!position) return 'Tidak ada posisi tercatat.';
  if (action === 'sell') {
    pendingSell = true;
    return 'Pilihan JUAL dicatat. Bot tidak mengirim order. Setelah Anda menjual manual, gunakan /selesai untuk menutup pencatatan posisi.';
  }
  heldTier.set(Number(tier), true);
  return 'Pilihan PERTAHANKAN dicatat. Bot tetap memantau dan memberi notifikasi pada ambang 0,5% berikutnya.';
}

const app = express();
const port = Number(process.env.PORT || 3000);
const threshold = Number(process.env.SIGNAL_THRESHOLD_PCT || 0.5);
const cooldownMs = Number(process.env.ALERT_COOLDOWN_MINUTES || 60) * 60_000;
const intervalMs = Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS || 30)) * 1000;
const altcoinIntervalMs = Math.max(10, Number(process.env.ALTCOIN_POLL_SECONDS || 15)) * 1000;
const history = [];
const altcoinHistories = new Map();
const altcoinCandidateState = new Set();
let latestAltcoinScan = [];
let altcoinLastScanAt = null;
const paperFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'paper-trading.json');
const paperTracker = loadPaperTracker({ file: paperFile, startingCash: Number(process.env.PAPER_STARTING_IDR || 31000), fraction: 0.25 });
setPaperTracker(paperTracker);
const altcoinPaperFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'altcoin-paper-trading.json');
const altcoinPaperTracker = loadAltcoinPaperTracker({ file: altcoinPaperFile, startingCash: Number(process.env.ALTCOIN_PAPER_STARTING_IDR || 31000), fraction: 0.25, stopDropPct: 5 });
const lastAltcoinPaperPrices = new Map();
setAltcoinPaperTracker(altcoinPaperTracker, lastAltcoinPaperPrices);

const altcoinLiveFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'altcoin-live-trading.json');
let altcoinLiveTracker = null;
if (liveConfig && process.env.INDODAX_API_KEY && process.env.INDODAX_API_SECRET) {
  const tradeApi = new IndodaxPrivateApi({ key: process.env.INDODAX_API_KEY, secret: process.env.INDODAX_API_SECRET });
  altcoinLiveTracker = loadLiveAltcoinTracker({
    file: altcoinLiveFile,
    startingCash: Number(process.env.ALTCOIN_LIVE_STARTING_IDR || 31000),
    fraction: 0.25,
    stopDropPct: 5,
    entryThresholdPct: Number(process.env.ALTCOIN_ENTRY_THRESHOLD_PCT || 1),
    api: tradeApi,
    orderControl,
    auditFile: path.join(logDir, 'orders.jsonl'),
    maxDeviationPct: Number(process.env.MAX_PRICE_DEVIATION_PCT || 2),
    getMarketPrice: async (symbol) => {
      const response = await fetch(`https://indodax.com/api/ticker/${symbol.toLowerCase()}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const data = await response.json();
      return Number(data?.ticker?.last);
    },
    sendAlert: async (text) => sendTelegram(text)
  });
  console.log('[altcoin-live] Live altcoin trading AKTIF (Rp13.000/order, fee 0.1%)');
} else {
  console.log('[altcoin-live] Live altcoin trading NONAKTIF (LIVE_TRADING_ENABLED=false atau kredensial kurang)');
}

let latest = null;
let lastAlertAt = 0;
let ws = null;
let wsRetry = null;
let bot = null;
let lastWsMessageAt = null;

app.get('/health', (_req, res) => res.json({ ok: true, pair: 'BTC/IDR', latest, websocketConnected: ws?.readyState === WebSocket.OPEN, lastWsMessageAt }));
app.listen(port, '127.0.0.1', () => console.log(`Health endpoint on 127.0.0.1:${port}/health`));

// Start dashboard server on separate port
const dashboardPort = Number(process.env.DASHBOARD_PORT || 3001);
void startDashboardServer(dashboardPort);

async function sendTelegram(text, keyboard, extra = {}) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) return;
  const options = { ...extra };
  if (keyboard) options.reply_markup = { inline_keyboard: keyboard };
  try { await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, text, options); }
  catch (error) { console.error('Telegram send failed:', error.message); }
}

function processPrice(price, source) {
  if (!Number.isFinite(price) || price <= 0) return;
  watchPosition(price);
  recordPriceHistory('BTC/IDR', price, source);
  const now = Date.now();
  latest = { pair: 'BTC/IDR', price, source, observedAt: new Date(now).toISOString() };
  history.push({ price, at: now });
  while (history.length > 60) history.shift();
  const windowHistory = history.filter(x => now - x.at <= 15 * 60_000);
  const signal = calculateSignal(windowHistory, threshold);
  const outlook = marketOutlook(windowHistory);
  const paperResult = paperTracker.onSignal(signal, price, now, outlook.direction);
  if (paperResult.action) {
    const trade = paperResult.trade;
    const report = paperTracker.report(price);
    const winRate = report.winRate ?? 0;
    const winRateText = report.closedTrades > 0 ? `${(winRate * 100).toFixed(0)}% (${report.profitTrades}/${report.closedTrades})` : 'N/A (belum ada trade)';
    const sampleCount = windowHistory.length;
    const entryAmount = trade.action === 'BUY' ? `Rp${trade.idr.toLocaleString('id-ID')}` : `Rp${Math.abs(trade.realizedPnl).toLocaleString('id-ID')}`;

    const msg = `🟢 ${trade.action === 'BUY' ? 'BELI' : 'JUAL'} BTC/IDR
├─ Win rate: ${winRateText}
├─ Signal: ${signal.changePct.toFixed(2)}% (${signal.type})
├─ Samples: ${sampleCount} beruntun ${signal.type === 'WATCH_BUY' ? 'naik' : 'turun'}
├─ Outlook: ${outlook.direction} (${outlook.changePct?.toFixed(2) ?? 'N/A'}%)
├─ Entry: ${entryAmount}
├─ Harga: Rp${price.toLocaleString('id-ID')}
└─ Target: +1%, Stop: -1%

Simulasi saja — cek /paper untuk laporan lengkap`;
    void sendTelegram(msg);
  }
  if (signal.type !== 'WAIT' && signal.type !== 'HOLD' && now - lastAlertAt >= cooldownMs) {
    lastAlertAt = now;
    const action = signal.type === 'WATCH_BUY' ? 'BELI' : 'JUAL';
    sendTelegram(`BTC/IDR ${signal.type}\nHarga: Rp${price.toLocaleString('id-ID')}\n${signal.reason}\n\nIni hanya sinyal pantauan, bukan nasihat keuangan. Bot tidak membuat order.`, [[{ text: `Setujui ${action} (catat saja)`, callback_data: `proposal_${action.toLowerCase()}` }, { text: 'Abaikan', callback_data: 'proposal_ignore' }]]);
  }
}

let wsConnectRetries = 0;
let wsPingTimer = null;
let wsDisabled = true; // Indodax WS returning 3003 (Go Away); use REST fallback
function connectMarketSocket() {
  if (wsDisabled) {
    console.log('WebSocket disabled; using REST polling fallback');
    return;
  }
  if (ws) { try { ws.terminate(); } catch { } }
  if (wsPingTimer) clearInterval(wsPingTimer);
  ws = new WebSocket('wss://ws3.indodax.com/ws/');
  let subscribed = false;
  ws.on('open', () => {
    console.log('Indodax market WebSocket connected');
    wsConnectRetries = 0;
    ws.send(JSON.stringify({ method: 'subscribe', params: ['market:trade-activity-btcidr'] }));
    wsPingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
  });
  ws.on('message', raw => {
    lastWsMessageAt = new Date().toISOString();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.result?.channel === 'market:trade-activity-btcidr') subscribed = true;
      const trades = msg?.result?.data?.data;
      if (Array.isArray(trades)) for (const trade of trades) if (String(trade[0]).trim().toLowerCase() === 'btcidr') processPrice(Number(trade[4]), 'websocket');
    } catch (error) { console.error('Invalid market WS message:', error.message); }
  });
  ws.on('error', error => console.error('Market WS error:', error.message, { subscribed, code: error.code }));
  ws.on('close', code => {
    if (wsPingTimer) clearInterval(wsPingTimer);
    console.log('Market WS closed', { code, subscribed, retries: wsConnectRetries });
    const delay = Math.min(1000 * Math.pow(2, wsConnectRetries), 30000);
    wsConnectRetries++;
    wsRetry = setTimeout(connectMarketSocket, delay);
  });
}

async function pollTicker() {
  try {
    const response = await fetch('https://indodax.com/api/ticker/btcidr', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    processPrice(Number(json?.ticker?.last), 'rest');
  } catch (error) { console.error('Ticker poll failed:', error.message); }
}

async function pollAltcoins() {
  try {
    const response = await fetch('https://indodax.com/api/tickers', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const now = Date.now();
    const topPairs = rankIdrPairs(payload, 10);
    for (const pair of topPairs) {
      const tickerKey = Object.keys(payload.tickers ?? {}).find(key => key.replace('_', '').toLowerCase() === pair.pair);
      const price = Number(payload.tickers?.[tickerKey]?.last);
      if (!(price > 0 && Number.isFinite(price))) continue;
      const points = altcoinHistories.get(pair.symbol) ?? [];
      points.push({ price, at: now });
      recordPriceHistory(pair.symbol, price, 'rest-polling');
      while (points.length > 0 && now - points[0].at > 20 * 60_000) points.shift();
      altcoinHistories.set(pair.symbol, points);
    }
    latestAltcoinScan = scanTopPairs(payload, altcoinHistories, { now, limit: 10, windowMs: 15 * 60_000, thresholdPct: threshold });
    for (const item of latestAltcoinScan) {
      const price = altcoinHistories.get(item.symbol)?.at(-1)?.price;
      if (!(price > 0)) continue;
      const points = altcoinHistories.get(item.symbol) ?? [];
      const recent = points.filter(point => now - point.at <= 15 * 60_000 && now >= point.at);
      const changePct = recent.length >= 3 ? ((recent.at(-1).price - recent[0].price) / recent[0].price) * 100 : null;

      // Uptrend-based entry confirmation
      const isUptrend = item.isUptrend ?? false;
      const minSamplesForTrend = isUptrend ? 3 : 4; // 2 consecutive naik if uptrend, 3 if not
      const trendConfirmed = recent.length >= minSamplesForTrend &&
        recent.at(-1).price > recent.at(-2).price &&
        (isUptrend || recent.at(-2).price > recent.at(-3).price);

      const outlook = marketOutlook(recent, 15 * 60_000, 0.2).direction;
      const result = altcoinPaperTracker.update({ symbol: item.symbol, price, changePct, trendConfirmed, outlook, at: now });
      lastAltcoinPaperPrices.set(item.symbol, price);
      if (result.action) {
        const altcoinReport = altcoinPaperTracker.report(lastAltcoinPaperPrices);
        void sendTelegram(formatAltcoinPaperTrade(result.trade, altcoinReport));
      }

      // Live altcoin trading (after paper update)
      if (altcoinLiveTracker) {
        const liveResult = altcoinLiveTracker.update({ symbol: item.symbol, price, changePct, trendConfirmed, outlook, at: now });
        if (liveResult.action) {
          const liveReport = await altcoinLiveTracker.report(lastAltcoinPaperPrices);
          void sendTelegram(formatLiveAltcoinTrade(liveResult.trade, liveReport));
        }
      }
    }
    altcoinLastScanAt = new Date(now).toISOString();
    const currentCandidates = new Set(latestAltcoinScan.filter(item => item.changePct !== null).map(item => item.symbol));
    for (const item of latestAltcoinScan) {
      if (item.changePct === null || altcoinCandidateState.has(item.symbol)) continue;
      altcoinCandidateState.add(item.symbol);
      const samples = altcoinHistories.get(item.symbol) ?? [];
      const outlook = marketOutlook(samples, 15 * 60_000, 0.2);
      void sendTelegram(formatAltcoinAlert({ ...item, outlook }), undefined, { parse_mode: 'Markdown' });
    }
    for (const symbol of altcoinCandidateState) if (!currentCandidates.has(symbol)) altcoinCandidateState.delete(symbol);
  } catch (error) { console.error('Altcoin ticker scan failed:', error.message); }
}

function formatAltcoinReport() {
  return renderAltcoinReport({ items: latestAltcoinScan, thresholdPct: threshold, updatedAt: altcoinLastScanAt });
}

void pollAltcoins();
const altcoinTimer = setInterval(() => void pollAltcoins(), altcoinIntervalMs);
void altcoinTimer;

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  const tradeApi = process.env.INDODAX_API_KEY && process.env.INDODAX_API_SECRET
    ? new IndodaxPrivateApi({ key: process.env.INDODAX_API_KEY, secret: process.env.INDODAX_API_SECRET })
    : null;
  const tradeFlow = tradeApi && process.env.TELEGRAM_CHAT_ID
    ? new TradeFlow({ api: tradeApi, ownerId: process.env.TELEGRAM_CHAT_ID, liveEnabled: liveConfig, maxOrderIdr: Number(process.env.MAX_ORDER_IDR), maxDeviationPct: Number(process.env.MAX_PRICE_DEVIATION_PCT), pairMetadata, control: orderControl, auditFile: path.join(logDir, 'orders.jsonl'), getMarketPrice: btcTicker, send: (chatId, text, keyboard) => bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) })
    : null;
  const ownerOnly = ctx => String(ctx.chat.id) === String(process.env.TELEGRAM_CHAT_ID);
  bot.command('pause', async ctx => { if (ownerOnly(ctx)) { orderControl.pause(); await ctx.reply('Trading dijeda; order baru diblokir.'); } });
  bot.command('resume', async ctx => { if (ownerOnly(ctx)) { try { orderControl.resume(); await ctx.reply('Trading dilanjutkan sesuai LIVE_TRADING_ENABLED dan batas konfigurasi.'); } catch (error) { await ctx.reply(error.message); } } });
  bot.command('killswitch', async ctx => { if (ownerOnly(ctx)) { orderControl.kill(); await ctx.reply('KILL SWITCH aktif; semua order baru diblokir.'); } });
  bot.command('resolveorder', async ctx => { if (ownerOnly(ctx)) { if (!orderControl.state.uncertain) return ctx.reply('Tidak ada order berstatus TIDAK PASTI.'); orderControl.resolveUncertain(); await ctx.reply('Status ditandai telah diperiksa manual. Trading tetap dijeda; gunakan /resume setelah memastikan status order di Indodax.'); } });
  async function sendStatus(chatId) {
    if (String(chatId) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    let account = null;
    try { if (tradeApi) account = await tradeApi.getInfo(); }
    catch (error) { console.error('Status wallet read failed:', error.message); }
    const current = history.at(-1)?.price ?? latest?.price;
    const prior = history.length > 1 ? history.at(-2).price : null;
    const status = formatStatus({ latest, previous: prior, account, marketConnected: ws?.readyState === WebSocket.OPEN, history, position });
    await bot.api.sendMessage(chatId, status.text, { reply_markup: { inline_keyboard: status.keyboard } });
  }
  bot.command('altcoins', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    await ctx.reply(formatAltcoinReport());
  });
  bot.command('altcoinslive', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    if (!altcoinLiveTracker) return await ctx.reply('Live altcoin trading tidak aktif. Set LIVE_TRADING_ENABLED=true dan kredensial API.');
    const report = await altcoinLiveTracker.report(lastAltcoinPaperPrices);
    await ctx.reply(formatLiveAltcoinReport(report, altcoinLiveTracker.entryThresholdPct));
  });
  bot.command('rule', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const rules = `📋 TRADING RULES — Paper Simulasi

🔷 Signal Threshold (Entry Condition)
• Ambang naik: ≥ 0.5% dalam 15 menit
• Ambang turun: ≤ -0.5% dalam 15 menit
• Konfirmasi: 3 sample beruntun naik/turun (no bounce)
• Env: SIGNAL_THRESHOLD_PCT=0.5

🟢 BTC/IDR Entry
• Saat WATCH_BUY signal (0.5% + 3 naik) + outlook NAIK
• Beli: 25% dari saldo simulasi
• Min order: 10,000 IDR notional
• Fee: 0.1% deducted (entry & exit)
• Cooldown: 15 menit sebelum entry berikutnya

📈 BTC/IDR Exit Rules

Exit 1 (Sebelum Target):
• Jika: outlook NETRAL/TURUN sebelum +1%
• Action: Jual 100% posisi (ambil profit kecil)

Exit 2 (Sesudah Target):
• Saat: profit ≥ +1% tercapai (target)
• Hold: jika outlook masih NAIK
• Jual saat: outlook NETRAL/TURUN OR trailing 1% dari peak

Stop Loss:
• Jika: loss ≤ -1% AND outlook ≠ NAIK
• Action: Sell 100% (cut loss)

🪙 Altcoin IDR (Top-10 Volume)
• Entry: sama BTC (0.5% + 3 naik + NAIK outlook)
• Beli: 25% cash per symbol
• Cooldown: 15 menit per symbol (multiple positions OK)
• Exit: sama BTC rules
• Target: +1%
• Stop loss: 1% sebelum target
• Trailing: 1% dari peak

🌡️ Outlook Detection (Trend)
• Window: last 15 minutes
• Min samples: 3
• NAIK: changePct ≥ 0.2% AND semua sample beruntun naik
• TURUN: changePct ≤ -0.2% AND semua sample beruntun turun
• NETRAL: mixed trend atau perubahan < 0.2%

⚙️ Konfigurasi Default
• BTC polling: 30 detik (POLL_INTERVAL_SECONDS)
• Altcoin polling: 15 detik (ALTCOIN_POLL_SECONDS)
• Price history: logs/price-history.jsonl
• Paper state: data/position.json, data/altcoin-paper.json
• Fee: 0.1% (Indodax default)
• Min notional: 10,000 IDR

🛡️ Safety
• Live trading: disabled by default
• Paper trading: simulasi saja, tidak ada order nyata
• Kill switch: persistent across restarts
• Audit log: logs/audit.jsonl (signed, immutable)`;
    await ctx.reply(rules);
  });
  bot.command('paper', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const report = paperTracker.report(latest?.price);
    await ctx.reply(formatPaperReport(report, latest?.price));
    const prices = Object.fromEntries(Object.keys(altcoinPaperTracker.state.positions).map(symbol => [symbol, lastAltcoinPaperPrices.get(symbol)]));
    await ctx.reply(formatAltcoinPaperReport(altcoinPaperTracker.report(prices)), { parse_mode: 'Markdown' });
  });
  bot.command('wallet', async ctx => {
    if (!process.env.TELEGRAM_CHAT_ID || String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    if (!process.env.INDODAX_API_KEY || !process.env.INDODAX_API_SECRET) return ctx.reply('Akses saldo belum dikonfigurasi. Periksa kredensial Indodax secara lokal.');
    try {
      const api = new IndodaxPrivateApi({ key: process.env.INDODAX_API_KEY, secret: process.env.INDODAX_API_SECRET });
      const account = await api.getInfo();
      await ctx.reply(formatWallet(account, { price: latest?.price, entryPrice: position?.entryPrice }));
    } catch (error) {
      console.error('Indodax wallet read failed:', error.message);
      await ctx.reply('Gagal membaca saldo Indodax. Periksa izin API V2/koneksi, lalu coba lagi.');
    }
  });
  bot.command('buy', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    if (!tradeFlow) return ctx.reply('Trading belum dikonfigurasi.');
    try { await tradeFlow.start(ctx.chat.id, 'BUY'); }
    catch (error) { console.error('Trade start failed:', error.message); await ctx.reply('Gagal memulai order beli. Periksa koneksi/izin API lalu coba lagi.'); }
  });
  bot.command('sell', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    if (!tradeFlow) return ctx.reply('Trading belum dikonfigurasi.');
    try { await tradeFlow.start(ctx.chat.id, 'SELL'); }
    catch (error) { console.error('Trade start failed:', error.message); await ctx.reply('Gagal memulai order jual. Periksa koneksi/izin API lalu coba lagi.'); }
  });
  bot.on('callback_query:data', async ctx => {
    if (String(ctx.callbackQuery.message?.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) return ctx.answerCallbackQuery({ text: 'Chat tidak diizinkan.' });
    const data = ctx.callbackQuery.data;
    let answer = 'Tombol tidak dikenali.';
    const pct = data.match(/^trade_pct:([^:]+):(25|50|75|100)$/);
    const confirm = data.match(/^trade_confirm:(.+)$/);
    const cancel = data.match(/^trade_cancel:(.+)$/);
    if (pct && tradeFlow) answer = await tradeFlow.choosePercent(ctx.chat.id, pct[1], Number(pct[2]));
    else if (confirm && tradeFlow) answer = await tradeFlow.confirm(ctx.chat.id, confirm[1]);
    else if (cancel && tradeFlow) answer = tradeFlow.cancel(ctx.chat.id, cancel[1]);
    else if (data === 'status_buy' && tradeFlow) { await tradeFlow.start(ctx.chat.id, 'BUY'); answer = 'Pilih persentase beli dari panel di bawah.'; }
    else if (data === 'status_sell' && tradeFlow) { await tradeFlow.start(ctx.chat.id, 'SELL'); answer = 'Pilih persentase jual dari panel di bawah.'; }
    else if (data === 'status_refresh') { await sendStatus(ctx.chat.id); answer = 'Status diperbarui.'; }
    else {
      const match = data.match(/^pos_(sell|hold)_(-?[0-9]+)$/);
      if (match) answer = acknowledgePosition(match[2], match[1]);
      else if (data === 'proposal_ignore') answer = 'Sinyal diabaikan.';
      else if (data.startsWith('proposal_')) answer = 'Pilihan dicatat saja; bot ini tidak mengeksekusi transaksi.';
    }
    await ctx.answerCallbackQuery({ text: callbackNotice(answer) });
    await ctx.api.sendMessage(process.env.TELEGRAM_CHAT_ID, answer);
  });
  bot.command('beli', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const price = Number(ctx.match);
    if (!(price > 0 && Number.isFinite(price))) return ctx.reply('Format: /beli <harga_IDR> — contoh /beli 1450000000. Catat setelah Anda membeli BTC secara manual.');
    position = { pair: 'btcidr', entryPrice: price, openedAt: new Date().toISOString(), lastNotifiedTier: 0 };
    pendingSell = false;
    writePosition(position);
    await ctx.reply(`Posisi BTC/IDR dicatat. Harga beli manual Rp${price.toLocaleString('id-ID')}. Saya akan memberi notifikasi setiap pergerakan naik/turun 0,5% dari harga tersebut. Bot tidak mengeksekusi order.`);
  });
  bot.command('selesai', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    position = null; pendingSell = false;
    try { fs.unlinkSync(dataFile); } catch { }
    await ctx.reply('Pencatatan posisi ditutup. Gunakan /beli <harga_IDR> setelah pembelian manual berikutnya.');
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    try { await sendStatus(ctx.chat.id); }
    catch (error) { console.error('Status render failed:', error.message); await ctx.reply('Gagal memperbarui status saat ini.'); }
  });















































































  bot.catch(error => console.error('Telegram bot error:', error.message));
  void bot.start().catch(error => console.error('Telegram polling error:', error.message));
}

connectMarketSocket();
void pollTicker();
const pollTimer = setInterval(() => void pollTicker(), intervalMs);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(pollTimer); clearTimeout(wsRetry); ws?.close(); bot?.stop(); process.exit(0);
});
