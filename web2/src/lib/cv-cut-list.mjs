/**
 * cv-cut-list.mjs — the ranked cut list a tailored CV carries so the backend can
 * shrink it to its page budget one step at a time.
 *
 * The agent tailors the CV once and cannot see how many pages it renders to, so
 * it marks every place the CV could be shortened, ranked from "absolutely
 * remove" (1) to "good to have" (highest). The renderer then applies the cuts in
 * rank order, re-rendering after each, and stops at the first render that fits.
 *
 * Marker grammar (HTML comments, so an unapplied CV renders unchanged):
 *   remove:  <!--cut:N-->CONTENT<!--/cut:N-->
 *   shorten: <!--cut:N-->CONTENT<!--cut-short-->SHORTER<!--/cut:N-->
 * N is a positive integer; several cuts may share a rank and are applied
 * together. Cuts never nest. Comments are used because generate-pdf.mjs's own
 * section markers require a space after `<!--`, so the two cannot collide.
 */

const CUT_RE = /<!--cut:(\d+)-->([\s\S]*?)<!--\/cut:\1-->/g;
const SHORT_MARKER = "<!--cut-short-->";

/**
 * The distinct cut ranks the CV carries, in the order they are applied.
 * @param {string} html
 * @returns {number[]}
 */
export function cutRanks(html) {
  const ranks = new Set();
  for (const match of html.matchAll(CUT_RE)) ranks.add(Number(match[1]));
  return [...ranks].sort((a, b) => a - b);
}

/**
 * The CV with every cut ranked at or below `throughRank` applied, and every
 * marker removed. `throughRank` 0 applies nothing and only strips the markers.
 * @param {string} html
 * @param {number} throughRank
 * @returns {string}
 */
export function applyCutsThrough(html, throughRank) {
  return html.replace(CUT_RE, (_whole, rank, body) => {
    const shortAt = body.indexOf(SHORT_MARKER);
    const full = shortAt === -1 ? body : body.slice(0, shortAt);
    if (Number(rank) > throughRank) return full;
    return shortAt === -1 ? "" : body.slice(shortAt + SHORT_MARKER.length);
  });
}
