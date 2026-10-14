/**
 * Text without its `[^n]` footnote markers, for a place the sources do not travel to: a pasted
 * answer, or a comment the co-author posts.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/[ \t]*\[\^\d+\]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
