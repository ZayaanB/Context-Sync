import { ContextFile } from '../types';

export function parseContextMarkdown(raw: string, filename: string, modifiedAt: Date): ContextFile | null {
  // normalise crlf so windows synced files parse
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatterMatch) return null;

  const fm = parseFrontmatter(frontmatterMatch[1]);
  const body = text.slice(frontmatterMatch[0].length).trim();

  const topic = sanitiseField(decodeTopic(fm['topic'] ?? ''), 120);
  const tags = parseArray(fm['tags'] ?? '');
  const summary = sanitiseField(extractSection(body, 'Summary'), 300);
  const keyDecisions = extractList(body, 'Key Decisions').map((d) => sanitiseField(d, 120));
  const links = extractWikilinks(body);

  return {
    filename,
    username: fm['author'] ?? 'unknown',
    topic,
    tags,
    summary,
    keyDecisions,
    links,
    modifiedAt,
    tokens: [...new Set(tokenise([...tags, topic, summary, ...keyDecisions].join(' ')))],
  };
}

export function parseFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

// tags reach prompts and yaml so allowlist characters and cap size
export function parseArray(value: string): string[] {
  return value
    .replace(/[\[\]]/g, '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}_+#\- ]/gu, '').slice(0, 40))
    .filter(Boolean)
    .slice(0, 10);
}

export function extractSection(body: string, heading: string): string {
  const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  return body.match(regex)?.[1]?.trim() ?? '';
}

export function extractList(body: string, heading: string): string[] {
  return extractSection(body, heading)
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

export function extractWikilinks(body: string): string[] {
  return (body.match(/\[\[([^\]]+)\]\]/g) ?? []).map((m) => m.replace(/\[\[|\]\]/g, ''));
}

// Plain text normalization is not a prompt-injection security boundary.
export function sanitiseField(text: string, maxLen: number): string {
  return truncateText(text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim(), maxLen);
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return '';
  let end = maxLen - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const prefix = text.slice(0, end);
  const boundary = prefix.search(/\s+\S*$/u);
  return (boundary > end / 2 ? prefix.slice(0, boundary) : prefix).trimEnd() + '…';
}

function decodeTopic(value: string): string {
  if (value.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(value); if (typeof decoded === 'string') return decoded; } catch { /* accept legacy plain fields */ }
  }
  return value.replace(/^['"]|['"]$/g, '');
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'is', 'it', 'this', 'that', 'how', 'what',
  'should', 'we', 'i', 'my', 'do', 'be', 'use', 'can', 'are',
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_+#-]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => (w.length > 2 || /[+#]|[^\x00-\x7f]/u.test(w)) && !STOP_WORDS.has(w));
}
