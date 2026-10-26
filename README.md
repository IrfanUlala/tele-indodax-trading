# Coint Trading — BTC/IDR monitoring & paper trading

Node.js + Telegram bot untuk monitoring pasar BTC/IDR Indodax, paper trading otomatis altcoin, dan jalur order manual BTC (live, require explicit enable). WebSocket dengan REST fallback, semua data lokal.

**Paper trading:** Simulasi BTC/IDR entry +1% 15-menit naik, target +3%, hold saat outlook naik, jual saat netral/turun atau trailing 1%. Simulasi altcoin top-10 IDR volume, entry momentum +1%, target +3%, stop loss 1% sebelum target, trailing 1% setelah target.

**Live trading:** Manual `/buy` dan `/sell` BTC/IDR saja, konfirmasi 2x, MARKET order. Require `LIVE_TRADING_ENABLED=true`, `MAX_ORDER_IDR` > 0, `MAX_PRICE_DEVIATION_PCT` > 0. Default mati. Audit log di `logs/orders.jsonl`.

**Safety:** Timeout/network error → status TIDAK PASTI, cek Indodax manual. `/pause` `/resume` `/killswitch` `/resolveorder` milik owner. Tidak ada klaim profit; signals adalah heuristic.

## Setup

1. Install Node.js 20+ dan PM2. Dari folder ini: `npm install`.
2. Copy `.env.example` ke `.env`; isi Telegram bot token, chat ID, dan opsional Indodax API (paper trading tidak memerlukan). Jangan paste secret di chat atau commit `.env`.
3. Opsional: isi `LIVE_TRADING_ENABLED=true`, `MAX_ORDER_IDR=<nominal>`, `MAX_PRICE_DEVIATION_PCT=<%>` untuk enable live order.
4. `npm test` lalu `npm start`. Health: `curl http://127.0.0.1:3000/health`. Telegram: `/status`.

## PM2 autostart (Fedora/systemd)

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

PM2 cetak `sudo env PATH=... pm2 startup systemd ...`. Jalankan command itu, lalu `pm2 save`. Verifikasi `pm2 status` dan `pm2 logs coint-trading`.

Hentikan: `pm2 stop coint-trading` → `pm2 delete coint-trading` → `pm2 save`.

## Perintah Telegram

- `/status` — harga terbaru, saldo (jika live enable), tombol beli/jual.
- `/wallet` — saldo detail BTC/IDR dari akun Indodax (live trading saja).
- `/buy` — dialog order beli BTC/IDR manual, pilih %, konfirmasi, status order. Kirim order real jika live enable + batas valid.
- `/sell` — dialog order jual BTC/IDR manual.
- `/pause` — jeda order baru sampai `/resume`.
- `/resume` — lanjut order jika tidak ada order TIDAK PASTI.
- `/killswitch` — jeda permanen sampai restart atau `/resume`.
- `/resolveorder` — tandai order TIDAK PASTI telah dicek di Indodax.
- `/altcoins` — laporan top-10 IDR pairs, entry signals, posisi.

## Paper trading — data lokal

Posisi BTC: `data/position.json`. Posisi altcoin: `data/altcoin-paper.json`. Ledger: `data/paper-trades.jsonl`.

Simulasi tidak memakai API Indodax; fill di harga ticker lokal, fee & presisi sesuai dokumentasi Indodax, atomicity file.

## Live trading — safeguard

- Flag `LIVE_TRADING_ENABLED` default `false`.
- Batas `MAX_ORDER_IDR` dan `MAX_PRICE_DEVIATION_PCT` wajib > 0.
- Harga saat confirm harus dalam deviasi dari harga review di start.
- Presisi jumlah jual sesuai pair metadata.
- Token UUID callback /buy /sell; salah token → reset.
- Timeout/network → status TIDAK PASTI; `/resolveorder` setelah cek manual.
- Audit log semua event ke `logs/orders.jsonl`.

## API health (loopback only)

`GET /health` laporan BTC/IDR observasi terbaru, status socket, timestamp. Bukan auth endpoint; simpan lokal.

## Validasi & disclaimer

**Sebelum real trading:**
- Independen validasi API spec Indodax (presisi, minimum, fee, rate limit).
- Hitung slippage, spread, pajak, fee.
- Paper trading 30+ hari walk-forward.
- Jangan percaya signal atau backtest hasil; ini heuristic.
- Withdrawal boleh diaktifkan setelah order diverifikasi (optional).

Lihat [TRADING-RULES.md](TRADING-RULES.md) untuk detail aturan entry, exit, stop loss.
