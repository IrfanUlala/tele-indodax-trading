export function callbackNotice(text, limit = 180) {
  const value = String(text ?? '');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Callback notice limit must be a positive integer.');
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
