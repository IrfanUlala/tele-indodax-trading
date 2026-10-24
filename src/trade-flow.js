import { percentageAmount } from './indodax.js';

const pctButtons = [25, 50, 75, 100];
const balanceOf = (account, asset) => {
  if (!Array.isArray(account?.balances)) throw new Error('Format saldo akun Indodax tidak dikenali.');
  const row = account.balances.find(item => String(item?.asset).toUpperCase() === asset);
  const free = Number(row?.free ?? 0);
  if (!Number.isFinite(free) || free < 0) throw new Error('Saldo tersedia tidak valid.');
  return free;
};
const fmt = (n, asset) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: asset === 'BTC' ? 8 : 0 }).format(n);

export class TradeFlow {
  constructor({ api, send, ownerId, now = Date.now, ttlMs = 120_000 }) {
    if (!api || typeof send !== 'function' || !ownerId) throw new Error('Konfigurasi alur transaksi tidak lengkap.');
    this.api = api;
    this.send = send;
    this.ownerId = String(ownerId);
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  async start(chatId, side) {
    if (String(chatId) !== this.ownerId) return;
    if (!['BUY', 'SELL'].includes(side)) throw new Error('Sisi transaksi tidak valid.');
    const account = await this.api.getInfo();
    const asset = side === 'BUY' ? 'IDR' : 'BTC';
    const available = balanceOf(account, asset);
    if (available <= 0) return this.send(chatId, `Saldo ${asset} tersedia kosong; transaksi dibatalkan.`);
    const token = `${this.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.pending.set(String(chatId), { side, asset, available, token, expiresAt: this.now() + this.ttlMs, stage: 'percent' });
    const keyboard = [pctButtons.map(percent => ({ text: `${percent}%`, callback_data: `trade_pct:${token}:${percent}` }))];
    return this.send(chatId, `${side === 'BUY' ? '🟢 BELI' : '🔴 JUAL'} BTC/IDR\nSaldo tersedia: ${fmt(available, asset)} ${asset}\nPilih persentase saldo tersedia yang akan digunakan:`, keyboard);
  }

  async choosePercent(chatId, percent) {
    if (String(chatId) !== this.ownerId) return;
    const state = this.pending.get(String(chatId));
    if (!state || state.stage !== 'percent' || state.expiresAt < this.now()) { this.pending.delete(String(chatId)); return 'Pilihan transaksi tidak berlaku. Mulai lagi.'; }
    if (!pctButtons.includes(Number(percent))) return 'Pilih hanya 25%, 50%, 75%, atau 100%.';
    state.percent = Number(percent);
    state.amount = percentageAmount(state.available, state.percent);
    state.stage = 'confirm';
    state.expiresAt = this.now() + this.ttlMs;
    const amount = state.asset === 'IDR' ? `Rp${fmt(state.amount, 'IDR')}` : `${fmt(state.amount, 'BTC')} BTC`;
    const text = `⚠️ KONFIRMASI ORDER MARKET\nSisi: ${state.side}\nPair: BTC/IDR\nPersentase: ${state.percent}% saldo tersedia\nJumlah: ${amount}\n\nOrder market dapat tereksekusi segera dan harga akhir dapat berubah. Konfirmasi hanya berlaku sekali selama 2 menit.`;
    const keyboard = [[{ text: '✅ KONFIRMASI KIRIM ORDER', callback_data: `trade_confirm:${state.token}` }, { text: '✖️ BATAL', callback_data: `trade_cancel:${state.token}` }]];
    await this.send(chatId, text, keyboard);
    return text;
  }

  async confirm(chatId, token) {
    if (String(chatId) !== this.ownerId) return 'Chat tidak diizinkan.';
    const key = String(chatId);
    const state = this.pending.get(key);
    if (!state || state.stage !== 'confirm' || state.token !== token) return 'Konfirmasi tidak berlaku atau sudah digunakan.';
    this.pending.delete(key);
    if (state.expiresAt < this.now()) return 'Konfirmasi kedaluwarsa; tidak ada order dikirim.';
    try {
      const account = await this.api.getInfo();
      const current = balanceOf(account, state.asset);
      if (current !== state.available) return 'Saldo tersedia berubah sejak ringkasan; order dibatalkan. Mulai lagi untuk melihat jumlah terbaru.';
      const amount = percentageAmount(current, state.percent);
      if (!Number.isFinite(amount) || amount <= 0 || amount > current) return 'Saldo tersedia berubah; order dibatalkan. Mulai lagi.';
      const result = state.side === 'BUY'
        ? await this.api.createOrder({ side: 'BUY', quoteAmount: amount })
        : await this.api.createOrder({ side: 'SELL', quantity: amount });
      const orderId = result?.orderId ?? result?.data?.orderId ?? result?.data?.order_id ?? 'diterima';
      return `Order ${state.side} BTC/IDR telah dikirim. ID: ${orderId}. Periksa status order di Indodax.`;
    } catch (error) {
      return `Order gagal dikirim: ${error.message}`;
    }
  }

  cancel(chatId, token) {
    if (String(chatId) !== this.ownerId) return 'Chat tidak diizinkan.';
    const state = this.pending.get(String(chatId));
    if (!state || state.token !== token) return 'Pilihan transaksi tidak berlaku.';
    this.pending.delete(String(chatId));
    return 'Transaksi dibatalkan. Tidak ada order dikirim.';
  }
}
