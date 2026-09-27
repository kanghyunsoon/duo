/**
 * Search terms shared by seed resolution and relevance (TASK-010, T10.1): lower-case, camelCase
 * and snake_case split, stopwords removed; Hangul stays in whitespace units (05).
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "from", "is", "are", "be", "as", "it", "this", "that",
  "implement", "implementation", "add", "fix", "update", "make", "use", "support", "change", "task", "new",
]);

export function searchTerms(text: string): string[] {
  const spaced = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  return spaced.split(/[^\p{L}\p{N}]+/u).map((t) => t.toLowerCase()).filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/u.test(t));
}
