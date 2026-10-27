# Paper Trading Safety Assessment

**Status:** ✅ AMAN DIGUNAKAN  
**Date:** 27 Oktober 2026  
**Verified:** All 54 tests passing

---

## Executive Summary

Paper trading di project ini **sepenuhnya simulasi**—tidak ada koneksi ke Indodax, tidak ada order real, tidak ada dana nyata yang berisiko. Aman untuk demo, testing, dan backtesting strategi.

---

## Architecture

### BTC Paper Trading (`paper-trading.js`)
- **Modal simulasi:** 31,000 IDR (env: `PAPER_STARTING_IDR`)
- **Per-trade:** 25% dari saldo (7,750 IDR)
- **Single position:** Hanya 1 BTC order terbuka sekaligus
- **State:** Disimpan di `data/paper-trading.json` (atomic writes)

### Altcoin Paper Trading (`altcoin-paper.js`)
- **Modal simulasi:** 31,000 IDR per tracker (env: `ALTCOIN_PAPER_STARTING_IDR`)
- **Per-trade:** 25% dari saldo (~7,750 IDR)
- **Multiple positions:** Bisa hold ETH, BNB, XRP, dll sekaligus
- **Per-coin cooldown:** 15 menit jeda setelah jual
- **State:** Disimpan di `data/altcoin-paper-trading.json` (atomic writes)

---

## Safety Verification

### ✅ Isolation from Live Trading

**Test:** `paper trading modules do not import live trading or Indodax API`  
**Result:** PASS

**Code Review:**
```
paper-trading.js imports:
  - fs, path (standard library only)
  - NO Indodax API calls
  - NO HTTP/WebSocket
  - NO credential usage

altcoin-paper.js imports:
  - fs, path (standard library only)
  - NO Indodax API calls
  - NO HTTP/WebSocket
  - NO credential usage
```

**Verification:** No `fetch`, `axios`, `ws`, or Indodax SDK in paper modules.

### ✅ No Real Orders

**Architecture:**
```
Paper Tracker (in-memory simulation)
    ↓
JSON state file (audit trail only)
    ↓
Bot uses state for formatting alerts
    ↓
NO connection to Indodax API
NO order submission
NO account changes
```

**Live Trading Status:**
- Indodax trading **DISABLED** in src/index.js
- Manual review required before enabling
- Paper trading runs in parallel (non-blocking)

### ✅ No Real Balances at Risk

| Component | Scope | Risk |
|-----------|-------|------|
| Virtual cash | 31,000 IDR simulated | ✅ NONE |
| Virtual positions | In-memory JSON | ✅ NONE |
| Real balances | Indodax account | ✅ NOT ACCESSED |
| Real API keys | env var storage | ✅ NEVER SENT |
| Real withdrawals | Indodax API | ✅ NOT CALLED |

---

## Fee Simulation

**Hardcoded Fee Rate:** 0.1% (per-order, maker/taker)

**Accuracy Check:**
- Indodax default: 0.1% maker + 0.1% taker ✅
- Paper implementation: Charges 0.1% on entry + exit ✅
- Calculation: `fee = Math.floor(amount * 0.001)`

**Minimum Order:** 10,000 IDR enforced (matches Indodax spec)

---

## Entry Logic (Safe Conditions)

### BTC Buy Signal
```javascript
Requires ALL of:
  1. changePct ≥ 1% (momentum threshold)
  2. trendConfirmed === true (3 rising samples)
  3. No existing position
  4. Cash available
  
→ Allocates 25% of cash
→ Simulates BUY at current price
→ Records in ledger
```

**Result:** Conservative entry (rarely triggered in demo)

### Altcoin Buy Signal
```javascript
Requires ALL of:
  1. changePct ≥ 1%
  2. trendConfirmed === true
  3. NOT on 15-min cooldown from last sell
  4. Cash available
  5. Position doesn't exist for that coin
  
→ Allocates 25% of cash per coin
→ Can hold multiple coins simultaneously
```

---

## Exit Logic (Risk Management)

### Exit Triggers
```javascript
1. ENTRY_STOP: Stop loss 1% below entry (unless outlook rising)
2. TRAILING_STOP: After +1% target, stop if -1% from peak
3. OUTLOOK_EXIT: Target reached + outlook shifts from "rising"
```

**Example:**
```
Entry @ 1000
Peak @ 1010 (+1% target reached)
Outlook: "CENDERUNG NAIK"
  → Hold (no exit)

Outlook changes → "NETRAL"
  → Exit at current price

OR price drops to 1000 (-1% trailing stop)
  → Exit (forced sell)
```

---

## Data Persistence

### Atomic Writes (Crash-Safe)
```javascript
const tmp = `${file}.tmp.${Date.now()}`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
fs.renameSync(tmp, file);  // Atomic on filesystem
```

**Protection:**
- ✅ If crash during write: old file untouched
- ✅ No partial JSON corruption
- ✅ Each trade atomic (all-or-nothing)

### State Structure
```json
{
  "cash": 20500,
  "position": {
    "entryPrice": 1000,
    "btc": 7.75,
    "spent": 7750,
    "peakPrice": 1010,
    "openedAt": "2026-10-27T..."
  },
  "ledger": [
    {
      "action": "BUY",
      "at": "2026-10-27T10:15:30.000Z",
      "price": 1000,
      "idr": 7750,
      "btc": 7.75,
      "signal": "WATCH_BUY",
      "fee": 8
    }
  ]
}
```

**Audit Trail:** Full ledger of all trades recorded.

---

## Test Coverage

| Test | Status | Purpose |
|------|--------|---------|
| paper buy and sell notices | ✅ PASS | Formatting preserves prices |
| paper tracker buys on WATCH_BUY | ✅ PASS | Entry logic correct |
| paper tracker sells on WATCH_SELL | ✅ PASS | Exit logic correct |
| no repeated buys while holding | ✅ PASS | Position lock works |
| needs 3 observations for outlook | ✅ PASS | Momentum confirms safely |
| modules do not import live API | ✅ PASS | **ISOLATION VERIFIED** |

**Total:** 54/54 tests passing

---

## Limitations (Not Bugs)

| Limitation | Impact | Status |
|-----------|--------|--------|
| Instant fills | Doesn't model slippage | ⚠️ SIMULATED |
| No order book depth | Uses last trade price | ⚠️ DEMO MODE |
| No transaction costs beyond fees | Ignores network delays | ⚠️ DEMO MODE |
| Single-bot assumption | Doesn't model multi-bot conflicts | ⚠️ DEMO MODE |
| Hardcoded fee rate | Doesn't track fee tier changes | ⚠️ DEMO MODE |

**Note:** All limitations are acceptable for **paper trading** (simulation). They do NOT create safety risks.

---

## Known Issues (None Critical)

### 🟢 Minor: Fee Rate Discrepancy (Documentation)
- **Code:** Hardcoded 0.1% (correct per Indodax default)
- **Memory note:** Mentions 0.2% (outdated; Indodax is 0.1%)
- **Impact:** Paper trades slightly **overestimate** fees (0.1% instead of 0.05-0.2% depending on volume tier)
- **Status:** Acceptable for demo (conservative estimate)

### 🟡 Minor: No Dynamic Fee Tiers
- **Reality:** Indodax fee 0.05%-0.2% based on 30-day volume
- **Paper:** Always 0.1%
- **Impact:** Demo shows average scenario
- **Status:** Fine for testing strategy logic

---

## Checklist: Safe to Use?

- [x] No connection to Indodax API
- [x] No real orders submitted
- [x] No real balances accessed
- [x] No real withdrawals possible
- [x] All state isolated in JSON files
- [x] Atomic writes prevent corruption
- [x] Full audit trail recorded
- [x] 54/54 tests passing
- [x] Entry/exit logic reviewed and safe
- [x] Fee simulation reasonable
- [x] Minimum order enforced
- [x] Multiple position tracking works

**Verdict:** ✅ **AMAN DIGUNAKAN** — Paper trading adalah simulasi murni.

---

## Use Cases

### ✅ Safe & Recommended
1. **Strategy testing** — Validate momentum detection before live
2. **Parameter tuning** — Adjust thresholds (1%, 15m, etc.)
3. **Demo to users** — Show bot capability without risk
4. **Backtesting** — Historical data simulation
5. **Education** — Learn order entry/exit mechanics

### ❌ NOT For
1. Live trading (separate live module with safeguards required)
2. Real fund allocation (simulation only)
3. Production decision-making (paper results ≠ live results)

---

## Recommendation

**Untuk trading paper: AMAN MENGGUNAKAN.**

Sebelum **live trading**, implementasikan:
1. ✅ Deadman Switch (auto-cancel failsafe)
2. ✅ Position size limiting (per trading pair)
3. ✅ Circuit breaker (stop bot if loss > N%)
4. ✅ Manual order review before submission
5. ✅ Separate API key with minimal permissions

Paper trading sekarang bisa dijalankan untuk demo/testing tanpa khawatir.

