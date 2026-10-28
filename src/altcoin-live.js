import fs from 'node:fs';
import path from 'node:path';
import { OrderControl, validateOrderAmount, OrderSafetyError, appendAudit } from './trade-flow.js';

const FEE_RATE = 0.001; // 0.1% Indodax fee
const MIN_NOTIONAL_IDR = 13000;
const COOLDOWN_MS = 15 * 60 * 1000;
const TARGET_PROFIT_PCT = 1;
const STOP_LOSS_PCT = 5;
const TRAILING_STOP_PCT = 5;

export class LiveAltcoinTracker {
  constructor({ api, startingCash = 31000, fraction = 0.25, stopDropPct = 5, cooldownMs = COOLDOWN_MS, state = null, save = null, orderControl = null, auditFile = null, maxDeviationPct = 2, getMarketPrice = async () => null, sendAlert = async () => { } } = {}) {
    if (!(startingCash > 0) || !(fraction > 0 && fraction <= 1) || !(stopDropPct > 0)) throw new Error('Invalid altcoin live settings.');
    this.api = api;
    this.startingCash = startingCash;
    this.fraction = fraction;
    this.stopDropPct = stopDropPct;
    this.cooldownMs = cooldownMs;
    this.save = save;
    this.orderControl = orderControl;
    this.auditFile = auditFile;
    this.maxDeviationPct = maxDeviationPct;
    this.getMarketPrice = getMarketPrice;
    this.sendAlert = sendAlert;
    this.pairInfoCache = new Map();

    this.state = state ?? { cash: startingCash, positions: {}, ledger: [], cooldownUntil: {} };
    this.state.cooldownUntil ??= {};
    this.state.positions ??= {};
    this.state.ledger ??= [];
  }

  persist() { this.save?.(this.state); }

  async getPairInfo(symbol) {
    if (this.pairInfoCache.has(symbol)) return this.pairInfoCache.get(symbol);
    const info = await this.api.getPairInfo(symbol);
    if (info) this.pairInfoCache.set(symbol, info);
    return info;
  }

  roundQuantity(quantity, increment) {
    if (!increment || increment <= 0) return quantity;
    const factor = 10 ** Math.max(0, String(increment).split('.')[1]?.length ?? 0);
    const v = Math.floor(quantity * factor + 1e-9);
    const i = Math.round(increment * factor);
    return Math.floor(v / i) * i / factor;
  }

  async logOrder(event) {
    const logFile = path.join(path.dirname(this.auditFile || ''), 'altcoin-orders.jsonl');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), feePct: FEE_RATE * 100, ...event })}\n`, { mode: 0o600 });
  }

  async logFail(event) {
    const logFile = path.join(path.dirname(this.auditFile || ''), 'altcoin-order-fail.jsonl');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  }

  async checkBalance(side, symbol, price) {
    try {
      const account = await this.api.getInfo();
      if (account?.canTrade !== true) return { ok: false, reason: 'Akun tidak mengizinkan trading' };
      const asset = side === 'BUY' ? 'IDR' : symbol.toUpperCase();
      const balances = Array.isArray(account.balances) ? account.balances : [];
      const row = balances.find(item => String(item?.asset).toUpperCase() === asset);
      const available = Number(row?.free ?? 0);
      if (side === 'BUY') {
        return { ok: available >= MIN_NOTIONAL_IDR, available, reason: available >= MIN_NOTIONAL_IDR ? null : `Saldo IDR ${available} < ${MIN_NOTIONAL_IDR}` };
      } else {
        const position = this.state.positions[symbol];
        return { ok: position && available >= position.quantity, available, reason: position && available >= position.quantity ? null : `Saldo ${symbol} ${available} < posisi ${position?.quantity ?? 0}` };
      }
    } catch (error) {
      return { ok: false, available: 0, reason: `Gagal cek saldo: ${error.message}` };
    }
  }

  async executeBuy(symbol, price, changePct, outlook, at) {
    // Normalize symbol to Indodax V2 format (UPPERCASE, no separator, must end with IDR)
    let normSymbol = String(symbol).replace(/[_-]/g, '').toUpperCase();
    if (!normSymbol.endsWith('IDR')) {
      normSymbol = normSymbol + 'IDR';
    }
    const pairInfo = await this.getPairInfo(normSymbol);
    if (!pairInfo) {
      const reason = `Pair ${normSymbol} tidak ditemukan di Indodax`;
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason, price, changePct, outlook });
      await this.sendAlert(`⚠️ BELI ${normSymbol} GAGAL: ${reason}`);
      return { action: null, reason };
    }

    const balanceCheck = await this.checkBalance('BUY', normSymbol, price);
    if (!balanceCheck.ok) {
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason: balanceCheck.reason, price, changePct, outlook, available: balanceCheck.available });
      await this.sendAlert(`⚠️ BELI ${normSymbol} GAGAL: ${balanceCheck.reason}`);
      return { action: null, reason: balanceCheck.reason };
    }

    if (this.orderControl?.state?.paused) {
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason: this.orderControl.state.reason, price });
      return { action: null, reason: this.orderControl.state.reason };
    }
    if (this.orderControl?.state?.uncertain) {
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason: 'Ada order TIDAK PASTI', price });
      return { action: null, reason: 'Ada order TIDAK PASTI yang perlu direkonsiliasi' };
    }

    const quoteAmount = MIN_NOTIONAL_IDR;
    const fee = Math.floor(quoteAmount * FEE_RATE);
    const netQuote = quoteAmount - fee;
    const quantity = netQuote / price;

    const increment = Number(pairInfo?.quantity_increment);
    const minQty = Number(pairInfo?.trade_min_traded_currency);
    const roundedQty = this.roundQuantity(quantity, increment);

    if (roundedQty < minQty) {
      const reason = `Quantity ${roundedQty} < minimum pair ${minQty}`;
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason, price, quantity: roundedQty });
      return { action: null, reason };
    }

    const reviewedPrice = price;
    try {
      validateOrderAmount({
        side: 'BUY',
        amount: quoteAmount,
        available: balanceCheck.available,
        maxIdr: MIN_NOTIONAL_IDR,
        pair: pairInfo,
        price,
        reviewedPrice,
        maxDeviationPct: this.maxDeviationPct
      });
    } catch (error) {
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason: error.message, price, quoteAmount });
      return { action: null, reason: error.message };
    }

    try {
      const result = await this.api.createOrder({ symbol: normSymbol, side: 'BUY', quoteAmount });
      const orderId = result?.orderId ?? result?.data?.orderId ?? result?.data?.order_id ?? 'unknown';
      const actualQty = roundedQty;

      this.state.positions[normSymbol] = {
        symbol: normSymbol,
        entryPrice: price,
        peakPrice: price,
        quantity: actualQty,
        spent: quoteAmount,
        openedAt: new Date(at).toISOString(),
        targetReached: false,
        orderId
      };

      const trade = {
        action: 'BUY', symbol: normSymbol, at: new Date(at).toISOString(), price,
        idr: quoteAmount, quantity: actualQty, fee,
        signal: 'MOMENTUM_UP', changePct, outlook,
        orderId
      };
      this.state.ledger.push(trade);
      this.persist();
      await this.logOrder({ event: 'order_created', side: 'BUY', symbol: normSymbol, quoteAmount, quantity: actualQty, price, fee, orderId });
      await this.sendAlert(`🟢 LIVE BELI ${normSymbol}/IDR\nHarga: Rp${price.toLocaleString('id-ID')}\nJumlah: Rp${quoteAmount.toLocaleString('id-ID')} (fee ${fee})\nQty: ${actualQty.toLocaleString('id-ID')}\nOrder: ${orderId}`);

      return { action: 'BUY', trade };
    } catch (error) {
      const isAmbiguous = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'EPIPE' || Number(error?.status) >= 500;
      if (isAmbiguous && this.orderControl) {
        this.orderControl.markUncertain({ side: 'BUY', symbol: normSymbol, quoteAmount, price, error: error.message, at: new Date().toISOString() });
      }
      await this.logFail({ symbol: normSymbol, side: 'BUY', reason: error.message, price, quoteAmount, ambiguous: isAmbiguous });
      await this.sendAlert(`⚠️ ORDER BELI ${normSymbol} ERROR: ${error.message}${isAmbiguous ? '\n\n⚠️ STATUS TIDAK PASTI - Cek Indodax manual, lalu /resolveorder' : ''}`);
      return { action: null, reason: error.message };
    }
  }

  async executeSell(symbol, position, price, signal, profitPct, drawdownPct, outlook, at) {
    // Normalize symbol to Indodax V2 format (UPPERCASE, no separator, must end with IDR)
    let normSymbol = String(symbol).replace(/[_-]/g, '').toUpperCase();
    if (!normSymbol.endsWith('IDR')) {
      normSymbol = normSymbol + 'IDR';
    }

    const balanceCheck = await this.checkBalance('SELL', normSymbol, price);
    if (!balanceCheck.ok) {
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason: balanceCheck.reason, price, quantity: position.quantity });
      await this.sendAlert(`⚠️ JUAL ${normSymbol} GAGAL: ${balanceCheck.reason}`);
      return { action: null, reason: balanceCheck.reason };
    }

    if (this.orderControl?.state?.paused) {
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason: this.orderControl.state.reason, price });
      return { action: null, reason: this.orderControl.state.reason };
    }
    if (this.orderControl?.state?.uncertain) {
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason: 'Ada order TIDAK PASTI', price });
      return { action: null, reason: 'Ada order TIDAK PASTI yang perlu direkonsiliasi' };
    }

    const quantity = position.quantity;
    const pairInfo = await this.getPairInfo(normSymbol);
    const increment = Number(pairInfo?.quantity_increment);
    const minQty = Number(pairInfo?.trade_min_traded_currency);
    const roundedQty = this.roundQuantity(quantity, increment);

    if (roundedQty < minQty) {
      const reason = `Quantity ${roundedQty} < minimum pair ${minQty}`;
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason, price, quantity: roundedQty });
      return { action: null, reason };
    }

    const reviewedPrice = price;
    try {
      validateOrderAmount({
        side: 'SELL',
        amount: roundedQty,
        available: balanceCheck.available,
        maxIdr: MIN_NOTIONAL_IDR,
        pair: pairInfo,
        price,
        reviewedPrice,
        maxDeviationPct: this.maxDeviationPct
      });
    } catch (error) {
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason: error.message, price, quantity: roundedQty });
      return { action: null, reason: error.message };
    }

    try {
      const result = await this.api.createOrder({ symbol: normSymbol, side: 'SELL', quantity: roundedQty });
      const orderId = result?.orderId ?? result?.data?.orderId ?? result?.data?.order_id ?? 'unknown';
      const proceeds = Math.floor(roundedQty * price);
      const fee = Math.floor(proceeds * FEE_RATE);
      const net = proceeds - fee;
      const realizedPnl = net - position.spent;

      this.state.cash += net;
      this.state.cooldownUntil[normSymbol] = at + this.cooldownMs;
      delete this.state.positions[normSymbol];

      const trade = { action: 'SELL', symbol: normSymbol, at: new Date(at).toISOString(), price, idr: proceeds, quantity: roundedQty, signal, drawdownPct, profitPct, outlook, entryPrice: position.entryPrice, peakPrice: position.peakPrice, realizedPnl, fee, orderId };
      this.state.ledger.push(trade);
      this.persist();
      await this.logOrder({ event: 'order_created', side: 'SELL', symbol: normSymbol, quantity: roundedQty, price, proceeds, fee, realizedPnl, orderId });
      await this.sendAlert(`🔴 LIVE JUAL ${normSymbol}/IDR\nHarga: Rp${price.toLocaleString('id-ID')}\nP/L: ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}% (${realizedPnl >= 0 ? '+' : ''}Rp${Math.abs(realizedPnl).toLocaleString('id-ID')})\nPemicu: ${signal}\nOrder: ${orderId}`);

      return { action: 'SELL', trade };
    } catch (error) {
      const isAmbiguous = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'EPIPE' || Number(error?.status) >= 500;
      if (isAmbiguous && this.orderControl) {
        this.orderControl.markUncertain({ side: 'SELL', symbol: normSymbol, quantity: roundedQty, price, error: error.message, at: new Date().toISOString() });
      }
      await this.logFail({ symbol: normSymbol, side: 'SELL', reason: error.message, price, quantity: roundedQty, ambiguous: isAmbiguous });
      await this.sendAlert(`⚠️ ORDER JUAL ${normSymbol} ERROR: ${error.message}${isAmbiguous ? '\n\n⚠️ STATUS TIDAK PASTI - Cek Indodax manual, lalu /resolveorder' : ''}`);
      return { action: null, reason: error.message };
    }
  }

  update({ symbol, price, changePct, trendConfirmed = false, outlook = 'BELUM CUKUP DATA', at = Date.now() }) {
    symbol = String(symbol ?? '').toLowerCase();
    if (!symbol || !(Number.isFinite(price) && price > 0)) return { action: null, reason: 'Simbol atau harga tidak valid.' };

    const position = this.state.positions[symbol];
    if (position) {
      position.peakPrice = Math.max(position.peakPrice, price);
      const profitPct = ((price - position.entryPrice) / position.entryPrice) * 100;
      const targetReached = position.targetReached || profitPct >= TARGET_PROFIT_PCT;
      position.targetReached = targetReached;
      const drawdownPct = ((price - position.peakPrice) / position.peakPrice) * 100;

      const stopTriggered = targetReached
        ? drawdownPct <= -TRAILING_STOP_PCT
        : profitPct <= -STOP_LOSS_PCT && outlook !== 'CENDERUNG NAIK';
      const outlookExit = targetReached && outlook !== 'CENDERUNG NAIK';

      if (stopTriggered || outlookExit) {
        const signal = stopTriggered
          ? targetReached ? 'TRAILING_STOP' : 'ENTRY_STOP'
          : outlook === 'NETRAL / SIDEWAYS' ? 'OUTLOOK_NEUTRAL' : 'OUTLOOK_TURNED_DOWN';

        if (targetReached && outlook === 'CENDERUNG NAIK' && stopTriggered) {
          this.persist();
          return { action: null, reason: 'Trailing stop 5% tercapai, tetapi outlook masih naik; posisi ditahan.' };
        }
        return this.executeSell(symbol, position, price, signal, profitPct, drawdownPct, outlook, at);
      }
      this.persist();
      return { action: null, reason: targetReached ? 'Target 1% tercapai; posisi ditahan karena outlook masih naik, dengan trailing stop 5%.' : 'Posisi dipantau; target profit 1% atau stop rugi 5% belum tercapai.' };
    }

    if (!(Number.isFinite(changePct) && changePct >= 1) || trendConfirmed !== true || at < (this.state.cooldownUntil[symbol] ?? 0) || !(this.state.cash > 0)) {
      return { action: null, reason: 'Momentum atau konfirmasi tren belum cukup, masih cooldown, atau kas simulasi habis.' };
    }

    return this.executeBuy(symbol, price, changePct, outlook, at);
  }

  async report(prices = {}) {
    let realCash = this.state.cash;
    try {
      const account = await this.api.getInfo();
      const balances = Array.isArray(account?.balances) ? account.balances : [];
      const idrRow = balances.find(item => String(item?.asset).toUpperCase() === 'IDR');
      if (idrRow) realCash = Number(idrRow.free ?? 0);
    } catch (error) {
      console.error('[altcoin-live] Gagal ambil saldo real:', error.message);
    }

    const positions = Object.values(this.state.positions).map(position => {
      const price = Number(prices[position.symbol]);
      const markValue = Number.isFinite(price) && price > 0 ? Math.floor(position.quantity * price) : null;
      return { ...position, markValue, unrealizedPnl: markValue === null ? null : markValue - position.spent };
    });
    const markedValue = positions.reduce((total, position) => total + (position.markValue ?? position.spent), 0);
    const equity = realCash + markedValue;
    const closed = this.state.ledger.filter(item => item.action === 'SELL');
    const wins = closed.filter(item => item.realizedPnl > 0).length;
    const realizedPnl = closed.reduce((sum, t) => sum + (Number(t.realizedPnl) || 0), 0);
    const unrealizedPnl = positions.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0);
    const totalPnl = realizedPnl + unrealizedPnl;
    return { startingCash: this.startingCash, cash: realCash, positions, equity, pnl: totalPnl, realizedPnl, unrealizedPnl, closedTrades: closed.length, profitTrades: wins, winRate: closed.length ? wins / closed.length : null, ledger: this.state.ledger };
  }
}

export function loadLiveAltcoinTracker({ file, startingCash = 31000, fraction = 0.25, stopDropPct = 5, api, orderControl, auditFile, maxDeviationPct, getMarketPrice, sendAlert } = {}) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { }
      throw error;
    }
  };
  return new LiveAltcoinTracker({ startingCash, fraction, stopDropPct, state, save, api, orderControl, auditFile, maxDeviationPct, getMarketPrice, sendAlert });
}

export function formatLiveAltcoinTrade(trade) {
  const price = Number(trade.price).toLocaleString('id-ID', { maximumSignificantDigits: 12 });
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;

  if (trade.action === 'BUY') {
    return [
      `🟢 LIVE BELI ${trade.symbol.toUpperCase()}/IDR`,
      `├─ Harga: Rp${price}`,
      `├─ Jumlah: ${money(trade.idr)} (fee ${money(trade.fee)})`,
      `├─ Qty: ${trade.quantity.toLocaleString('id-ID')}`,
      `├─ Signal: +${trade.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
      `├─ Outlook: ${trade.outlook ?? 'CENDERUNG NAIK'}`,
      `└─ Order: ${trade.orderId}`,
      '',
      'Live trading — order real di Indodax',
    ].join('\n');
  }

  return [
    `🔴 LIVE JUAL ${trade.symbol.toUpperCase()}/IDR`,
    `├─ Harga jual: Rp${price}`,
    `├─ Hasil vs entry: ${(trade.profitPct ?? 0) >= 0 ? '+' : ''}${(trade.profitPct ?? 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
    `├─ Pemicu: ${{ ENTRY_STOP: 'turun 5% dari entry', TRAILING_STOP: 'turun 5% dari puncak', OUTLOOK_NEUTRAL: 'outlook menjadi netral', OUTLOOK_TURNED_DOWN: 'outlook berbalik turun' }[trade.signal] ?? trade.signal}`,
    `└─ P/L live: ${trade.realizedPnl >= 0 ? '+' : '-'}${money(Math.abs(trade.realizedPnl))}`,
    '',
    'Live trading — order real di Indodax',
  ].join('\n');
}

export function formatLiveAltcoinReport(report) {
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;
  const lines = ['📊 LIVE ALTCOIN TRADING', `Kas: ${money(report.cash)}`, `Ekuitas: ${money(report.equity)}`, `P/L: ${report.pnl >= 0 ? '+' : '-'}${money(Math.abs(report.pnl))}`, `Posisi terbuka: ${report.positions.length}`];
  for (const position of report.positions) {
    const pnl = position.unrealizedPnl === null ? 'harga belum tersedia' : `${position.unrealizedPnl >= 0 ? '+' : '-'}${money(Math.abs(position.unrealizedPnl))}`;
    lines.push(`• ${position.symbol.toUpperCase()}/IDR — entry ${money(position.entryPrice)}, puncak ${money(position.peakPrice)}, nilai ${position.markValue === null ? '—' : money(position.markValue)}, P/L ${pnl}`);
  }
  if (report.closedTrades > 0) {
    const winningTrades = report.profitTrades;
    const losingTrades = report.closedTrades - winningTrades;
    const winRatePct = ((report.profitTrades / report.closedTrades) * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 });
    lines.push(
      `Transaksi tertutup: ${report.closedTrades}`,
      `Winning: ${winningTrades} (${winRatePct}%)`,
      `Losing: ${losingTrades} (${((losingTrades / report.closedTrades) * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%)`,
      `Overall P/L: ${report.pnl >= 0 ? '+' : '-'}${Math.abs(report.pnl).toLocaleString('id-ID', { maximumFractionDigits: 0 })} IDR`
    );
  } else {
    lines.push('Transaksi tertutup: 0 — belum ada trade yang selesai');
  }
  lines.push('', 'Aturan: beli fixed Rp13.000 saat momentum ≥1%/15m + 3 sampel naik beruntun. Target +1%; trailing stop 5% dari puncak. Stop rugi 5% jika outlook ≠ naik. Jeda 15 menit per symbol. Fee 0.1%.', 'ORDER REAL DI INDODAX — Dicatat di logs/altcoin-orders.jsonl & altcoin-order-fail.jsonl');
  return lines.join('\n');
}