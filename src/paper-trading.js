import fs from 'node:fs';
import path from 'node:path';

export class PaperTracker {
  constructor({ startingCash = 31000, fraction = 0.25, state = null, save = null } = {}) {
    if (!(startingCash > 0) || !(fraction > 0 && fraction <= 1)) throw new Error('Invalid paper trading settings.');
    this.startingCash = startingCash;
    this.fraction = fraction;
    this.save = save;
    this.state = state ?? { cash: startingCash, position: null, ledger: [] };
    this.state.ledger ??= [];
  }

  persist() { this.save?.(this.state); }

  onSignal(signal, price, at = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return { action: null, reason: 'Harga tidak valid.' };
    if (signal?.type === 'WATCH_BUY' && !this.state.position && this.state.cash > 0) {
      const spent = Math.floor(this.state.cash * this.fraction);
      const btc = spent / price;
      if (spent <= 0 || btc <= 0) return { action: null, reason: 'Saldo virtual tidak mencukupi.' };
      const trade = { action: 'BUY', at: new Date(at).toISOString(), price, idr: spent, btc, signal: signal.type, changePct: signal.changePct ?? null };
      this.state.cash -= spent;
      this.state.position = { entryPrice: price, btc, spent, openedAt: trade.at };
      this.state.ledger.push(trade);
      this.persist();
      return { action: 'BUY', trade };
    }
    if (signal?.type === 'WATCH_SELL' && this.state.position) {
      const position = this.state.position;
      const proceeds = Math.floor(position.btc * price);
      const realizedPnl = proceeds - position.spent;
      const trade = { action: 'SELL', at: new Date(at).toISOString(), price, idr: proceeds, btc: position.btc, signal: signal.type, changePct: signal.changePct ?? null, entryPrice: position.entryPrice, realizedPnl };
      this.state.cash += proceeds;
      this.state.position = null;
      this.state.ledger.push(trade);
      this.persist();
      return { action: 'SELL', trade };
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

export function loadPaperTracker({ file, startingCash = 31000, fraction = 0.25 } = {}) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  };
  return new PaperTracker({ startingCash, fraction, state, save });
}

export function formatPaperReport(report, currentPrice) {
  const money = value => `Rp${Math.floor(value).toLocaleString('id-ID')}`;
  const lines = ['🧪 PAPER TRADING BTC/IDR — SIMULASI', `Saldo virtual: ${money(report.cash)}`];
  if (report.position) lines.push(`Posisi simulasi: ${report.position.btc.toLocaleString('id-ID', { maximumFractionDigits: 8 })} BTC @ ${money(report.position.entryPrice)}`, `Perubahan belum terealisasi: ${report.unrealized >= 0 ? '+' : '-'}${money(Math.abs(report.unrealized))}`);
  else lines.push('Posisi simulasi: tidak ada');
  lines.push(`Nilai ekuitas simulasi: ${money(report.equity)}`, `Untung/rugi total simulasi: ${report.pnl >= 0 ? '+' : '-'}${money(Math.abs(report.pnl))}`, `Transaksi tertutup: ${report.closedTrades}`, `Akurasi transaksi tertutup: ${report.winRate === null ? 'belum ada hasil' : `${report.winRate.toLocaleString('id-ID', { maximumFractionDigits: 1 })}% (${report.wins}/${report.closedTrades} untung)`}`, `Harga terakhir: ${currentPrice ? money(currentPrice) : 'belum tersedia'}`, 'Simulasi saja; tidak ada dana atau order Indodax yang digunakan.');
  return lines.join('\n');
}
