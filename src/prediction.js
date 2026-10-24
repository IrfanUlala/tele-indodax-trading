export function marketOutlook(samples, windowMs = 15 * 60_000, minMovePct = 0.2) {
  const now = samples.at(-1)?.at;
  if (!Number.isFinite(now)) return { direction: 'BELUM CUKUP DATA', changePct: null, reason: 'Belum ada observasi harga.' };
  const recent = samples.filter(item => Number.isFinite(item.price) && item.price > 0 && now - item.at <= windowMs);
  if (recent.length < 3) return { direction: 'BELUM CUKUP DATA', changePct: null, reason: 'Menunggu setidaknya 3 observasi dalam 15 menit.' };
  const changePct = ((recent.at(-1).price - recent[0].price) / recent[0].price) * 100;
  if (changePct >= minMovePct) return { direction: 'CENDERUNG NAIK', changePct, reason: 'Harga bergerak naik pada jendela observasi 15 menit.' };
  if (changePct <= -minMovePct) return { direction: 'CENDERUNG TURUN', changePct, reason: 'Harga bergerak turun pada jendela observasi 15 menit.' };
  return { direction: 'NETRAL / SIDEWAYS', changePct, reason: 'Perubahan belum melewati ambang arah.' };
}
