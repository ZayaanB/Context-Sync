import { ContextFile } from '../types';

export function parseContextMarkdown(raw: string, filename: string, modifiedAt: Date): ContextFile | null {
  // normalise crlf so windows synced files parse
  const text = raw.replace(/\r\n/g, '\n');

  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const fm = parseFrontmatter(frontmatterMatch[1]);
  const body = text.slice(frontmatterMatch[0].length).trim();

  const topic = sanitiseField((fm['topic'] ?? '').replace(/^"|"$/g, ''), 120);
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
    tokens: [...tags, ...tokenise(topic), ...tokenise(summary)],
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
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '').slice(0, 40))
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

// strip prompt-injectable characters and cap length
export function sanitiseField(text: string, maxLen: number): string {
  return text
    .replace(/[`<>{}[\]\\]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, maxLen)
    .trim();
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'is', 'it', 'this', 'that', 'how', 'what',
  'should', 'we', 'i', 'my', 'do', 'be', 'use', 'can', 'are',
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}
