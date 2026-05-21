/**
 * Shared helpers for regex-based source scanners.
 */

/** 1-based line number at a character index in file content. */
export function lineAt(content: string, index: number): number {
  if (index <= 0) return 1;
  return content.slice(0, index).split('\n').length;
}

/** Line number for a RegExp match, when `index` is present. */
export function lineFromMatch(content: string, match: RegExpMatchArray): number | undefined {
  const idx = match.index;
  return idx === undefined ? undefined : lineAt(content, idx);
}

export function matchAll(content: string, source: string, flags = 'gi'): RegExpMatchArray[] {
  return [...content.matchAll(new RegExp(source, flags))];
}

/** Non-global pattern test with 1-based line of first hit. */
export function testHit(
  pattern: RegExp,
  content: string,
): { hit: boolean; line?: number } {
  const flags = pattern.flags.replace(/g/g, '');
  const re = new RegExp(pattern.source, flags);
  const m = re.exec(content);
  if (!m || m.index === undefined) return { hit: false };
  return { hit: true, line: lineAt(content, m.index) };
}

/** Extract a route path from a human-readable artifact detail string. */
export function pathFromRouteDetail(detail: string): string | undefined {
  const quoted = detail.match(/['"`](\/[^'"`\s]+)['"`]/);
  if (quoted?.[1]) return quoted[1];
  const methodPath = detail.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,)]+)/i);
  if (methodPath?.[1]) return methodPath[1];
  const parenPath = detail.match(/\(\s*(\/[^\s,)]+)\s*[,)]/);
  if (parenPath?.[1]) return parenPath[1];
  return undefined;
}
