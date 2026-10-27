function quoteVolume(ticker) {
  const value = Number(ticker?.vol_idr ?? ticker?.volIdr ?? ticker?.quote_volume_idr ?? ticker?.volume_idr);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function rankIdrPairs(payload, limit = 10) {
  const tickers = payload?.tickers ?? payload?.ticker ?? payload;
  if (!tickers || typeof tickers !== 'object' || !Number.isInteger(limit) || limit < 1) return [];
  return Object.entries(tickers)
    .map(([key, ticker]) => ({ key, ticker, match: key.match(/^([a-z0-9]+)_?idr$/i) }))
    .filter(item => item.match && item.match[1].toLowerCase() !== 'btc')
    .map(({ key, ticker, match }) => ({ symbol: match[1].toLowerCase(), pair: `${match[1].toLowerCase()}idr`, volumeIdr: quoteVolume(ticker) }))
    .filter(item => item.volumeIdr > 0)
    .sort((a, b) => b.volumeIdr - a.volumeIdr || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

export function scanTopPairs(payload, histories, { now = Date.now(), limit = 10, windowMs = 15 * 60_000, thresholdPct = 1 } = {}) {
  const topPairs = rankIdrPairs(payload, limit);
  const candidates = risingCandidates(histories, { now, windowMs, thresholdPct });
  const bySymbol = new Map(candidates.map(item => [item.symbol, item]));
  return topPairs.map(pair => ({ ...pair, ...(bySymbol.get(pair.symbol) ?? { changePct: null, price: null }) }));
}

export function formatAltcoinAlert(item) {
  const pct = item.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const outlook = item.outlook?.direction ?? 'BELUM CUKUP DATA';
  const outlookLine = item.outlook?.changePct === null || item.outlook?.changePct === undefined
    ? 'Estimasi arah 15 menit ke depan: *BELUM CUKUP DATA*'
    : `Arah terpantau 15 menit ke depan: *${outlook}* (${item.outlook.changePct >= 0 ? '+' : ''}${item.outlook.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% pada jendela observasi)`;
  return [
    `🔎 *KANDIDAT MOMENTUM — ${item.symbol.toUpperCase()}/IDR*`,
    '',
    `📈 Kenaikan 15 menit: *+${pct}%*`,
    `💰 Harga terakhir: *Rp${Math.floor(item.price).toLocaleString('id-ID')}*`,
    `📊 Volume 24 jam: Rp${Math.floor(item.volumeIdr).toLocaleString('id-ID')}`,
    '',
    outlookLine,
    'Ini estimasi kecenderungan dari data historis, bukan kepastian atau saran transaksi.',
    '',
    'Catatan: momentum terpantau, bukan prediksi pasti.',
    'Alert saja — tidak ada order atau transaksi paper.',
  ].join('\n');
}

export function formatAltcoinReport({ items = [], thresholdPct = 1, updatedAt = null } = {}) {
  const lines = [
    '🔎 *PEMANTAUAN ALTCOIN IDR*',
    '10 pasangan IDR teratas berdasarkan volume Indodax',
    `Ambang kandidat: naik ≥ *${thresholdPct}%* dalam jendela 15 menit`,
    `Pembaruan: ${updatedAt ? new Date(updatedAt).toLocaleString('id-ID') : 'belum tersedia'}`,
    '',
  ];
  if (!items.length) lines.push('Data pemantauan belum tersedia. Coba lagi sebentar.');
  else items.forEach((item, index) => {
    const movement = item.changePct === null ? '⏳ Mengumpulkan data' : `📈 *+${item.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%*`;
    const price = item.price === null ? '—' : `Rp${Math.floor(item.price).toLocaleString('id-ID')}`;
    lines.push(`${index + 1}. *${item.symbol.toUpperCase()}/IDR* — ${movement}`);
    lines.push(`   Harga: ${price}  ·  Volume: Rp${Math.floor(item.volumeIdr).toLocaleString('id-ID')}`);
  });
  lines.push('', '⏳ = data 15 menit belum cukup.', 'Deteksi momentum saja—bukan kepastian harga naik. Tidak ada order atau paper trade altcoin.');
  return lines.join('\n');
}

export function detectUptrend(samples, uptrendRatioPct = 60, minOverallChangePct = 0.5) {
  if (!Array.isArray(samples) || samples.length < 2) return { isUptrend: false, upRatio: 0, overallChange: 0 };
  
  // Count consecutive naik samples
  let upCount = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].price > samples[i - 1].price) upCount++;
  }
  
  const upRatio = (upCount / (samples.length - 1)) * 100;
  const overallChange = ((samples.at(-1).price - samples[0].price) / samples[0].price) * 100;
  const isUptrend = upRatio >= uptrendRatioPct && overallChange >= minOverallChangePct;
  
  return { isUptrend, upRatio, overallChange };
}

export function risingCandidates(histories, { now = Date.now(), windowMs = 15 * 60_000, thresholdPct = 1 } = {}) {
  if (!(windowMs > 0) || !(thresholdPct > 0)) return [];
  const output = [];
  for (const [symbol, points] of histories) {
    const samples = points.filter(point => now - point.at <= windowMs && now >= point.at);
    if (samples.length < 2) continue;
    const first = samples[0].price;
    const latest = samples.at(-1).price;
    if (!(first > 0) || !(latest > 0)) continue;
    const changePct = ((latest - first) / first) * 100;
    if (changePct >= thresholdPct) {
      const uptrend = detectUptrend(samples);
      output.push({ symbol, changePct, price: latest, observedAt: samples.at(-1).at, isUptrend: uptrend.isUptrend, upRatio: uptrend.upRatio, overallChange: uptrend.overallChange });
    }
  }
  return output.sort((a, b) => b.changePct - a.changePct);
}
