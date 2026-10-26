export function marketOutlook(samples, windowMs = 15 * 60_000, minMovePct = 0.2) {
  const now = samples.at(-1)?.at;
  if (!Number.isFinite(now)) return { direction: 'BELUM CUKUP DATA', changePct: null, reason: 'Belum ada observasi harga.' };
  const recent = samples.filter(item => Number.isFinite(item.price) && item.price > 0 && now - item.at <= windowMs);
  if (recent.length < 3) return { direction: 'BELUM CUKUP DATA', changePct: null, reason: 'Menunggu setidaknya 3 observasi dalam 15 menit.' };
  
  const changePct = ((recent.at(-1).price - recent[0].price) / recent[0].price) * 100;
  
  // Trend consistency: check if all consecutive samples are rising or falling
  let allRising = true, allFalling = true;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price <= recent[i - 1].price) allRising = false;
    if (recent[i].price >= recent[i - 1].price) allFalling = false;
  }
  
  // Only declare NAIK/TURUN if: (1) threshold met AND (2) trend consistent
  if (changePct >= minMovePct && allRising) {
    return { direction: 'CENDERUNG NAIK', changePct, reason: `Harga bergerak naik konsisten (${recent.length} sample beruntun naik).` };
  }
  if (changePct <= -minMovePct && allFalling) {
    return { direction: 'CENDERUNG TURUN', changePct, reason: `Harga bergerak turun konsisten (${recent.length} sample beruntun turun).` };
  }
  
  // If threshold met but trend NOT consistent, report as NETRAL
  if (Math.abs(changePct) >= minMovePct) {
    return { direction: 'NETRAL / SIDEWAYS', changePct, reason: `Perubahan ${changePct.toFixed(2)}% tapi trend tidak konsisten (mixed up/down). Abaikan noise.` };
  }
  
  return { direction: 'NETRAL / SIDEWAYS', changePct, reason: 'Perubahan belum melewati ambang arah.' };
}
