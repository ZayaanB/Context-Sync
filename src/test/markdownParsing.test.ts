import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseContextMarkdown,
  parseFrontmatter,
  parseArray,
  extractSection,
  extractList,
  extractWikilinks,
  sanitiseField,
  tokenise,
} from '../context/markdownParsing';

const SAMPLE = [
  '---',
  'id: alice_2025-01-15_ab12',
  'author: alice',
  'topic: "How should we structure the auth middleware"',
  'tags: [auth, backend, TypeScript]',
  'created: 2025-01-15T10:32:00Z',
  '---',
  '',
  '## Summary',
  'Decided to use JWT with refresh token rotation.',
  '',
  '## Key Decisions',
  '- JWT with 15min expiry',
  '- Auth middleware lives in /packages/auth',
  '',
  '## Context Links',
  '- [[chat_bob_2025-01-14_003]]',
].join('\n');

test('parseContextMarkdown parses a full file', () => {
  const file = parseContextMarkdown(SAMPLE, 'chat_alice.md', new Date(0));
  assert.ok(file);
  assert.equal(file.username, 'alice');
  assert.equal(file.topic, 'How should we structure the auth middleware');
  assert.deepEqual(file.tags, ['auth', 'backend', 'typescript']);
  assert.equal(file.summary, 'Decided to use JWT with refresh token rotation.');
  assert.deepEqual(file.keyDecisions, [
    'JWT with 15min expiry',
    'Auth middleware lives in /packages/auth',
  ]);
  assert.deepEqual(file.links, ['chat_bob_2025-01-14_003']);
  assert.ok(file.tokens.includes('auth'));
  assert.ok(file.tokens.includes('jwt'));
});

test('parseContextMarkdown handles crlf line endings', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const file = parseContextMarkdown(crlf, 'chat_alice.md', new Date(0));
  assert.ok(file);
  assert.equal(file.username, 'alice');
  assert.equal(file.summary, 'Decided to use JWT with refresh token rotation.');
});

test('parseContextMarkdown rejects files without frontmatter', () => {
  assert.equal(parseContextMarkdown('# just a doc', 'a.md', new Date(0)), null);
});

test('parseFrontmatter splits on the first colon only', () => {
  const fm = parseFrontmatter('created: 2025-01-15T10:32:00Z\nnope');
  assert.equal(fm['created'], '2025-01-15T10:32:00Z');
  assert.equal(Object.keys(fm).length, 1);
});

test('parseArray lowercases and trims entries', () => {
  assert.deepEqual(parseArray('[Auth,  Backend , ]'), ['auth', 'backend']);
});

test('parseArray strips unsafe characters and caps count and length', () => {
  assert.deepEqual(parseArray('[au`th, {jwt}, <x>]'), ['auth', 'jwt', 'x']);
  assert.equal(parseArray(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length, 10);
  assert.equal(parseArray(`[${'x'.repeat(100)}]`)[0].length, 40);
});

test('extractSection stops at the next heading', () => {
  const body = '## Summary\nfirst\n\n## Key Decisions\n- x';
  assert.equal(extractSection(body, 'Summary'), 'first');
});

test('extractList keeps only list items', () => {
  const body = '## Key Decisions\n- one\nnot a list item\n- two';
  assert.deepEqual(extractList(body, 'Key Decisions'), ['one', 'two']);
});

test('extractWikilinks finds all links', () => {
  assert.deepEqual(extractWikilinks('see [[a]] and [[b]]'), ['a', 'b']);
});

test('sanitiseField strips injectable characters and caps length', () => {
  assert.equal(sanitiseField('a`<b>`{c}[d]\\e\n\nf', 100), 'abcde f');
  assert.equal(sanitiseField('x'.repeat(50), 10).length, 10);
});

test('tokenise drops stop words and short words', () => {
  assert.deepEqual(tokenise('How should we use the JWT auth?'), ['jwt', 'auth']);
});
