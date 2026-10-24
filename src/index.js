import 'dotenv/config';
import express from 'express';
import { Bot } from 'grammy';
import WebSocket from 'ws';
import { calculateSignal } from './signals.js';
import { nextMovementAlert, percentChange } from './position.js';
import { marketOutlook } from './prediction.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'position.json');
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
  const text = `BTC/IDR — PERGERAKAN ${direction} ${Math.abs(tier) * movementStep}% dari harga beli manual\\nHarga beli: Rp${position.entryPrice.toLocaleString('id-ID')}\\nHarga sekarang: Rp${price.toLocaleString('id-ID')}\\nPerubahan: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%\\n\\nIni notifikasi perubahan, bukan rekomendasi. Pilih tindakan manual:`;
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
const threshold = Number(process.env.SIGNAL_THRESHOLD_PCT || 1);
const cooldownMs = Number(process.env.ALERT_COOLDOWN_MINUTES || 60) * 60_000;
const intervalMs = Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS || 30)) * 1000;
const history = [];
let latest = null;
let lastAlertAt = 0;
let ws = null;
let wsRetry = null;
let bot = null;
let lastWsMessageAt = null;

app.get('/health', (_req, res) => res.json({ ok: true, pair: 'BTC/IDR', latest, websocketConnected: ws?.readyState === WebSocket.OPEN, lastWsMessageAt }));
app.listen(port, '127.0.0.1', () => console.log(`Health endpoint on 127.0.0.1:${port}/health`));

async function sendTelegram(text, keyboard) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) return;
  try { await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}); }
  catch (error) { console.error('Telegram send failed:', error.message); }
}

function processPrice(price, source) {
  if (!Number.isFinite(price) || price <= 0) return;
  watchPosition(price);
  const now = Date.now();
  latest = { pair: 'BTC/IDR', price, source, observedAt: new Date(now).toISOString() };
  history.push({ price, at: now });
  while (history.length > 60) history.shift();
  const windowHistory = history.filter(x => now - x.at <= 15 * 60_000);
  const signal = calculateSignal(windowHistory, threshold);
  if (signal.type !== 'WAIT' && signal.type !== 'HOLD' && now - lastAlertAt >= cooldownMs) {
    lastAlertAt = now;
    const action = signal.type === 'WATCH_BUY' ? 'BELI' : 'JUAL';
    sendTelegram(`BTC/IDR ${signal.type}\nHarga: Rp${price.toLocaleString('id-ID')}\n${signal.reason}\n\nIni hanya sinyal pantauan, bukan nasihat keuangan. Bot tidak membuat order.`, [[{ text: `Setujui ${action} (catat saja)`, callback_data: `proposal_${action.toLowerCase()}` }, { text: 'Abaikan', callback_data: 'proposal_ignore' }]]);
  }
}

function connectMarketSocket() {
  if (ws) { try { ws.terminate(); } catch {} }
  ws = new WebSocket('wss://ws3.indodax.com/ws/');
  ws.on('open', () => {
    console.log('Indodax market WebSocket connected');
    ws.send(JSON.stringify({ params: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo' }, id: 1 }));
    ws.send(JSON.stringify({ method: 1, params: { channel: 'market:trade-activity-btcidr' }, id: 2 }));
  });
  ws.on('message', raw => {
    lastWsMessageAt = new Date().toISOString();
    try {
      const msg = JSON.parse(raw.toString());
      const trades = msg?.result?.data?.data;
      if (Array.isArray(trades)) for (const trade of trades) if (String(trade[0]).trim().toLowerCase() === 'btcidr') processPrice(Number(trade[4]), 'websocket');
    } catch (error) { console.error('Invalid market WS message:', error.message); }
  });
  ws.on('error', error => console.error('Market WS error:', error.message));
  ws.on('close', () => { console.log('Market WS closed; reconnecting'); wsRetry = setTimeout(connectMarketSocket, 5000); });
}

async function pollTicker() {
  try {
    const response = await fetch('https://indodax.com/api/ticker/btcidr', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    processPrice(Number(json?.ticker?.last), 'rest');
  } catch (error) { console.error('Ticker poll failed:', error.message); }
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  bot.on('callback_query:data', async ctx => {
    if (String(ctx.callbackQuery.message?.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) return ctx.answerCallbackQuery({ text: 'Chat tidak diizinkan.' });
    const data = ctx.callbackQuery.data;
    let answer = 'Tombol tidak dikenali.';
    const match = data.match(/^pos_(sell|hold)_(-?[0-9]+)$/);
    if (match) answer = acknowledgePosition(match[2], match[1]);
    else if (data === 'proposal_ignore') answer = 'Sinyal diabaikan.';
    else if (data.startsWith('proposal_')) answer = 'Pilihan dicatat saja; bot ini tidak mengeksekusi transaksi.';
    await ctx.answerCallbackQuery({ text: answer });
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
    try { fs.unlinkSync(dataFile); } catch {}
    await ctx.reply('Pencatatan posisi ditutup. Gunakan /beli <harga_IDR> setelah pembelian manual berikutnya.');
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti atau nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
  });
  bot.command('status', async ctx => {
    if (String(ctx.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;
    const outlook = marketOutlook(history);
    const lines = ['📊 BTC/IDR — STATUS', latest ? `Harga terakhir: Rp${latest.price.toLocaleString('id-ID')}` : 'Harga terakhir: belum tersedia'];
    lines.push(`Koneksi market: ${ws?.readyState === WebSocket.OPEN ? 'tersambung' : 'terputus'}`);
    lines.push(position ? `Harga beli tercatat: Rp${position.entryPrice.toLocaleString('id-ID')}\nPerubahan dari entry: ${percentChange(position.entryPrice, latest?.price)?.toFixed(2) ?? '—'}%${pendingSell ? '\nStatus: menunggu penutupan posisi manual (/selesai)' : ''}` : 'Posisi: belum dicatat. Setelah beli manual, catat dengan /beli <harga_IDR>.');
    lines.push(`Arah pasar 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toFixed(2)}%)`}`);
    lines.push(`Dasar: ${outlook.reason}`, 'Catatan: ini indikasi sederhana dari perubahan harga terkini, bukan prediksi pasti ou nasihat keuangan.');
    await ctx.reply(lines.join('\n\n'));
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

 function trackPrice(price, source) {
  if (!Number.isFinite(price) || price <= 0) return;
  watchPosition(price);
  const now = Date.now();
  latest = { pair: 'BTC/IDR', price, source, observedAt: new Date(now).toISOString() };
  history.push({ price, at: now });
  while (history.length > 60) history.shift();
  const windowHistory = history.filter(x => now - x.at <= 15 * 60_000);
  const signal = calculateSignal(windowHistory, threshold);
  if (signal.type !== 'WAIT' && signal.type !== 'HOLD' && now - lastAlertAt >= cooldownMs) {
    lastAlertAt = now;
    const action = signal.type === 'WATCH_BUY' ? 'BELI' : 'JUAL';
    sendTelegram(`BTC/IDR ${signal.type}\nHarga: Rp${price.toLocaleString('id-ID')}\n${signal.reason}\n\nIni hanya sinyal pantauan, bukan nasihat keuangan. Bot tidak membuat order.`, [[{ text: `Setujui ${action} (catat saja)`, callback_data: `proposal_${action.toLowerCase()}` }, { text: 'Abaikan', callback_data: 'proposal_ignore' }]]);
  }
}

  bot.catch(error => console.error('Telegram bot error:', error.message));
  void bot.start().catch(error => console.error('Telegram polling error:', error.message));
}

connectMarketSocket();
void pollTicker();
const pollTimer = setInterval(() => void pollTicker(), intervalMs);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(pollTimer); clearTimeout(wsRetry); ws?.close(); bot?.stop(); process.exit(0);
});
