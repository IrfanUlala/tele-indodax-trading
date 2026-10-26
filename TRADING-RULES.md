# Trading rules dan risk policy

General risk guidance, bukan saran keuangan personal. Crypto volatile; kerugian bisa melebihi ekspektasi. Mulai dengan monitor & paper trading saja. Project ini punya live trading manual BTC/IDR dengan safeguard eksplisit.

## Aturan operasional

1. **Satu asset:** BTC/IDR (`btcidr`) saja. Paper altcoin IDR pairs top-10 volume (simulasi, no real order).
2. **Keputusan manual:** live order `/buy` `/sell` butuh 2x konfirmasi (review + callback). Paper trading otomatis, hanya alert.
3. **Paper test dulu:** record entry/exit, fee, spread, slippage. Validasi 30+ hari walk-forward sebelum real trading.
4. **Risiko terukur:** tentukan max portfolio % dan max loss per trade. Jangan leverage, jangan rescue dengan average down.
5. **Entry/exit predefine:** dokumentasikan alasan, stop level, target, horizon, max loss. Jangan ubah stop setelah entry.
6. **Hitung biaya:** fee maker/taker, bid/ask, slippage, minimum order, presisi Indodax. Gross gain bukan net gain.
7. **Sinyal berkualitas:** short-window % bukan prediktif. Validasi independen; tolak harga stale/missing/abnormal.
8. **Cooldown & rate limit:** altcoin cooldown 15 menit (simulasi); live BTC manual (no auto-repeat). Hormat exchange limit.
9. **Credential aman:** API key trading-only, withdrawal disabled. `.env` mode 0600, jangan commit/log, rotate if exposed.
10. **Fail closed:** data outage/error → pause & alert, jangan infer order. Timeout/network → status TIDAK PASTI.
11. **Rekonsiliasi manual:** verifikasi balance & order di exchange official. Bot ack bukan bukti executed.
12. **Kill switch:** `/pause` `/killswitch` milik owner. `pm2 stop` backup. Inspect log setelah reboot.

## Entry & exit rules

### BTC/IDR live manual
- **Entry:** `/buy`, pilih 25%/50%/75%/100% saldo IDR tersedia, review harga, konfirmasi callback (TTL 2 min). MARKET order, real order sent.
- **Exit:** `/sell`, pilih persentase holding BTC, review, konfirmasi (TTL 2 min). MARKET order.
- **Safeguard:** harga saat confirm harus dalam ±5% (configurable `MAX_PRICE_DEVIATION_PCT`) dari harga di start. Nominal max `MAX_ORDER_IDR`. Timeout/network → TIDAK PASTI, user cek manual `/resolveorder`.
- **Limit:** non-repeating manual order saja; tidak ada otomatis buy/sell.

### BTC/IDR paper trading
- **Signal:** 15-min rolling, jika latest ≥ oldest + 0.5% (`SIGNAL_THRESHOLD_PCT`) naik 3x beruntun → WATCH_BUY. Turun 3x → WATCH_SELL. Cooldown 15 menit per pair.
- **Entry:** WATCH_BUY + 3 sample beruntun naik → buy 25% cash simulasi. Record entry price, timestamp.
- **Hold naik:** jika market outlook NAIK (3+ sample terbaru naik), tahan. Jangan jual sampai outlook ≠ NAIK.
- **Exit 1:** outlook NETRAL/TURUN sebelum +1% → jual 100%.
- **Exit 2:** setelah +1% target reached, hold sampai outlook NAIK. Saat NETRAL/TURUN atau trailing 1% dari peak → jual.
- **Stop loss:** sebelum +1%, jika outlook ≠ NAIK dan loss 1% dari entry → jual.
- **Cooldown:** 15 menit antarorder untuk pair yang sama.

### Altcoin IDR paper (top-10 volume)
- **Entry:** 15-min rolling, entry ≥ 0.5% + 3 sample naik → buy 25% cash (jika belum hold).
- **Hold:** sama BTC (outlook NAIK → tahan).
- **Exit 1:** turun 1% dari entry sebelum +1% + outlook ≠ NAIK → jual.
- **Exit 2:** +1% target reached, hold sampai NETRAL/TURUN atau trailing 1% dari peak.
- **Stop:** 1% loss sebelum target, jika outlook ≠ NAIK.
- **Cooldown:** 15 menit per pair.

## Live trading safeguard (implemented Fase 1)

✅ **Enable flag:** `LIVE_TRADING_ENABLED=false` default. Require `true` + `MAX_ORDER_IDR` > 0 + `MAX_PRICE_DEVIATION_PCT` > 0 untuk aktif.

✅ **Harga deviasi:** review harga di start, confirm harga harus dalam batas. Tolak jika melompat.

✅ **Presisi order:** jumlah jual BTC divalidasi sesuai `quantity_increment` & `trade_min_traded_currency` pair.

✅ **Token UUID:** setiap `/buy` `/sell` generate UUID; callback wajib kirim token valid.

✅ **TTL & expiry:** order TTL 2 menit; callback tidak berlaku jika expired atau token salah.

✅ **Status TIDAK PASTI:** timeout/500 error → pause & mark uncertain. User cek manual Indodax, `/resolveorder` setelah verifikasi.

✅ **Kill switch:** `/pause` `/resume` `/killswitch` milik owner (chat ID match). State atomik di `data/order-control.json`.

✅ **Audit log:** semua event (intent_started, order_created, order_error, order_uncertain, order_resolved) di `logs/orders.jsonl`.

✅ **Fake API test:** tes gunakan mock API, bukan real order.

## Sebelum real trading

- Independen validasi Indodax API V2: presisi, minimum, fee, rate limit, error handling.
- Paper trading 30+ hari, berbagai regime pasar.
- Hitung net profit setelah fee/tax/slippage.
- Jangan percaya signal atau backtest; ini heuristic.
- Withdraw permission boleh enable setelah order verified & tested.
- Rotate API key jika exposed.
