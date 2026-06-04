/**
 * Normalise a UK phone number to E.164 format (+44...).
 *
 * Rules applied in order:
 *  1. Strip all whitespace, dashes, dots, parentheses
 *  2. If starts with 07  → replace leading 0 with +44
 *  3. If starts with 7   → prepend +44
 *  4. If starts with 44  → prepend +
 *  5. If already starts with +44 → leave as-is
 *  6. Any other → return as-is (non-UK)
 */
function normalisePhone(raw) {
  if (!raw) return raw;

  let n = String(raw).replace(/[\s\-().]/g, '');

  if (n.startsWith('+44')) return n;
  if (n.startsWith('44'))  return `+${n}`;
  if (n.startsWith('07'))  return `+44${n.slice(1)}`;
  if (n.startsWith('7') && n.length >= 10) return `+44${n}`;

  return n;
}

/**
 * Validate that a number is a dialable UK mobile.
 *
 * After normalisation the number must:
 *  - Start with +44
 *  - Have 7 as the first digit after the country code (+447...)
 *  - Be exactly 13 characters long (+44 + 10 digits)
 *
 * Returns { valid: true, number, reason: null }
 *      or { valid: false, number, reason: '...' }
 */
function validatePhone(raw) {
  if (!raw || !String(raw).trim()) {
    return { valid: false, number: raw, reason: 'No phone number provided' };
  }

  const normalised = normalisePhone(raw);

  // Must be E.164 UK mobile: +447XXXXXXXXX (13 chars)
  if (!normalised.startsWith('+447')) {
    return {
      valid: false,
      number: normalised,
      reason: `Number does not start with 7 after country code — skipped (got: ${normalised})`,
    };
  }

  if (normalised.length !== 13) {
    return {
      valid: false,
      number: normalised,
      reason: `Invalid UK mobile length (expected 13 digits, got ${normalised.length}) — skipped`,
    };
  }

  return { valid: true, number: normalised, reason: null };
}

module.exports = normalisePhone;
module.exports.validatePhone = validatePhone;
