/**
 * Normalise a UK phone number to E.164 format (+44...).
 *
 * Rules applied in order:
 *  1. Strip all whitespace, dashes, dots, parentheses
 *  2. If starts with 07  → replace leading 0  with +44
 *  3. If starts with 7   → prepend +44
 *  4. If starts with 44  → prepend +
 *  5. If already starts with +44 → leave as-is
 *  6. Any other number   → return as-is (non-UK, leave for caller to decide)
 */
function normalisePhone(raw) {
  if (!raw) return raw;

  // Strip formatting characters
  let n = String(raw).replace(/[\s\-().]/g, '');

  // Already correct E.164
  if (n.startsWith('+44')) return n;

  // 44XXXXXXXXXX → +44XXXXXXXXXX
  if (n.startsWith('44')) return `+${n}`;

  // 07XXXXXXXXX → +447XXXXXXXXX
  if (n.startsWith('07')) return `+44${n.slice(1)}`;

  // 7XXXXXXXXX (10 digits) → +447XXXXXXXXX
  if (n.startsWith('7') && n.length >= 10) return `+44${n}`;

  return n;
}

module.exports = normalisePhone;
