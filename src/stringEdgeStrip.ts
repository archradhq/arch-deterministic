/**
 * Linear-time trimming of repeated edge characters (avoids polynomial ReDoS on
 * patterns like `/^-+|-+$/` when applied to uncontrolled strings).
 */
export const MAX_UNTRUSTED_STRING_LEN = 8192;

export function stripLeadingTrailingHyphens(s: string, maxLen = MAX_UNTRUSTED_STRING_LEN): string {
  const t = s.length <= maxLen ? s : s.slice(0, maxLen);
  let i = 0;
  let j = t.length;
  while (i < j && t[i] === '-') i++;
  while (j > i && t[j - 1] === '-') j--;
  return t.slice(i, j);
}

export function stripLeadingTrailingUnderscores(s: string, maxLen = MAX_UNTRUSTED_STRING_LEN): string {
  const t = s.length <= maxLen ? s : s.slice(0, maxLen);
  let i = 0;
  let j = t.length;
  while (i < j && t[i] === '_') i++;
  while (j > i && t[j - 1] === '_') j--;
  return t.slice(i, j);
}
