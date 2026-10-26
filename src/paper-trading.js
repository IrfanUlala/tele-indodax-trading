import fs from 'node:fs';
import path from 'node:path';

const FEE_RATE = 0.001; // 0.1% maker/taker (Indodax default)
const MIN_NOTIONAL_IDR = 10000; // Indodax minimum order

export class PaperTracker {
  constructor({ startingCash = 31000, fraction = 0.25, state = null, save = null, feeRate = FEE_RATE } = {}) {
    if (!(startingCash > 0) || !(fraction > 0 && fraction <= 1)) throw new Error('Invalid paper trading settings.');
    this.startingCash = startingCash;
    this.fraction = fraction;
    this.feeRate = feeRate;
    this.save = save;
    this.state = state ?? { cash: startingCash, position: null, ledger: [] };
    this.state.ledger ??= [];
  }

  persist() { this.save?.(this.state); }

  onSignal(signal, price, at = Date.now(), outlook = 'BELUM CUKUP DATA') {
    if (!Number.isFinite(price) || price <= 0) return { action: null, reason: 'Harga tidak valid.' };
    const position = this.state.position;
    if (position) {
      position.peakPrice = Math.max(position.peakPrice ?? position.entryPrice, price);
      const profitPct = ((price - position.entryPrice) / position.entryPrice) * 100;
      const targetReached = profitPct >= 1;
      const drawdownPct = ((price - position.peakPrice) / position.peakPrice) * 100;
      const stopTriggered = targetReached ? drawdownPct <= -1 : profitPct <= -1 && outlook !== 'CENDERUNG NAIK';
      const outlookExit = targetReached && outlook !== 'CENDERUNG NAIK';
      if (stopTriggered || (signal?.type === 'WATCH_SELL') || outlookExit) {
        const proceeds = Math.floor(position.btc * price);
        const fee = Math.floor(proceeds * this.feeRate);
        const net = proceeds - fee;
        const realizedPnl = net - position.spent;
        const signal_reason = stopTriggered ? targetReached ? 'TRAILING_STOP' : 'ENTRY_STOP' : signal?.type === 'WATCH_SELL' ? 'WATCH_SELL' : 'OUTLOOK_NOT_UP';
        const trade = { action: 'SELL', at: new Date(at).toISOString(), price, idr: proceeds, btc: position.btc, signal: signal_reason, changePct: signal.changePct ?? null, entryPrice: position.entryPrice, peakPrice: position.peakPrice, profitPct, drawdownPct: targetReached ? drawdownPct : null, fee, net, realizedPnl };
        this.state.cash += net;
        this.state.position = null;
        this.state.ledger.push(trade);
        this.persist();
        return { action: 'SELL', trade };
      }
    }
    if (signal?.type === 'WATCH_BUY' && !this.state.position && this.state.cash > 0) {
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
    const closed = this.state.ledger.filter(item => item.action === 'SELL');
    const wins = closed.filter(item => item.realizedPnl > 0).length;
    return { cash: this.state.cash, position, unrealized, equity, pnl: equity - this.startingCash, closedTrades: closed.length, wins, winRate: closed.length ? wins / closed.length * 100 : null, ledger: this.state.ledger };
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
  lines.push(`Nilai ekuitas simulasi: ${money(report.equity)}`, `Untung/rugi total simulasi: ${report.pnl >= 0 ? '+' : '-'}${money(Math.abs(report.pnl))}`, `Transaksi tertutup: ${report.closedTrades}`, `Akurasi transaksi tertutup: ${report.winRate === null ? 'belum ada hasil' : `${report.winRate.toLocaleString('id-ID', { maximumFractionDigits: 1 })}% (${report.wins}/${report.closedTrades} untung)`}`, `Harga terakhir: ${currentPrice ? money(currentPrice) : 'belum tersedia'}`, 'Simulasi saja; tidak ada dana atau order Indodax yang digunakan.');
  return lines.join('\n');
}
