# Coint Trading — BTC/IDR monitor

Node.js + Express health endpoint, Indodax market-data WebSocket with public REST ticker fallback, and Telegram alerts. **Monitor-only:** buttons record/ignore a proposal; no authenticated account connection or order execution is implemented. Signals are heuristics, not predictions or financial advice.

## Setup

1. Install Node.js 20+ and PM2. From this folder: `npm install`.
2. Copy `.env.example` to `.env`; fill in Telegram bot token and your private chat ID. Do not paste secrets into chat or commit `.env`.
3. Run `npm test` then `npm start`. Health check: `curl http://127.0.0.1:3000/health`; Telegram command `/status`.
4. Confirm WebSocket traffic, ticker REST fallback, and Telegram delivery manually. Keep this in paper/monitor mode before considering any real trade.

## PM2 and start-on-boot (Fedora/systemd)

From this directory:

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

PM2 prints a `sudo env PATH=... pm2 startup systemd -u ... --hp ...` command. Run exactly that command in your terminal; then run `pm2 save` again. Verify with `pm2 status`, `pm2 logs coint-trading`, and `systemctl status pm2-$(whoami)`. On login/boot, systemd will restore the saved app list. Keep laptop connected to power/network as needed.

To stop/remove: `pm2 stop coint-trading`; `pm2 delete coint-trading`; `pm2 save`.

## Manual position tracking (Telegram)

After buying BTC manually on Indodax, send `/beli <entry-price-in-IDR>` (example: `/beli 1450000000`). The position is stored locally in `data/position.json` and survives restarts; do not commit it. Every new ±0.5% threshold from the recorded entry price triggers a Telegram message with **Jual (catat manual)** and **Pertahankan** buttons. Buttons only record your choice; they never place an order. Choosing sell pauses alerts until you have sold manually and send `/selesai`. Use `/status` to see the current recorded entry and latest price.

`/beli` records one average entry price only; it does not import fills, quantities, or fees from Indodax. It is the user's responsibility to enter the correct price after a manual purchase.

## API

`GET /health` is bound to loopback only and reports the latest BTC/IDR observation, market socket state and last socket message time. This endpoint is not an authentication API; keep it local.

## Safety and trading rules

See [TRADING-RULES.md](TRADING-RULES.md). Before real money, independently validate market-data semantics, calculate fees/slippage, and do a long paper-trading period. No signal guarantees a rise/fall.
