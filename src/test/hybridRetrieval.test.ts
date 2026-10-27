import { config, modelState, CancellationTokenSource } from './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextManager } from '../context/ContextManager';
import { ChatHandler } from '../chat/ChatHandler';
import type * as vscode from 'vscode';

interface Fixture { name: string; topic: string; summary?: string; tags?: string[]; links?: string[]; }
interface Record { source: string; facts: string[]; via?: string[]; distance?: number; }
const markdown = (note: Fixture) => [
  '---', `topic: ${JSON.stringify(note.topic)}`, `tags: ${JSON.stringify(note.tags ?? ['auth'])}`, '---',
  '## Summary', note.summary ?? 'A supporting engineering decision.',
  '## Related Conversations', ...(note.links ?? []).map(link => `- [[${link}]]`),
].join('\n');
async function setup(files: Fixture[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-hybrid-test-'));
  await Promise.all(files.map(note => writeFile(path.join(dir, note.name), markdown(note))));
  const manager = new ContextManager();
  await manager.loadFromFolder(dir);
  return { manager, dir };
}
const records = (block: string): Record[] => block ? block.split('\n').map(line => JSON.parse(line)) : [];
function settings(overrides: { [key: string]: unknown }, run: () => Promise<void>): Promise<void> {
  const previous = { ...config };
  Object.assign(config, { retrievalMode: 'hybrid', maxContextFiles: 2, maxContextBytes: 4096, maxGraphDistance: 4, maxGraphNodes: 200 }, overrides);
  return run().finally(() => { for (const key of Object.keys(config)) delete config[key]; Object.assign(config, previous); });
}
const pair: Fixture[] = [
  { name: 'seed.md', topic: 'JWT rotation policy', links: ['custody'] },
  { name: 'custody.md', topic: 'Key custody', summary: 'Signing material stays in the managed vault.' },
  { name: 'distractor.md', topic: 'JWT discussion', summary: 'A separate troubleshooting conversation.' },
];

test('hybrid retrieves linked supporting facts without keyword overlap and keeps the best lexical anchor', () => settings({}, async () => {
  const { manager } = await setup(pair);
  config.retrievalMode = 'lexical';
  assert.deepEqual(records(manager.buildContextBlock('jwt rotation policy')).map(note => note.source), ['seed.md', 'distractor.md']);
  config.retrievalMode = 'hybrid';
  const selected = records(manager.buildContextBlock('jwt rotation policy'));
  assert.deepEqual(selected.map(note => note.source), ['seed.md', 'custody.md']);
  assert.deepEqual(selected[1].via, ['seed.md', 'custody.md']);
  assert.equal(selected[1].distance, 1);
  assert.match(selected[1].facts.join(' '), /managed vault/);
}));

test('hybrid follows backlinks when only the supporting note links to the lexical seed', () => settings({}, async () => {
  const { manager } = await setup([pair[0], { ...pair[1], links: ['seed'] }].map(note => note.name === 'seed.md' ? { ...note, links: [] } : note));
  assert.deepEqual(records(manager.buildContextBlock('jwt rotation')).map(note => note.source), ['seed.md', 'custody.md']);
}));

test('hybrid retrieves a multi-hop chain and returns its source path', () => settings({ maxContextFiles: 5 }, async () => {
  const { manager } = await setup([
    { name: 'seed.md', topic: 'Cache invalidation', tags: ['redis'], links: ['lease'] },
    { name: 'lease.md', topic: 'Lease coordination', tags: ['redis'], links: ['fencing'] },
    { name: 'fencing.md', topic: 'Worker generations', tags: ['redis'], summary: 'Reject writes from workers with an older generation.' },
  ]);
  const selected = records(manager.buildContextBlock('cache invalidation'));
  assert.deepEqual(selected.map(note => note.source), ['seed.md', 'lease.md', 'fencing.md']);
  assert.deepEqual(selected[2].via, ['seed.md', 'lease.md', 'fencing.md']);
  assert.equal(selected[2].distance, 2);
}));

test('weighted traversal chooses the stronger-tag link before a more recent weak link', () => settings({}, async () => {
  const { manager } = await setup([
    { name: 'seed.md', topic: 'Cache invalidation', tags: ['redis', 'backend'], links: ['weak', 'strong'] },
    { name: 'weak.md', topic: 'Interface colors', tags: ['frontend'] },
    { name: 'strong.md', topic: 'Lease coordination', tags: ['redis', 'backend'] },
  ]);
  assert.deepEqual(records(manager.buildContextBlock('cache invalidation')).map(note => note.source), ['seed.md', 'strong.md']);
}));

test('no lexical seed, no links, disabled traversal and a one-file budget fall back safely', () => settings({}, async () => {
  const { manager } = await setup(pair);
  assert.equal(manager.buildContextBlock('unrelated'), '');
  config.maxGraphDistance = 0;
  assert.deepEqual(records(manager.buildContextBlock('jwt rotation')).map(note => note.source), ['seed.md', 'distractor.md']);
  config.maxGraphDistance = 4; config.maxContextFiles = 1;
  assert.deepEqual(records(manager.buildContextBlock('jwt rotation')).map(note => note.source), ['seed.md']);
  const noLinks = await setup(pair.map(note => ({ ...note, links: [] })));
  config.maxContextFiles = 2;
  const hybrid = noLinks.manager.buildContextBlock('jwt rotation');
  config.retrievalMode = 'lexical';
  assert.equal(hybrid, noLinks.manager.buildContextBlock('jwt rotation'));
}));

test('graph cache invalidates after link edits, deletes, recreation and vault switches', () => settings({}, async () => {
  const { manager, dir } = await setup(pair);
  assert.ok(records(manager.buildContextBlock('jwt rotation')).some(note => note.source === 'custody.md'));
  await writeFile(path.join(dir, 'seed.md'), markdown({ ...pair[0], links: [] }));
  await manager.updateFile(path.join(dir, 'seed.md'), 'seed.md');
  assert.ok(!records(manager.buildContextBlock('jwt rotation')).some(note => note.source === 'custody.md'));
  await writeFile(path.join(dir, 'seed.md'), markdown(pair[0]));
  await manager.updateFile(path.join(dir, 'seed.md'), 'seed.md');
  manager.removeFile('custody.md');
  assert.ok(!records(manager.buildContextBlock('jwt rotation')).some(note => note.source === 'custody.md'));
  await manager.updateFile(path.join(dir, 'custody.md'), 'custody.md');
  assert.ok(records(manager.buildContextBlock('jwt rotation')).some(note => note.source === 'custody.md'));
  const other = await setup([{ name: 'elsewhere.md', topic: 'JWT rotation' }]);
  await manager.loadFromFolder(other.dir);
  assert.deepEqual(records(manager.buildContextBlock('jwt rotation')).map(note => note.source), ['elsewhere.md']);
  manager.clear(); assert.equal(manager.buildContextBlock('jwt rotation'), '');
}));

test('a changed tag weight invalidates the cached graph', () => settings({}, async () => {
  const { manager, dir } = await setup([
    { name: 'seed.md', topic: 'Cache invalidation', tags: ['redis'], links: ['one', 'two'] },
    { name: 'one.md', topic: 'Lease coordination', tags: ['redis'] },
    { name: 'two.md', topic: 'Worker generations', tags: ['other'] },
  ]);
  assert.equal(records(manager.buildContextBlock('cache invalidation'))[1].source, 'one.md');
  await writeFile(path.join(dir, 'one.md'), markdown({ name: 'one.md', topic: 'Lease coordination', tags: ['other'] }));
  await manager.updateFile(path.join(dir, 'one.md'), 'one.md');
  await writeFile(path.join(dir, 'two.md'), markdown({ name: 'two.md', topic: 'Worker generations', tags: ['redis'] }));
  await manager.updateFile(path.join(dir, 'two.md'), 'two.md');
  assert.equal(records(manager.buildContextBlock('cache invalidation'))[1].source, 'two.md');
}));

test('node limits bound expansion and fallback lexical notes fill remaining slots without duplicates', () => settings({ maxGraphNodes: 1 }, async () => {
  const { manager } = await setup(pair);
  const selected = records(manager.buildContextBlock('jwt rotation'));
  assert.deepEqual(selected.map(note => note.source), ['seed.md', 'distractor.md']);
  config.maxGraphNodes = 200; config.maxContextFiles = 5;
  const expanded = records(manager.buildContextBlock('jwt rotation'));
  assert.equal(new Set(expanded.map(note => note.source)).size, expanded.length);
}));

test('UTF-8 byte budgets count separators and preserve complete JSON and facts in both modes', () => settings({ maxContextFiles: 5, maxContextBytes: 768 }, async () => {
  const summary = '保留完整的技术决定和上下文。'.repeat(5);
  const { manager } = await setup([
    { name: 'seed.md', topic: 'JWT architecture rotation', summary, links: ['support'] },
    { name: 'support.md', topic: 'Key custody', summary },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `note_${i}.md`, topic: 'JWT architecture', summary })),
  ]);
  for (const mode of ['lexical', 'hybrid']) {
    config.retrievalMode = mode;
    const block = manager.buildContextBlock('jwt architecture rotation');
    assert.ok(Buffer.byteLength(block, 'utf8') <= 768);
    const selected = records(block);
    assert.ok(selected.length > 0 && selected.length < 5);
    assert.ok(selected.every(note => note.facts[0] === summary));
    if (mode === 'hybrid') assert.ok(selected.some(note => note.via !== undefined));
  }
}));

test('lexical stays the default when a noisy link would displace a relevant direct match', () => settings({}, async () => {
  const { manager } = await setup([
    { name: 'seed.md', topic: 'API retries policy', links: ['noise'] },
    { name: 'retry.md', topic: 'Retries backoff', summary: 'Use exponential delays for transient errors.' },
    { name: 'noise.md', topic: 'Brand palette', summary: 'Use blue for the logo.', tags: ['design'] },
  ]);
  delete config.retrievalMode;
  assert.deepEqual(records(manager.buildContextBlock('api retries policy')).map(note => note.source), ['seed.md', 'retry.md']);
  config.retrievalMode = 'hybrid';
  assert.deepEqual(records(manager.buildContextBlock('api retries policy')).map(note => note.source), ['seed.md', 'noise.md']);
}));

test('file count and byte limits cannot be bypassed by invalid or extreme settings', () => settings({ maxContextFiles: 999, maxContextBytes: NaN, maxGraphDistance: Infinity }, async () => {
  const { manager } = await setup(Array.from({ length: 60 }, (_, i) => ({ name: `n${i}.md`, topic: 'JWT', summary: 'Decision' })));
  const selected = records(manager.buildContextBlock('jwt'));
  assert.ok(selected.length <= 50);
  assert.ok(Buffer.byteLength(manager.buildContextBlock('jwt')) <= 4096);
}));

test('chat prompt assembly uses the configured hybrid retrieval and its source evidence', () => settings({}, async () => {
  const { manager } = await setup(pair);
  const handler = new ChatHandler(manager, {} as vscode.SecretStorage);
  const turns = (handler as unknown as { _buildTurns: (session: unknown) => unknown })._buildTurns({ messages: [{ role: 'user', content: 'jwt rotation policy' }] });
  assert.match(JSON.stringify(turns), /managed vault/);
  assert.match(JSON.stringify(turns), /custody.md/);
}));

test('graph-enriched requests still enforce the selected model input budget before sending', () => settings({}, async () => {
  const { manager } = await setup(pair);
  const sent: Array<Array<{ content: string }>> = [];
  const model = {
    id: 'hybrid-test-model', name: 'test', vendor: 'test', family: 'test', maxInputTokens: 200,
    countTokens: async (message: { content: string }) => Buffer.byteLength(message.content),
    sendRequest: async (messages: Array<{ content: string }>) => { sent.push(messages); return { text: (async function* () { yield 'ok'; })() }; },
  };
  const previous = modelState.models;
  const cancellation = new CancellationTokenSource();
  modelState.models = [model];
  try {
    const handler = new ChatHandler(manager, { get: async () => undefined } as unknown as vscode.SecretStorage);
    const session = { id: 'alice_test', username: 'alice', startedAt: new Date(0).toISOString(), selectedModel: model.id,
      messages: [{ role: 'user' as const, content: 'jwt rotation policy', timestamp: new Date(0).toISOString() }] };
    await handler.sendMessage(session, cancellation.token as vscode.CancellationToken);
    assert.ok(sent[0].reduce((sum, message) => sum + Buffer.byteLength(message.content) + 8, 0) <= 150);
    assert.equal(sent[0][sent[0].length - 1].content, 'jwt rotation policy');
    model.maxInputTokens = 10000;
    await handler.sendMessage(session, cancellation.token as vscode.CancellationToken);
    assert.match(JSON.stringify(sent[1]), /managed vault/);
  } finally { modelState.models = previous; cancellation.dispose(); }
}));

test('tight budgets bound passage-rendering work when many matching notes cannot fit', () => settings({ maxContextBytes: 512 }, async () => {
  const { manager } = await setup(Array.from({ length: 100 }, (_, i) => ({
    name: `n${i}.md`, topic: 'JWT', summary: '保留完整的技术决定和上下文。'.repeat(15),
  })));
  const internal = manager as unknown as { _renderCandidate: (...args: unknown[]) => string | undefined };
  const render = internal._renderCandidate.bind(manager);
  let attempts = 0;
  internal._renderCandidate = (...args) => { attempts++; return render(...args); };
  assert.equal(manager.buildContextBlock('jwt'), '');
  assert.ok(attempts <= 20);
}));
