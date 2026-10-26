# AUDIT KESESUAIAN PROJECT vs DOKUMENTASI INDODAX

**Tanggal:** 26 Oktober 2026  
**Status:** ❌ TIDAK SESUAI (perbaikan diperlukan)

---

## 1. PUBLIC REST API ✅ SESUAI

**File:** `src/indodax.js` (lines 52-98)  
**Endpoint:** `https://api.indodax.com/api/v2/*`

### Implementasi Benar:
- ✅ Method: `POST` dengan `Content-Type: application/x-www-form-urlencoded`
- ✅ Headers: `X-APIKEY` dan `Sign` (line 68)
- ✅ Signature: HMAC-SHA256 (line 6: `crypto.createHmac('sha256', secret)`)
- ✅ Parameters: `timestamp` dan `recvWindow` (line 62, 88)
- ✅ Error handling: Mengecek `response.ok`, `data.code`, `data.success` (line 78)

### Endpoints Digunakan:
- `account` (line 84) → Get Account Information ✅
- `order` (line 96) → Create Order ✅

**Kesimpulan:** REST API v2 sudah benar sesuai INDODAX-TradeAPI-2.md

---

## 2. MARKET DATA WEBSOCKET ❌ TIDAK SESUAI

**File:** `src/index.js` (lines 141-172)  
**Endpoint:** `wss://ws3.indodax.com/ws/`

### MASALAH 1: Authentication Payload SALAH (line 146-150)

**Implementasi Saat Ini:**
```javascript
const authPayload = {
  channel: "v3/user",
  action: "auth",
  token: ""
};
ws.send(JSON.stringify(authPayload))
```

**Format Benar (Marketdata-websocket.md, line 40-46):**
```json
{
    "params": {
        "token": "eyJhbG...skeo"
    },
    "id": 1
}
```

**Dampak:** Server menolak dengan error 3003 (Go Away) → inilah kenapa line 133 comment `wsDisabled = true`

---

### MASALAH 2: Subscribe Payload SALAH (line 153)

**Implementasi Saat Ini:**
```javascript
ws.send(JSON.stringify({ method: 'subscribe', params: ['market:trade-activity-btcidr'] }));
```

**Format Benar (Marketdata-websocket.md, line 95-102):**
```json
{
    "method": 1,
    "params": {
        "channel": "market:trade-activity-btcidr"
    },
    "id": 2
}
```

**Perbedaan Kritis:**
- ❌ `method: 'subscribe'` → harus `method: 1` (integer, bukan string)
- ❌ `params: [...]` (array) → harus `params: { channel: ... }` (object)
- ❌ Tidak ada `id` field → required untuk tracking

---

### MASALAH 3: Parsing Response SALAH (line 160)

**Implementasi:**
```javascript
if (msg.result?.channel === 'market:trade-activity-btcidr') subscribed = true;
```

**Format Response Benar (Marketdata-websocket.md, line 235-254):**
```json
{
    "result": {
        "channel": "market:trade-activity-btcidr",
        "data": {
            "data": [
                [
                    "btcidr",       // pair
                    1635274052,     // epoch timestamp in second
                    21999427,       // sequence number
                    "buy",          // side
                    881991000,      // filled price
                    "29740",        // IDR volume
                    "0.00003372"    // BTC volume
                ]
            ],
            "offset": 243556
        }
    }
}
```

Parsing di line 161-162 sudah benar, tapi authentication dulu gagal.

---

### MASALAH 4: Ping/Pong Tidak Sesuai (line 154)

**Implementasi:**
```javascript
wsPingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
```

**Format Benar (Marketdata-websocket.md, line 68-83):**
```json
{
    "method": 7,
    "id": 3
}
```

Project menggunakan WebSocket native `ping()`, tapi Indodax memerlukan message dengan `method: 7`.

---

## 3. PRIVATE WEBSOCKET ❌ TIDAK DIIMPLEMENTASIKAN

**File:** Tidak ada  
**Dokumentasi:** `Private-websocket.md`

### Yang Diperlukan:

1. **Generate Token (Private-websocket.md, line 37-76)**
   ```
   POST https://indodax.com/api/private_ws/v1/generate_token
   Headers: Sign (HMAC-SHA512)
   Body: client=tapi&tapi_key={API_KEY}
   Response: connToken + channel
   ```

2. **Connect & Subscribe (Private-websocket.md, line 86-140)**
   ```
   WebSocket: wss://pws.indodax.com/ws/?cf_ws_frame_ping_pong=true
   Message: {"connect":{"token":"..."},"id":1}
   Subscribe: {"subscribe":{"channel":"pws:#..."},"id":2}
   ```

3. **Order Updates (Private-websocket.md, line 135-150+)**
   - Real-time order status
   - Trade execution alerts
   - Seharusnya lebih baik daripada polling REST API

### Dampak:
- Project sekarang polling `/api/v2/account` untuk status
- Tidak mendapat update real-time order execution
- Lebih lambat dan bandwidth lebih besar

---

## 4. SIGNATURE ALGORITHM ⚠️ INKONSISTENSI

**Ditemukan dua algoritma berbeda:**

1. **REST API (indodax.js, line 6):**
   ```javascript
   crypto.createHmac('sha256', secret).update(query).digest('hex');
   ```
   ✅ Benar untuk API v2 (INDODAX-TradeAPI-2.md, line 47)

2. **Private WebSocket Token Generation (belum ada, tapi docs line 32):**
   ```
   Harus: HMAC-SHA512
   ```
   ❌ Project tidak implement ini

3. **Old TAPI (tidak dipakai):**
   ```javascript
   crypto.createHmac('sha512', secret).update(body).digest('hex');  // line 11
   ```
   Di-export tapi tidak dipakai di REST API v2

---

## 5. CHANNEL SUBSCRIPTION ✅ SESUAI (format)

**Digunakan:** `market:trade-activity-btcidr`  
**Dokumentasi:** Marketdata-websocket.md, line 204-254

Channel name benar, tapi payload format salah (lihat MASALAH 2).

---

## 6. ERROR HANDLING & TROUBLESHOOTING

### Line 133: `wsDisabled = true` 

```javascript
let wsDisabled = false; // Indodax WS returning 3003 (Go Away); use REST fallback
```

**ROOT CAUSE:** Authentication payload format salah (MASALAH 1)  
**SOLUSI:** Fix auth payload, jangan disable WS

### Reconnection Logic (line 166-172)

```javascript
ws.on('close', code => {
  // ...exponential backoff...
  wsRetry = setTimeout(connectMarketSocket, delay);
});
```

✅ Exponential backoff ada, tapi hanya untuk reconnect.  
⚠️ Tidak ada recovery dengan `recover: true` dan `offset` (Marketdata-websocket.md, line 370-444)

---

## 7. DOKUMENTASI YANG TIDAK DIGUNAKAN

| Dokumen | Status | Alasan |
|---------|--------|--------|
| Private REST API | ❓ Partial | Hanya untuk token generation, belum ada |
| Private WebSocket | ❌ Not Used | Order updates bisa real-time, tapi tidak diimplementasikan |
| Deadman Switch | ❌ Not Used | Safety feature tidak ada |
| Self-Trade Prevention | ❌ Not Used | Anti-self-trade tidak ada |
| CHANGELOG | ℹ️ Info Only | Dokumentasi outdated (2019-10-14) |

---

## RINGKASAN MASALAH

| No | Komponen | Status | Severity | File | Line |
|----|----------|--------|----------|------|------|
| 1  | Auth Payload WS | ❌ SALAH | CRITICAL | index.js | 146-150 |
| 2  | Subscribe Payload WS | ❌ SALAH | CRITICAL | index.js | 153 |
| 3  | Ping/Pong WS | ❌ SALAH | MEDIUM | index.js | 154 |
| 4  | Private WebSocket Token | ❌ MISSING | MEDIUM | - | - |
| 5  | Order Update Real-time | ❌ MISSING | LOW | - | - |
| 6  | Recovery Offset | ❌ MISSING | LOW | index.js | 166-172 |
| 7  | REST API v2 | ✅ BENAR | - | indodax.js | 52-98 |

---

## REKOMENDASI PERBAIKAN

### Priority 1 (Critical - Harus diperbaiki untuk WS berfungsi):
1. Fix authentication payload (use `params.token` + `id`)
2. Fix subscribe payload (use `method: 1` + object params + `id`)
3. Fix ping/pong (use `method: 7` message, bukan `ws.ping()`)

### Priority 2 (Medium - Untuk stabilitas):
4. Implement recovery dengan offset tracking
5. Implement Private WebSocket untuk order updates

### Priority 3 (Nice-to-have):
6. Implement Deadman Switch
7. Add Self-Trade Prevention

---

## SIGNATURE AUDIT

✅ **indodax.js signV2()** - Sesuai INDODAX-TradeAPI-2.md
- HMAC-SHA256 ✓
- Query string format ✓
- Hex output ✓

❌ **Private WS Token Generation** - Belum ada
- Memerlukan HMAC-SHA512
- Format: `client=tapi&tapi_key=KEY` (dari body)

❌ **Old TAPI signPayload()** - Outdated
- HMAC-SHA512 sudah tidak dipakai
- Line 11 bisa dihapus atau comment

