/**
 * Which option of an open combobox menu the fill step may click for an answer.
 *
 * An exact label (trimmed, case-insensitive) wins. Otherwise only a whole-word
 * match is accepted, and only when exactly one option has it: a substring
 * match let "US" click "Australia" and "Male" click "Female". -1 means leave
 * the field for the person.
 */

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * @param {string[]} optionTexts
 * @param {string} value
 * @returns {number}
 */
export function pickComboboxOption(optionTexts, value) {
  const want = norm(value);
  if (!want) return -1;
  const texts = optionTexts.map(norm);
  const exact = texts.indexOf(want);
  if (exact >= 0) return exact;
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u");
  const hits = texts.flatMap((t, i) => (word.test(t) ? [i] : []));
  return hits.length === 1 ? hits[0] : -1;
}

/**
 * Fallback for a place type-ahead after typing only the city: the one option
 * whose city is the answer's city and whose last part is the answer's country,
 * so "Toronto, ON, Canada" picks "Toronto, Ontario, Canada" and never Toronto,
 * Ohio. Returns -1 when the answer has no country part or the pick is not unique.
 * @param {string[]} optionTexts
 * @param {string} value
 * @returns {number}
 */
export function pickPlaceOption(optionTexts, value) {
  const parts = placeParts(value);
  if (parts.length < 2) return -1;
  const city = parts[0];
  const country = parts[parts.length - 1];
  const hits = optionTexts.flatMap((text, index) => {
    const option = placeParts(text);
    return option[0] === city && option[option.length - 1] === country ? [index] : [];
  });
  return hits.length === 1 ? hits[0] : -1;
}

/** The city of a place answer: the text before its first comma. */
export function placeCity(value) {
  return String(value ?? "").split(",")[0].trim();
}

function placeParts(text) {
  return String(text ?? "").split(",").map(norm).filter(Boolean);
}
