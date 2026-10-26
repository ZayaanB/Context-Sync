import { config, watchers, CancellationTokenSource, modelState } from './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextManager } from '../context/ContextManager';
import { FileWatcher } from '../context/FileWatcher';
import { PendingExports } from '../chat/PendingExports';
import { ChatPanel } from '../chat/ChatPanel';
import { ChatHandler } from '../chat/ChatHandler';
import { MarkdownExporter } from '../markdown/MarkdownExporter';
import { completeWithModel, listAllModels, setModelAccessInformation } from '../llm/ModelRouter';
import { selectVsCodeModel } from '../utils/ModelSelector';
import { fitPrompt } from '../llm/promptBudget';
import { completeOpenAI } from '../llm/directClients';
import { parseContextMarkdown, tokenise, sanitiseField } from '../context/markdownParsing';
import { ChatMessage, ChatSession } from '../types';
import type * as vscode from 'vscode';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const markdown = '---\ntopic: "Auth"\ntags: [auth]\n---\n## Summary\nDeploy using argon2id.\n## Key Decisions\n- Validate JWT expiry\n';
const message = (content: string, role: 'user' | 'assistant' = 'user'): ChatMessage => ({ role, content, timestamp: new Date(0).toISOString() });
const session = (): ChatSession => ({ id: 'alice_test', username: 'alice', startedAt: new Date(0).toISOString(), messages: [message('early decision'), message('early answer', 'assistant')] });
function store() {
  const values = new Map<string, unknown>();
  const memento = { keys: () => [...values.keys()], get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } } as vscode.Memento;
  return { pending: new PendingExports(memento), values, memento };
}
// Access internals only in regression tests to control asynchronous completion deterministically.
function internal(value: unknown): any { return value; }
async function manager() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-sync-test-'));
  await writeFile(path.join(dir, 'a.md'), markdown);
  const value = new ContextManager();
  await value.loadFromFolder(dir);
  return { value, dir };
}
function panel() {
  const value = internal(Object.create(ChatPanel.prototype));
  const { pending } = store();
  value._session = session(); value._destination = '/tmp/vault'; value._pending = pending;
  value._privacyMode = false; value._disposed = false; value._disposables = [];
  value._postMessage = () => undefined; value._resetInactivityTimer = () => undefined;
  value._handler = { contextManager: new ContextManager() }; value._exporter = { exportSession: async () => null };
  return value;
}

test('invalid replacement evicts previous context', async () => {
  const { value, dir } = await manager();
  await writeFile(path.join(dir, 'a.md'), 'invalid');
  await value.updateFile(path.join(dir, 'a.md'), 'a.md');
  assert.equal(value.fileCount, 0);
});

test('late read cannot resurrect a deleted file', async () => {
  const { value, dir } = await manager(); const gate = deferred<any>();
  internal(value)._parseMarkdownFile = () => gate.promise;
  const read = value.updateFile(path.join(dir, 'a.md'), 'a.md');
  value.removeFile('a.md'); gate.resolve(parseContextMarkdown(markdown, 'a.md', new Date()));
  await read; assert.equal(value.fileCount, 0);
});

test('newest file read wins over an older completion', async () => {
  const { value, dir } = await manager(); const old = deferred<any>(); let reads = 0;
  internal(value)._parseMarkdownFile = async () => ++reads === 1 ? old.promise : parseContextMarkdown(markdown.replace('Auth', 'New topic'), 'a.md', new Date());
  const read = value.updateFile(path.join(dir, 'a.md'), 'a.md');
  await value.updateFile(path.join(dir, 'a.md'), 'a.md');
  old.resolve(parseContextMarkdown(markdown, 'a.md', new Date())); await read;
  assert.match(value.buildContextBlock('topic'), /New topic/);
});

test('older folder load cannot replace a newer folder', async () => {
  const a = await manager(), b = await manager(); const started = deferred<void>(), gate = deferred<any>();
  internal(a.value)._parseMarkdownFile = async (file: string) => { if (file.startsWith(a.dir)) { started.resolve(); return gate.promise; } return parseContextMarkdown(markdown.replace('Auth', 'New vault'), 'a.md', new Date()); };
  const old = a.value.loadFromFolder(a.dir); await started.promise;
  await a.value.loadFromFolder(b.dir); gate.resolve(parseContextMarkdown(markdown, 'a.md', new Date())); await old;
  assert.match(a.value.buildContextBlock('vault'), /New vault/);
});

test('clearing the cache invalidates in-flight reads', async () => {
  const { value, dir } = await manager(); const gate = deferred<any>();
  internal(value)._parseMarkdownFile = () => gate.promise;
  const read = value.updateFile(path.join(dir, 'a.md'), 'a.md'); value.clear();
  gate.resolve(parseContextMarkdown(markdown, 'a.md', new Date())); await read; assert.equal(value.fileCount, 0);
});

test('retrieval emits summary and decision matches with sources; unrelated queries stay empty', async () => {
  const { value } = await manager();
  assert.match(value.buildContextBlock('argon2id'), /Deploy using argon2id/);
  assert.match(value.buildContextBlock('jwt'), /Validate JWT expiry/);
  assert.match(value.buildContextBlock('jwt'), /a.md/);
  assert.equal(value.buildContextBlock('unrelated'), '');
});

test('Unicode and technical identifiers survive parsing and compaction', () => {
  assert.deepEqual(tokenise('C++ C# 数据库 auth-service'), ['c++', 'c#', '数据库', 'auth-service']);
  assert.equal(sanitiseField('Array<T> C:\\src\\a', 100), 'Array<T> C:\\src\\a');
  assert.ok(!/[\uD800-\uDBFF]…$/.test(sanitiseField('abcd😀rest', 6)));
  assert.equal(parseContextMarkdown('---\ntopic: "Use \\"JWT\\""\n---', 'a.md', new Date())?.topic, 'Use "JWT"');
});

test('pending exports are snapshots and acknowledgements preserve newer revisions', async () => {
  const { pending, memento } = store(); const s = session(); await pending.put(s, '/original');
  s.messages.push(message('newer')); await pending.put(s, '/original');
  await pending.acknowledge(s.id, 2);
  assert.equal(pending.get(s.id)?.revision, 3);
  assert.equal(pending.get(s.id)?.session.exportedMessageCount, 2);
  s.messages[0].content = 'mutated'; assert.equal(pending.get(s.id)?.session.messages[0].content, 'early decision');
  assert.equal(new PendingExports(memento).get(s.id)?.destination, '/original');
});

test('pending queue keeps separate sessions and never persists private turns', async () => {
  const { pending } = store(); const a = session(); a.messages.push({ ...message('secret'), private: true });
  await pending.put(a, '/vault-a'); await pending.put({ ...session(), id: 'bob_test' }, '/vault-b');
  assert.equal(pending.list().length, 2); assert.equal(pending.get(a.id)?.revision, 2);
  assert.ok(!JSON.stringify(pending.list()).includes('secret'));
});

test('acknowledged sessions are not requeued without new messages', async () => {
  const { pending } = store(); const s = session(); await pending.put(s, '/vault'); await pending.acknowledge(s.id, 2);
  s.exportedMessageCount = 2; await pending.put(s, '/vault'); assert.equal(pending.list().length, 0);
});

test('malformed persisted queue entries are rejected', () => {
  const memento = { get: () => ({ bad: { destination: '/vault', revision: 2, session: { ...session(), id: '../escape' } } }) } as unknown as vscode.Memento;
  assert.equal(new PendingExports(memento).list().length, 0);
});

test('reset cancels a request and late replies never enter the new session', async () => {
  const p = panel(); const gate = deferred<string>();
  p._handler.sendMessage = () => gate.promise;
  const request = p._handleUserMessage('old question');
  await new Promise(resolve => setImmediate(resolve));
  await p._startNewSession(); gate.resolve('late reply'); await request;
  assert.deepEqual(p._session.messages, []);
});

test('privacy transitions start an isolated session and discard late private replies', async () => {
  const p = panel(); p._privacyMode = true; p._session.messages = [];
  const gate = deferred<string>(); p._handler.sendMessage = () => gate.promise;
  const request = p._handleUserMessage('secret'); await new Promise(resolve => setImmediate(resolve));
  await p._startNewSession(false); gate.resolve('secret echoed'); await request;
  assert.deepEqual(p._session.messages, []); assert.equal(p._pending.list().length, 0);
});

test('private reply inherits request privacy even if the flag changes', async () => {
  const p = panel(); p._privacyMode = true; p._session.messages = [];
  const gate = deferred<string>(); p._handler.sendMessage = () => gate.promise;
  const request = p._handleUserMessage('secret'); await new Promise(resolve => setImmediate(resolve));
  p._privacyMode = false; gate.resolve('secret echoed'); await request;
  assert.ok(p._session.messages.every((m: ChatMessage) => m.private));
  assert.equal(p._pending.list().length, 0);
});

test('public prompts do not replay private history', () => {
  const handler = new ChatHandler(new ContextManager(), {} as vscode.SecretStorage);
  const s = session(); s.messages.push({ ...message('secret'), private: true }, message('public followup'));
  assert.ok(!JSON.stringify(internal(handler)._buildTurns(s)).includes('secret'));
});

test('closing during an active export waits for completion even without a timer', async () => {
  const p = panel(); await p._stashPendingSession(); const gate = deferred<string>(); const started = deferred<void>();
  p._exporter.exportSession = () => { started.resolve(); return gate.promise; };
  const exporting = p._exportSession(); await started.promise;
  let flushed = false; const flush = p.flushPendingExport().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(flushed, false);
  gate.resolve('/result'); await Promise.all([exporting, flush]); assert.equal(flushed, true);
});

test('failed metadata never acknowledges pending recovery state', async () => {
  const p = panel(); await p._stashPendingSession(); p._exporter.exportSession = async () => null;
  await p._exportSession(); assert.equal(p._pending.list().length, 1);
});

test('whole-turn prompt budgeting preserves current input and rejects oversized prompts', async () => {
  const turns = [{ role: 'user' as const, content: 'old' }, { role: 'assistant' as const, content: 'reply' }, { role: 'user' as const, content: 'current 😀' }];
  assert.deepEqual(await fitPrompt(turns, 30, async () => 10), [turns[2]]);
  await assert.rejects(fitPrompt([turns[2]], 10, async () => 20), /input budget/);
});

test('already cancelled direct requests never reach the network', async () => {
  const originalFetch = globalThis.fetch; let called = false;
  globalThis.fetch = async (_input, options) => { called = true; assert.ok(options?.signal?.aborted); throw new Error('aborted'); };
  const token = new CancellationTokenSource(); token.cancel();
  try { await assert.rejects(completeOpenAI('unused', 'unused', [{ role: 'user', content: 'test' }], 10, token.token as vscode.CancellationToken)); assert.equal(called, false); }
  finally { globalThis.fetch = originalFetch; }
});

test('immutable exports retain earlier facts, skip retries, and reject invalid metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-export-test-'));
  const exporter = new MarkdownExporter(new ContextManager(), {} as vscode.SecretStorage); let calls = 0;
  internal(exporter)._extractMetadata = async (text: string) => { calls++; return { worthSaving: true, topic: 'Topic', tags: [], summary: text, keyDecisions: [], keyQuestions: [], codeReferences: [] }; };
  const s = session(); await exporter.exportSession(s, dir); await exporter.exportSession(s, dir); assert.equal(calls, 1);
  s.exportedMessageCount = 2; s.messages.push(message('new decision'), message('new answer', 'assistant')); await exporter.exportSession(s, dir);
  const files = await readdir(dir); assert.equal(files.length, 2);
  assert.ok((await Promise.all(files.map(f => readFile(path.join(dir, f), 'utf8')))).join('').includes('early decision'));
  internal(exporter)._extractMetadata = async () => null;
  s.messages.push(message('another')); await assert.rejects(exporter.exportSession(s, dir), /invalid export metadata/);
});

test('transcript chunks preserve all text and Unicode without exceeding byte limits', () => {
  const exporter = new MarkdownExporter(new ContextManager(), {} as vscode.SecretStorage);
  const chunks: string[] = internal(exporter)._buildTranscripts([message('😀'.repeat(5000))], 'alice');
  assert.ok(chunks.every(c => Buffer.byteLength(c) <= 8000));
  assert.equal(chunks.join(''), `alice: ${'😀'.repeat(5000)}\n\n`);
});

test('watcher buffers scan events, coalesces file reads, and disposes previous watchers', async () => {
  const load = deferred<void>(); let reads = 0; const deleted: string[] = [];
  const manager = { loadFromFolder: () => load.promise, updateFile: async () => { reads++; }, removeFile: (file: string) => deleted.push(file) } as unknown as ContextManager;
  const watcher = new FileWatcher(manager); const start = watcher.start('/tmp/vault'); const first = watchers[watchers.length - 1];
  first.delete?.({ fsPath: '/tmp/vault/a.md' }); first.change?.({ fsPath: '/tmp/vault/b.md' });
  load.resolve(); await start;
  first.change?.({ fsPath: '/tmp/vault/b.md' }); first.change?.({ fsPath: '/tmp/vault/b.md' });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(reads, 1); assert.deepEqual(deleted, ['a.md']);
  await watcher.start('/tmp/other'); assert.equal(first.disposed, true); watcher.stop();
});

test('stopping a watcher during initial load cannot recreate it', async () => {
  const load = deferred<void>(); let notified = 0;
  const manager = { loadFromFolder: () => load.promise } as unknown as ContextManager;
  const watcher = new FileWatcher(manager, () => notified++); const start = watcher.start('/tmp/vault');
  const created = watchers[watchers.length - 1]; watcher.stop(); load.resolve(); await start;
  assert.equal(created.disposed, true); assert.equal(notified, 0);
});

test('background exports never discover models or request missing consent', async () => {
  modelState.calls = 0;
  await assert.rejects(completeWithModel(undefined, [{ role: 'user', content: 'export' }], { background: true }, {} as vscode.SecretStorage), /No language model/);
  assert.equal(modelState.calls, 0);
});

test('model token counts enforce whole-turn budgets before sending and background requests reuse consent', async () => {
  const sent: any[] = []; let counts = 0;
  const model = { id: 'test-model', vendor: 'test', family: 'test', name: 'test', maxInputTokens: 1000,
    countTokens: async (turn: any) => { counts++; return turn.content.length; },
    sendRequest: async (turns: any[]) => { sent.push(turns); return { text: (async function* () { yield 'ok'; })() }; },
  };
  modelState.models = [model];
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  await listAllModels(secrets);
  assert.equal(await completeWithModel(model.id, [{ role: 'user', content: 'old'.repeat(300) }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'current' }], { maxTokens: 100 }, secrets), 'ok');
  assert.deepEqual(sent[0], [{ role: 1, content: 'current' }]); assert.equal(counts, 3);
  setModelAccessInformation({ canSendRequest: () => true } as unknown as vscode.LanguageModelAccessInformation);
  modelState.calls = 0;
  await completeWithModel(model.id, [{ role: 'user', content: 'export' }], { background: true }, secrets);
  assert.equal(modelState.calls, 0);
  setModelAccessInformation({ canSendRequest: () => false } as unknown as vscode.LanguageModelAccessInformation);
  await assert.rejects(completeWithModel(model.id, [{ role: 'user', content: 'export' }], { background: true }, secrets));
  const sentBefore = sent.length;
  await assert.rejects(completeWithModel(model.id, [{ role: 'user', content: 'x'.repeat(2000) }], {}, secrets), /input budget/);
  assert.equal(sent.length, sentBefore);
  assert.deepEqual(await selectVsCodeModel('missing-selected-model'), []);
});

test('recovering a live session cannot reset its acknowledged export cursor', async () => {
  const { pending } = store(); const s = session(); await pending.put(s, '/original'); await pending.acknowledge(s.id, 2);
  // The live panel still has an older snapshot after a separate recovery command.
  s.messages.push(message('new')); await pending.put(s, '/original');
  assert.equal(pending.get(s.id)?.session.exportedMessageCount, 2);
});

test('storage failures surface and later writes retry the complete pending snapshot', async () => {
  const values = new Map<string, unknown>(); let fail = true;
  const state = { keys: () => [], get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { if (fail) { fail = false; throw new Error('disk unavailable'); } values.set(key, value); } } as vscode.Memento;
  const pending = new PendingExports(state);
  await assert.rejects(pending.put(session(), '/original'), /disk unavailable/);
  assert.equal(pending.list().length, 1);
  await pending.put({ ...session(), id: 'bob_test' }, '/other');
  assert.equal(new PendingExports(state).list().length, 2);
});

test('restored history cannot be reassigned to a different vault', async () => {
  const p = panel(); p._session.messages = [];
  await p._pending.put(session(), '/other-vault');
  p._restoreSession(session().messages, 'alice_test', '/other-vault');
  assert.equal(p._session.messages.length, 0);
});

test('failed exports keep their original destination across a configuration change', async () => {
  const p = panel(); p._destination = '/original-vault'; await p._stashPendingSession();
  const destinations: string[] = [];
  p._exporter.exportSession = async (_session: ChatSession, destination: string) => { destinations.push(destination); return null; };
  const previous = config.syncFolder; config.syncFolder = '/new-vault';
  try { await p._startNewSession(); await ChatPanel.flushExports(); }
  finally { config.syncFolder = previous; }
  assert.deepEqual(destinations, ['/original-vault']);
  assert.equal(p._pending.get('alice_test')?.destination, '/original-vault');
});

test('an old export cannot clear newer pending messages on the panel', async () => {
  const p = panel(); await p._stashPendingSession(); const gate = deferred<string>(); const started = deferred<void>();
  p._exporter.exportSession = () => { started.resolve(); return gate.promise; };
  const exporting = p._exportSession(); await started.promise;
  p._session.messages.push(message('new while exporting')); await p._stashPendingSession();
  gate.resolve('/saved'); await exporting;
  assert.equal(p._pending.get('alice_test')?.revision, 3);
  assert.equal(p._pending.get('alice_test')?.session.exportedMessageCount, 2);
});

test('unconfigured conversations remain durable and never export into the working directory', async () => {
  const p = panel(); const previous = config.syncFolder; config.syncFolder = ''; p._destination = '';
  let exports = 0; p._exporter.exportSession = async () => { exports++; return '/unexpected'; };
  try {
    await p._stashPendingSession(); assert.equal(p._pending.list().length, 1);
    await p._exportSession(); await p._startNewSession(); await ChatPanel.flushExports();
    assert.equal(exports, 0); assert.equal(p._pending.get('alice_test')?.destination, '');
  } finally { config.syncFolder = previous; }
});

test('the first configured vault can save an existing unassigned conversation', async () => {
  const p = panel(); p._destination = ''; const previous = config.syncFolder; config.syncFolder = '';
  try {
    await p._stashPendingSession(); config.syncFolder = '/first-vault';
    const paths: string[] = []; p._exporter.exportSession = async (_session: ChatSession, folder: string) => { paths.push(folder); return '/saved'; };
    await p._forceSave(); assert.deepEqual(paths, ['/first-vault']);
    assert.equal(p._session.messages.length, 2);
  } finally { config.syncFolder = previous; }
});

test('shutdown cancels requests and tracks closing exports even after the panel is removed', async () => {
  const p = panel(); p._panel = { dispose: () => undefined };
  const source = new CancellationTokenSource(); p._activeRequest = source;
  const gate = deferred<string>(), started = deferred<void>();
  p._exporter.exportSession = () => { started.resolve(); return gate.promise; };
  ChatPanel.currentPanel = p; p.shutdown(); p.shutdown();
  assert.equal(source.token.isCancellationRequested, true); assert.equal(ChatPanel.currentPanel, undefined);
  await started.promise;
  let finished = false; const closing = ChatPanel.flushExports().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  gate.resolve('/saved'); await closing; assert.equal(finished, true);
});

test('restored webview history without a durable export receipt remains unsaved', async () => {
  const p = panel(); p._session.messages = [];
  p._restoreSession(session().messages, 'alice_test', '/tmp/vault');
  assert.equal(p._session.exportedMessageCount ?? 0, 0);
  await p._stashPendingSession();
  assert.equal(p._pending.list().length, 1);
});

test('force save cannot checkpoint a user turn while its reply is still pending', async () => {
  const p = panel(); p._activeRequest = new CancellationTokenSource(); let exports = 0;
  p._exporter.exportSession = async () => { exports++; return '/saved'; };
  await assert.rejects(p._forceSave(), /reply/);
  assert.equal(exports, 0);
});

test('an existing corrupt segment is not treated as a successful export', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-corrupt-export-'));
  const exporter = new MarkdownExporter(new ContextManager(), {} as vscode.SecretStorage);
  internal(exporter)._extractMetadata = async () => ({ worthSaving: true, topic: 'Topic', tags: [], summary: 'Decision', keyDecisions: [], keyQuestions: [], codeReferences: [] });
  const file = await exporter.exportSession(session(), dir); assert.ok(file);
  await writeFile(file, 'incomplete synced content');
  await assert.rejects(exporter.exportSession(session(), dir), /invalid|corrupt|incomplete/i);
});

test('private chat does not depend on failed public storage writes', async () => {
  const state = { keys: () => [], get: () => undefined, update: async () => { throw new Error('disk unavailable'); } } as unknown as vscode.Memento;
  const pending = new PendingExports(state);
  await assert.rejects(pending.put(session(), '/vault'), /disk unavailable/);
  const privateSession = { ...session(), id: 'private_session', messages: session().messages.map(m => ({ ...m, private: true })) };
  await pending.put(privateSession, '/vault');
  assert.equal(pending.get(privateSession.id), undefined);
});

test('partially quality-rejected exports remain queued so Force Save can include rejected segments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-partial-export-'));
  const exporter = new MarkdownExporter(new ContextManager(), {} as vscode.SecretStorage);
  internal(exporter)._extractMetadata = async (text: string) => ({ worthSaving: text.includes('usefulmarker'), topic: 'Topic', tags: [], summary: 'Decision', keyDecisions: [], keyQuestions: [], codeReferences: [] });
  const s = session(); s.messages[0].content = 'usefulmarker' + 'x'.repeat(9000);
  assert.equal(await exporter.exportSession(s, dir), null);
  assert.equal((await readdir(dir)).length, 1);
  assert.ok(await exporter.exportSession(s, dir, true));
  assert.equal((await readdir(dir)).length, 2);
});

test('large pasted queries retain matching facts and repeated terms do not inflate relevance', async () => {
  const { value } = await manager();
  const longQuery = Array.from({ length: 5000 }, (_, i) => `identifier_${i}`).join(' ') + ' jwt';
  assert.match(value.buildContextBlock(longQuery), /Validate JWT expiry/);
  assert.equal(value.buildContextBlock('jwt'), value.buildContextBlock('jwt '.repeat(1000)));
});
