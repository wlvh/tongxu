export function normalizeLabel(value, fallback = 'Untitled') {
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}
