import fs from 'node:fs';
import path from 'node:path';

export class AltcoinPaperTracker {
  constructor({ startingCash = 31000, fraction = 0.25, stopDropPct = 1, cooldownMs = 15 * 60_000, state = null, save = null } = {}) {
    if (!(startingCash > 0) || !(fraction > 0 && fraction <= 1) || !(stopDropPct > 0)) throw new Error('Invalid altcoin paper settings.');
    this.startingCash = startingCash;
    this.fraction = fraction;
    this.stopDropPct = stopDropPct;
    this.cooldownMs = cooldownMs;
    this.save = save;
    this.state = state ?? { cash: startingCash, positions: {}, ledger: [], cooldownUntil: {} };
    this.state.cooldownUntil ??= {};
    this.state.positions ??= {};
    this.state.ledger ??= [];
  }

  persist() { this.save?.(this.state); }

  update({ symbol, price, changePct, trendConfirmed = false, outlook = 'BELUM CUKUP DATA', at = Date.now() }) {
    symbol = String(symbol ?? '').toLowerCase();
    if (!symbol || !(Number.isFinite(price) && price > 0)) return { action: null, reason: 'Simbol atau harga tidak valid.' };
    const position = this.state.positions[symbol];
    if (position) {
      position.peakPrice = Math.max(position.peakPrice, price);
      const profitPct = ((price - position.entryPrice) / position.entryPrice) * 100;
      const targetReached = position.targetReached || profitPct >= 1;
      position.targetReached = targetReached;
      const drawdownPct = ((price - position.peakPrice) / position.peakPrice) * 100;
      const stopTriggered = targetReached ? drawdownPct <= -this.stopDropPct : profitPct <= -this.stopDropPct && outlook !== 'CENDERUNG NAIK';
      const outlookExit = targetReached && outlook !== 'CENDERUNG NAIK';
      if (stopTriggered || outlookExit) {
        const proceeds = Math.floor(position.quantity * price);
        const realizedPnl = proceeds - position.spent;
        const signal = stopTriggered ? targetReached ? 'TRAILING_STOP' : 'ENTRY_STOP' : outlook === 'NETRAL / SIDEWAYS' ? 'OUTLOOK_NEUTRAL' : 'OUTLOOK_TURNED_DOWN';
        if (targetReached && outlook === 'CENDERUNG NAIK' && stopTriggered) {
          this.persist();
          return { action: null, reason: 'Trailing stop 1% tercapai, tetapi outlook masih naik; posisi ditahan.' };
        }
        const trade = { action: 'SELL', symbol, at: new Date(at).toISOString(), price, idr: proceeds, quantity: position.quantity, signal, drawdownPct, profitPct, outlook, entryPrice: position.entryPrice, peakPrice: position.peakPrice, realizedPnl };
        this.state.cash += proceeds;
        this.state.cooldownUntil[symbol] = at + this.cooldownMs;
        delete this.state.positions[symbol];
        this.state.ledger.push(trade);
        this.persist();
        return { action: 'SELL', trade };
      }
      this.persist();
      return { action: null, reason: targetReached ? 'Target 3% tercapai; posisi ditahan karena outlook masih naik, dengan trailing stop 1%.' : 'Posisi dipantau; target profit 3% atau stop rugi 1% belum tercapai.' };
    }
    if (!(Number.isFinite(changePct) && changePct >= 1) || trendConfirmed !== true || at < (this.state.cooldownUntil[symbol] ?? 0) || !(this.state.cash > 0)) return { action: null, reason: 'Momentum atau konfirmasi tren belum cukup, masih cooldown, atau kas simulasi habis.' };
    const spent = Math.floor(this.state.cash * this.fraction);
    const quantity = spent / price;
    if (!(spent > 0 && quantity > 0)) return { action: null, reason: 'Saldo virtual tidak mencukupi.' };
    const trade = { action: 'BUY', symbol, at: new Date(at).toISOString(), price, idr: spent, quantity, signal: 'MOMENTUM_UP', changePct };
    this.state.cash -= spent;
    this.state.positions[symbol] = { symbol, entryPrice: price, peakPrice: price, quantity, spent, openedAt: trade.at };
    this.state.ledger.push(trade);
    this.persist();
    return { action: 'BUY', trade };
  }

  report(prices = {}) {
    const positions = Object.values(this.state.positions).map(position => {
      const price = Number(prices[position.symbol]);
      const markValue = Number.isFinite(price) && price > 0 ? Math.floor(position.quantity * price) : null;
      return { ...position, markValue, unrealizedPnl: markValue === null ? null : markValue - position.spent };
    });
    const markedValue = positions.reduce((total, position) => total + (position.markValue ?? position.spent), 0);
    const equity = this.state.cash + markedValue;
    const closed = this.state.ledger.filter(item => item.action === 'SELL');
    const wins = closed.filter(item => item.realizedPnl > 0).length;
    return { startingCash: this.startingCash, cash: this.state.cash, positions, equity, pnl: equity - this.startingCash, closedTrades: closed.length, wins, winRate: closed.length ? wins / closed.length * 100 : null, ledger: this.state.ledger };
  }
}

export function loadAltcoinPaperTracker({ file, startingCash = 31000, fraction = 0.25, stopDropPct = 1 } = {}) {
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
  return new AltcoinPaperTracker({ startingCash, fraction, stopDropPct, state, save });
}

export function formatAltcoinPaperTrade(trade) {
  const price = Number(trade.price).toLocaleString('id-ID', { maximumSignificantDigits: 12 });
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;
  if (trade.action === 'BUY') return [
    `🧪 *PAPER BELI — ${trade.symbol.toUpperCase()}/IDR*`,
    '',
    `Harga: *Rp${price}*`,
    `Modal simulasi: ${money(trade.idr)}`,
    `Momentum 15 menit: +${trade.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
    '',
    'Simulasi saja — tidak ada order nyata.',
    'Laporan lengkap: /paper',
  ].join('\n');
  return [
    `🧪 *PAPER JUAL — ${trade.symbol.toUpperCase()}/IDR*`,
    '',
    `Harga jual: *Rp${price}*`,
    `Hasil vs entry: ${(trade.profitPct ?? 0) >= 0 ? '+' : ''}${(trade.profitPct ?? 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
    `Pemicu jual: ${{ ENTRY_STOP: 'turun 1% dari entry', TRAILING_STOP: 'turun 1% dari puncak', OUTLOOK_NEUTRAL: 'outlook menjadi netral', OUTLOOK_TURNED_DOWN: 'outlook berbalik turun' }[trade.signal] ?? trade.signal}`,
    `P/L simulasi: ${trade.realizedPnl >= 0 ? '+' : '-'}${money(Math.abs(trade.realizedPnl))}`,
    '',
    'Simulasi saja — tidak ada order nyata.',
    'Laporan lengkap: /paper',
  ].join('\n');
}

export function formatAltcoinPaperReport(report) {
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;
  const lines = ['🧪 *PAPER TRADING ALTCOIN — SIMULASI TERPISAH*', `Modal awal: ${money(report.startingCash)}`, `Kas virtual: ${money(report.cash)}`, `Ekuitas simulasi: ${money(report.equity)}`, `Untung/rugi simulasi: ${report.pnl >= 0 ? '+' : '-'}${money(Math.abs(report.pnl))}`, `Posisi terbuka: ${report.positions.length}`];
  for (const position of report.positions) {
    const pnl = position.unrealizedPnl === null ? 'harga belum tersedia' : `${position.unrealizedPnl >= 0 ? '+' : '-'}${money(Math.abs(position.unrealizedPnl))}`;
    lines.push(`• *${position.symbol.toUpperCase()}/IDR* — entry ${money(position.entryPrice)}, puncak ${money(position.peakPrice)}, nilai ${position.markValue === null ? '—' : money(position.markValue)}, P/L ${pnl}`);
  }
  lines.push(`Transaksi tertutup: ${report.closedTrades}`, `Rasio untung: ${report.winRate === null ? 'belum ada hasil' : `${report.winRate.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`}`, 'Aturan: beli setelah momentum ≥1%/15 menit + 3 sampel naik. Target awal +3%; sebelum itu stop rugi 1% dari entry. Setelah target, tahan selama outlook naik; jual saat netral/turun atau trailing stop 1% dari puncak. Jeda 15 menit setelah jual.', 'Simulasi saja—tidak memakai saldo atau order Indodax.');
  return lines.join('\n');
}
