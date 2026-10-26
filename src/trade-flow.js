import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { percentageAmount } from './indodax.js';

const readControl = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { paused: false, reason: null, uncertain: null }; throw new Error('Status kontrol trading rusak; order diblokir.'); }
};
const writeControl = (file, state) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
};
const appendAudit = (file, event) => {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\\n`, { mode: 0o600 });
};
const isAmbiguous = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'EPIPE' || Number(error?.status) >= 500;
const plainDecimal = value => {
  if (!Number.isFinite(value) || value < 0) throw new Error('Jumlah order tidak valid.');
  return String(value).replace(/e([+-]?\\d+)/i, (_, exponent) => {
    const [whole, fraction = ''] = String(value).toLowerCase().split('e');
    const digits = whole.replace('.', '');
    const places = (whole.split('.')[1]?.length ?? 0) - Number(exponent);
    return places <= 0 ? digits + '0'.repeat(-places) : `${digits.slice(0, digits.length - places) || '0'}.${digits.slice(-places).padStart(places, '0')}`;
  });
};
const roundDown = (value, increment) => {
  const factor = 10 ** Math.max(0, (String(increment).split('.')[1] ?? '').length);
  const v = Math.floor(value * factor + 1e-9);
  const i = Math.round(Number(increment) * factor);
  return Math.floor(v / i) * i / factor;
};
const withinDeviation = (reviewPrice, currentPrice, maxPct) => Math.abs(currentPrice - reviewPrice) / reviewPrice * 100 <= maxPct;
export { plainDecimal, roundDown, withinDeviation };
export class OrderSafetyError extends Error { constructor(message, code = 'ORDER_BLOCKED') { super(message); this.code = code; } }

export class OrderControl {
  constructor({ file, auditFile = null }) { this.file = file; this.auditFile = auditFile; this.state = readControl(file); }
  pause(reason = 'Dijeda oleh pemilik') { this.state = { ...this.state, paused: true, reason }; writeControl(this.file, this.state); appendAudit(this.auditFile, { event: 'pause' }); }
  resume() { if (this.state.uncertain) throw new OrderSafetyError('Ada order TIDAK PASTI; rekonsiliasi dulu.'); this.state = { ...this.state, paused: false, reason: null }; writeControl(this.file, this.state); appendAudit(this.auditFile, { event: 'resume' }); }
  kill(reason = 'Kill switch diaktifkan') { this.state = { ...this.state, paused: true, reason }; writeControl(this.file, this.state); appendAudit(this.auditFile, { event: 'killswitch' }); }
  markUncertain(intent) { this.state = { ...this.state, paused: true, reason: 'Order TIDAK PASTI; rekonsiliasi diperlukan.', uncertain: intent }; writeControl(this.file, this.state); appendAudit(this.auditFile, { event: 'order_uncertain', intent }); }
  resolveUncertain() { this.state = { ...this.state, uncertain: null, paused: true, reason: 'Status diselesaikan manual; tetap jeda sampai /resume.' }; writeControl(this.file, this.state); appendAudit(this.auditFile, { event: 'order_resolved_manual' }); }
}

export function validateLiveConfig(env) {
  const maxIdr = Number(env.MAX_ORDER_IDR);
  const deviation = Number(env.MAX_PRICE_DEVIATION_PCT);
  return env.LIVE_TRADING_ENABLED === 'true' && Number.isSafeInteger(maxIdr) && maxIdr > 0 && Number.isFinite(deviation) && deviation > 0 && deviation <= 100;
}
export function validateOrderAmount({ side, amount, available, maxIdr, pair, price, reviewedPrice, maxDeviationPct }) {
  if (side === 'BUY' && amount > maxIdr) throw new OrderSafetyError('Melebihi MAX_ORDER_IDR.');
  if (amount > available) throw new OrderSafetyError('Jumlah melebihi saldo tersedia.');
  if (side === 'SELL') {
    const increment = Number(pair?.quantity_increment);
    const minimum = Number(pair?.trade_min_traded_currency);
    const rounded = roundDown(amount, increment);
    if (!(increment > 0) || rounded !== amount) throw new OrderSafetyError('Jumlah jual tidak sesuai presisi pair.');
    if (amount < minimum) throw new OrderSafetyError('Jumlah jual di bawah minimum pair.');
  } else {
    const minimum = Number(pair?.trade_min_base_currency);
    if (amount < minimum) throw new OrderSafetyError('Nominal beli di bawah minimum pair.');
  }
  if (!(price > 0) || !(reviewedPrice > 0) || !withinDeviation(reviewedPrice, price, maxDeviationPct)) throw new OrderSafetyError('Harga bergerak melewati batas; mulai ulang untuk tinjau ulang.');
  return amount;
}

export const newToken = () => crypto.randomUUID();
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
  constructor({ api, send, ownerId, now = Date.now, ttlMs = 120_000, liveEnabled = false, maxOrderIdr = 0, maxDeviationPct = 0, pairMetadata = null, control = null, auditFile = null, getMarketPrice = async () => null }) {
    if (!api || typeof send !== 'function' || !ownerId) throw new Error('Konfigurasi alur transaksi tidak lengkap.');
    this.api = api;
    this.send = send;
    this.ownerId = String(ownerId);
    this.now = now;
    this.ttlMs = ttlMs;
    this.liveEnabled = liveEnabled;
    this.maxOrderIdr = maxOrderIdr;
    this.maxDeviationPct = maxDeviationPct;
    this.pairMetadata = pairMetadata;
    this.control = control;
    this.auditFile = auditFile;
    this.getMarketPrice = getMarketPrice;
    this.pending = new Map();
  }

  async start(chatId, side) {
    if (String(chatId) !== this.ownerId) return;
    if (!this.liveEnabled || !Number.isSafeInteger(this.maxOrderIdr) || this.maxOrderIdr <= 0 || !Number.isFinite(this.maxDeviationPct) || this.maxDeviationPct <= 0) return 'Trading live dinonaktifkan; konfigurasi LIVE_TRADING_ENABLED, MAX_ORDER_IDR, dan MAX_PRICE_DEVIATION_PCT belum valid.';
    if (this.control?.state?.paused) return `Order diblokir: ${this.control.state.reason ?? 'trading dijeda'}.`;
    if (this.control?.state?.uncertain) return 'Order diblokir: ada order TIDAK PASTI yang perlu direkonsiliasi.';
    if (!['BUY', 'SELL'].includes(side)) throw new Error('Sisi transaksi tidak valid.');
    const account = await this.api.getInfo();
    if (account?.canTrade !== true) return 'Akun Indodax tidak mengizinkan trading; order diblokir.';
    const asset = side === 'BUY' ? 'IDR' : 'BTC';
    const available = balanceOf(account, asset);
    if (available <= 0) return this.send(chatId, `Saldo ${asset} tersedia kosong; transaksi dibatalkan.`);
    const token = newToken();
    const reviewedPrice = await this.getMarketPrice();
    if (!(reviewedPrice > 0)) return 'Harga pasar tidak tersedia; order diblokir.';
    const state = { side, asset, available, token, reviewedPrice, expiresAt: this.now() + this.ttlMs, stage: 'percent' };
    this.pending.set(String(chatId), state);
    appendAudit(this.auditFile, { event: 'intent_started', side, pair: 'BTCIDR', reviewedPrice });
    const keyboard = [pctButtons.map(percent => ({ text: `${percent}%`, callback_data: `trade_pct:${token}:${percent}` }))];
    return this.send(chatId, `${side === 'BUY' ? '🟢 BELI' : '🔴 JUAL'} BTC/IDR\nSaldo tersedia: ${fmt(available, asset)} ${asset}\nPilih persentase saldo tersedia yang akan digunakan:`, keyboard);
  }

  async choosePercent(chatId, token, percent) {
    if (String(chatId) !== this.ownerId) return 'Chat tidak diizinkan.';
    const state = this.pending.get(String(chatId));
    if (!state || state.stage !== 'percent' || state.token !== token || state.expiresAt < this.now()) { this.pending.delete(String(chatId)); return 'Pilihan transaksi tidak berlaku. Mulai lagi.'; }
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
      if (current !== state.available) return 'Saldo tersedia berubah sejak ringkasan; order dibatalkan. Mulai lagi.';
      const amount = percentageAmount(current, state.percent);
      if (!Number.isFinite(amount) || amount <= 0 || amount > current) return 'Saldo tersedia berubah; order dibatalkan. Mulai lagi.';
      const currentPrice = await this.getMarketPrice();
      validateOrderAmount({ side: state.side, amount, available: current, maxIdr: this.maxOrderIdr, pair: this.pairMetadata, price: currentPrice, reviewedPrice: state.reviewedPrice, maxDeviationPct: this.maxDeviationPct });
      const result = state.side === 'BUY' ? await this.api.createOrder({ side: 'BUY', quoteAmount: amount }) : await this.api.createOrder({ side: 'SELL', quantity: amount });
      const orderId = result?.orderId ?? result?.data?.orderId ?? result?.data?.order_id ?? 'diterima';
      appendAudit(this.auditFile, { event: 'order_created', side: state.side, amount, orderId });
      return `Order ${state.side} BTC/IDR telah dikirim. ID: ${orderId}. Periksa status order di Indodax.`;
    } catch (error) {
      if (isAmbiguous(error)) { this.control?.markUncertain({ side: state.side, amount, percent: state.percent, reviewedPrice: state.reviewedPrice, error: error.message, at: new Date().toISOString() }); return `⚠️ ORDER STATUS TIDAK PASTI: ${error.message}\\n\\nOrder mungkin sudah diterima atau belum. Cek Indodax sekarang. Jalankan /resolveorder setelah memastikan.`; }
      appendAudit(this.auditFile, { event: 'order_error', side: state.side, error: error.message });
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
