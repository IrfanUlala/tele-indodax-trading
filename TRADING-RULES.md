# Trading rules and risk policy

This is general risk guidance, not personalized financial advice. Crypto is volatile; losses can exceed expectations. Start with monitoring and paper trading only. The project does not currently execute orders.

## Operating rules

1. **One asset/pair only:** BTC/IDR (`btcidr`). Never accept a user-supplied pair in execution paths.
2. **Human decision required:** signals are observations, not buy/sell recommendations. Each proposed action must be reviewed by a human; current Telegram button only acknowledges/ignores and cannot trade.
3. **Paper test first:** record timestamp, price, signal, hypothetical entry/exit, fees, spread and slippage. Evaluate across different market regimes for at least several weeks before considering live funds.
4. **Risk only what you can lose:** decide a small maximum portfolio allocation and maximum loss per trade in advance. Never borrow, use leverage, or average down to rescue a losing position.
5. **Predefine entry, invalidation and exit:** before any hypothetical entry, document why, invalidation/stop level, target, time horizon, and maximum loss. Do not move a stop farther away after entry.
6. **Account for costs:** include exchange trading fees, bid/ask spread, slippage, minimum order and price/quantity increments. A gross gain is not a net gain.
7. **Avoid noisy signals:** a short-window percentage change is not predictive. Confirm data freshness and independent context; avoid acting on stale, missing, abnormal or conflicting prices.
8. **Cooldown and rate limits:** do not repeatedly act on the same signal. Respect exchange limits and stop on errors; do not retry a trade blindly.
9. **Protect credentials:** API key should have only the minimum required permissions; disable withdrawal permissions. Store secrets in `.env` with restrictive local permissions (`chmod 600 .env`), never commit/log them, and rotate if exposed.
10. **Fail closed:** on data outage, clock issues, Telegram/API errors, or unexpected responses, pause and alert; never infer a trade or submit an order.
11. **Manual reconciliation:** verify account balances and order status in the official exchange interface. Bot acknowledgements are not proof of an executed order.
12. **Operational limit:** PM2 restart is for service availability, not trading continuity; inspect logs and health after reboot. Maintain a kill switch (`pm2 stop coint-trading`).

## Signal currently implemented

The code compares the first and latest BTC/IDR observations within a rolling 15-minute sample against `SIGNAL_THRESHOLD_PCT` (default 1%). It labels threshold crossings `WATCH_BUY` or `WATCH_SELL`; otherwise `HOLD`/`WAIT`. This simple heuristic does not establish trend, estimate probability, account for fees, or predict the future. Thresholds are configurable and unvalidated; alerts have a cooldown. Do not use it as a strategy without independent backtesting and paper trading.

## Before any live trading feature

Require a separately reviewed implementation with explicit order sizing caps, price/quantity validation, fee/slippage-aware limits, duplicate-order protection, expiry, confirmation bound to an exact pair/side/quantity/limit price and short-lived nonce, authorized Telegram chat/user checks, audit log, reconciliation, and an emergency disable. Use an API key with trading-only permissions and withdrawals disabled. Obtain explicit user approval for the precise execution policy. No such feature is included here.
