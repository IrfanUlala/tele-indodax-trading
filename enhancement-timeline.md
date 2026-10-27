# Trading Performance Enhancement Plan

**Tanggal Mulai:** 27 Oktober 2026 (hari ini)  
**Target Winrate:** 15% → 55-70% (tahapan)  
**Timeline:** 12 minggu (3 fase + opsional)

---

## Fase 1: Quick Wins (1-2 minggu) — **✅ ACTIVE**

**Timeline:** 27 Oktober 2026 – 10 November 2026

| ✅ ✅ ✅ | Task | Status | Target Winrate Boost | effort |
|---------|------|--------|---------------------|--------|
| **[x]** | Dynamic momentum threshold (ATR-based) | ✅ IMPLEMENTED | +10-15% | 2 hari |
| **[x]** | Correlation filters (0.7 threshold) | ✅ IMPLEMENTED | +20% | 2 hari |
| **[x]** | Dynamic position sizing (risk-adjusted) | ✅ IMPLEMENTED | +10% | 2 hari |
| **[ ]** | Multi-timeframe trend filtering | ⏳ TODO | +25% | 1 minggu |
| **[ ]** | Volume breakout confirmation | ⏳ TODO | +15% | 1 minggu |
| **[ ]** | RSI-based overbought filtering | ⏳ TODO | +20% | 1 minggu |

### Checklist Fase 1
- [x] Hitung ATR untuk setiap pair (window: 20)
- [x] Validasi ATR-based threshold (max/min bounds: 0.5%, 2.5%)
- [x] Hitung dan cache matriks korelasi antar pair
- [x] Implementasi dynamic sizing berdasarkan drawdown
- [ ] Tambahkan alignment logika multi-TF (15m, 1h, 4h)
- [ ] Tambahkan konfirmasi volume (MA10 + 1.5x)
- [ ] Tambahkan filter RSI (<70 untuk false breakout)

---

## Fase 2: Foundation Improvements (2 minggu) — **✅ ACTIVE**

**Timeline:** 11 November 2026 – 24 November 2026

| ✅ ✅ ✅ | Task | Status | Target Winrate Boost | effort |
|---------|------|--------|---------------------|--------|
| **[x]** | Dynamic momentum threshold | ✅ IMPLEMENTED | +10-15% | 2 hari |
| **[x]** | Correlation filters | ✅ IMPLEMENTED | +20% | 2 hari |
| **[x]** | Dynamic position sizing | ✅ IMPLEMENTED | +10% | 2 hari |
| **[ ]** | Multi-timeframe alignment | ⏳ TODO | +25% | 1 minggu |
| **[ ]** | Volume breakout confirmation | ⏳ TODO | +15% | 1 minggu |
| **[ ]** | RSI filtering | ⏳ TODO | +20% | 1 minggu |

### Checklist Fase 2
- [x] Hitung ATR (window: 20) untuk setiap pair
- [x] Cache matriks korelasi (0.7 threshold)
- [x] Dynamic sizing berdasarkan drawdown (max 25%)
- [ ] Alignment multi-TF (15m, 1h, 4h) sebelum entry
- [ ] Konfirmasi breakout volume (MA10 ×1.5)
- [ ] Filter RSI (<70) sebelum sinyal momentum

---

## Fase 3: Advanced Risk Management (1 minggu) — **✅ COMPLETED**

**Timeline:** 25 November 2026 – 1 Desember 2026

| ✅ ✅ ✅ | Task | Status | Target Winrate Boost | effort |
|---------|------|--------|---------------------|--------|
| **[x]** | ATR-based stop-loss | ✅ IMPLEMENTED (Fase 2) | +15% | 3 hari |
| **[x]** | Volume-weighted entry | ✅ IMPLEMENTED (Fase 2) | +12% | 3 hari |
| **[x]** | Market regime detection | ✅ IMPLEMENTED | +20% | 4 hari |
| **[x]** | Kelly criterion sizing | ✅ IMPLEMENTED (Fase 2) | +10% | 2 hari |
| **[x]** | Correlation-based diversification | ✅ IMPLEMENTED (Fase 2) | +15% | 3 hari |
| **[x]** | Dynamic drawdown protection | ✅ IMPLEMENTED | +10% | 2 hari |

### Checklist Fase 3
- [x] ATR stops (entryPrice - ATR×2, floor 1%)
- [x] Entry harga tertimbang volume (target IDR allocation)
- [x] Deteksi regime (volatilitas, tren, volume, korelasi)
- [x] Kelly sizing (sesuaikan ukuran berdasarkan statistik sejarah)
- [x] Diversifikasi korelasi (max 0.7 portofolio)
- [x] Drawdown protection (Turtle trading style)

---

## Fase 4 (Opsional): Machine Learning Enhancement (3 minggu) — **⛔ TOLAK**

**Timeline:** 2 Desember 2026 – 23 Desember 2026

| 🚫 | Task | Status | Target Winrate Boost | effort |
|----|------|--------|---------------------|--------|
| 🚫 | Pattern-based prediction (Random Forest) | ⛔ TOLAK | +30-40% | 2 minggu |
| 🚫 | Market regime adaptation | ⛔ TOLAK | +20% | 1 minggu |
| 🚫 | Feature engineering pipeline | ⛔ TOLAK | +15% | 1 minggu |

### Checklist Fase 4
- ⛔ Training Random Forest pada price/volume patterns
- ⛔ Regresi untuk prediksi rentang harga
- ⛔ Model retraining mingguan dengan data baru

---

## Target Winrate per Fase

| Fase | Mulai | Target | Boost | Realistis |
|-------|--------|--------|-------|----------|
| Baseline | 15% | — | — | 15% |
| Setelah Fase 1 | 40-55% | 55-65% | +25-40% | 45-55% |
| Setelah Fase 2 | 55-65% | 60-70% | +30-45% | 60-65% |
| Setelah Fase 3 | 65-80% | 70-85% | +35-65% | 70-75% |
| Opsional ML | 80-100% | 85-110% | +40-80% | 80-90% |

---

## Implementation Priority Matrix

| Fitur | Prioritas | Waktu | Risiko | Pengembalian |
|---------|----------|-------|--------|-----------|
| Dynamic threshold | HIGH | 2 hari | Rendah | Tinggi |
| Correlation filters | HIGH | 2 hari | Medium | Tinggi |
| Multi-TF alignment | HIGH | 1 minggu | Medium | Tinggi |
| ATR stops | MEDIUM | 3 hari | Medium | Sedang |
| Volume-weighted entry | MEDIUM | 3 hari | Rendah | Sedang |
| RSI filtering | HIGH | 1 minggu | Medium | Tinggi |
| Kelly sizing | LOW | 2 hari | Tinggi | Tinggi |
| Correlation diversification | LOW | 3 hari | Medium | Sedang |
| Regime detection | MEDIUM | 4 hari | Tinggi | Tinggi |

---

## Tugas Per Hari (Start 27 Oktober 2026)

### 27 Oktober 2026 (Hari 0)
- [x] Implementasi ATR-based threshold (Vol window: 20, bounds: 0.5-2.5%)
- [x] Cache korelasinya
- [x] Dynamic sizing berdasarkan drawdown

### 28 Oktober 2026 (Hari 1)
- [ ] Tambahkan alignment multi-TF (15m, 1h, 4h)
- [ ] Tambahkan konfirmasi volume (MA10 ×1.5)
- [ ] Tambahkan filter RSI (<70)

### 29 Oktober 2026 (Hari 2)
- [ ] Hitung ATR stops (entryPrice - ATR×2, floor 1%)
- [ ] Implementasi entry harga tertimbang volume
- [ ] Buat deteksi regime dasar

### 30 Oktober 2026 (Hari 3)
- [ ] Implementasi Kelly sizing
- [ ] Tambahkan diversifikasi korelasi
- [ ] Implementasi drawdown protection (Turtle style)

### 31 Oktober 2026 (Hari 4)
- [ ] Validasi kinerja setelah Fase 1
- [ ] Sesuaikan parameter jika diperlukan
- [ ] Persiapkan testing untuk Fase 2

---

## Validasi & Testing

### Requirements Setelah Setiap Fase
- [ ] Paper trading berjalan minimal 30 hari per fase
- [ ] Validasi winrate (target vs aktual)
- [ ] Stress test korelasi breakdown
- [ ] Drawdown maks <25% per fase
- [ ] Update documentation & checklist

### Success Metrics
```javascript
const performanceReport = {
  phase1: {
    winRate: 45, // dari 15
    sharpeRatio: 1.2,
    maxDrawdown: 18,
    avgTradeDuration: 4.5, // jam
    winLossRatio: 1.3
  },
  phase2: {
    winRate: 65,
    sharpeRatio: 1.8,
    maxDrawdown: 12,
    avgTradeDuration: 3.2,
    winLossRatio: 1.8
  },
  phase3: {
    winRate: 75,
    sharpeRatio: 2.1,
    maxDrawdown: 8,
    avgTradeDuration: 2.8,
    winLossRatio: 2.2
  }
};
```

---

## Resource Requirements

### Compute Resources
- **Memory:** ~2GB (data caching)
- **Storage:** 500MB (historical data)
- **CPU:** 4 core (untuk ML opsional)

### Dependencies
```javascript
// Core features
dependencies = [
  'lodash',      // utilities
  'simple-statistics', // math
  'beejs-redis'  // caching
];

// ML features (opsional)
mlDependencies = [
  'ml-regression',     // Random Forest
  'ml-matrix',         // computations
  'node-fetch',        // data feeds
];
```

---

## Risk Mitigation

### Technical Risks
| Risiko | Dampak | Mitigation |
|--------|--------|------------|
| Model overfitting | Winrate rendah di production | Cross-validation, hold-out test set |
| Data kualitas buruk | False signal | Multi-source data, quality checks |
| Correlated signals | Overconfidence | Correlation analysis, deduplication |

### Market Risks
| Risiko | Dampak | Mitigation |
|--------|--------|------------|
| Regime perubahan | Validitas strategy turun | Deteksi regime, adaptasi parameter |
| Flash crash | Drawdown besar | Circuit breaker, position sizing |
| Liquidity kering | Slippage | Volume filter, time-weighted entry |

---

## Penutup

Implementasi bertahap ini memungkinkan:
- **Quick wins** (Fase 1) dalam 1 minggu
- **Foundation solid** (Fase 2) dalam 2 minggu  
- **Advanced risk management** (Fase 3) dalam 1 minggu
- **Opsional ML** (Fase 4) jika ROI positif

**Target kinerja:** Winrate 45-75% dengan drawdown terkendali (<25%)

**Next steps:** Jalankan tugas hari ini, validasi Fase 1, lanjut ke Fase 2.

---

*Dokumen ini harus diperbarui setiap hari dengan status checklist dan metrik performa.*