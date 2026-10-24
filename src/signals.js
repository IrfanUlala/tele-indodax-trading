export function calculateSignal(history, thresholdPct = 1) {
  if (history.length < 2) return { type: 'WAIT', changePct: 0, reason: 'Belum cukup data untuk membandingkan harga.' };
  const first = history[0].price;
  const latest = history.at(-1).price;
  if (!(first > 0) || !(latest > 0)) return { type: 'WAIT', changePct: 0, reason: 'Data harga tidak valid.' };
  const changePct = ((latest - first) / first) * 100;
  if (changePct >= thresholdPct) return { type: 'WATCH_BUY', changePct, reason: `Momentum naik ${changePct.toFixed(2)}%; ini sinyal pantauan, bukan rekomendasi atau order.` };
  if (changePct <= -thresholdPct) return { type: 'WATCH_SELL', changePct, reason: `Momentum turun ${changePct.toFixed(2)}%; evaluasi risiko/posisi, bukan order jual.` };
  return { type: 'HOLD', changePct, reason: `Perubahan ${changePct.toFixed(2)}% belum melewati ambang.` };
}
