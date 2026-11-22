/**
 * A job saved from pasted text has no posting link. It is keyed by its saved
 * job description instead, in the `local:jds/{file}` form AGENTS.md uses for
 * JD references in pipeline.md. Pure, so the board's client code can use it.
 */
export function isPastedRef(url: string): boolean {
  return url.startsWith(PASTED_REF_PREFIX);
}

/** The jds/ file name (without .md) a pasted job's reference points at. */
export function pastedRefFileStem(url: string): string {
  return url.slice(LOCAL_JDS_PREFIX.length).replace(/\.md$/, "");
}

export const LOCAL_JDS_PREFIX = "local:jds/";
export const PASTED_FILE_PREFIX = "web2-pasted-";
export const PASTED_REF_PREFIX = `${LOCAL_JDS_PREFIX}${PASTED_FILE_PREFIX}`;
