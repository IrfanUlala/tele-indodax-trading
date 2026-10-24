export function percentChange(entryPrice, price) {
  if (!(Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(price) && price > 0)) return null;
  return ((price - entryPrice) / entryPrice) * 100;
}

export function nextMovementAlert(changePct, lastNotifiedPct, stepPct = 0.5) {
  if (!Number.isFinite(changePct) || !Number.isFinite(stepPct) || stepPct <= 0) return null;
  const tier = Math.trunc(changePct / stepPct);
  if (tier === 0 || tier === lastNotifiedPct) return null;
  return tier;
}
