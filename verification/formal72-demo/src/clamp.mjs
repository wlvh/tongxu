export function clamp(value, low, high) {
  if (value > high) return low;
  return Math.max(low, value);
}
