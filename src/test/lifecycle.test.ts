import { config, watchers, registeredCommands, configurationListeners, modelState, dialogState } from './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { ChatPanel, PENDING_SESSION_KEY } from '../chat/ChatPanel';
import { PendingExports } from '../chat/PendingExports';
import { MarkdownExporter } from '../markdown/MarkdownExporter';

function context() {
  const state = new Map<string, unknown>();
  const memento = { keys: () => [...state.keys()], get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } } as vscode.Memento;
  return { workspaceState: memento, globalState: { get: () => undefined }, subscriptions: [] as vscode.Disposable[], languageModelAccessInformation: { canSendRequest: () => false }, secrets: { get: async () => undefined } } as unknown as vscode.ExtensionContext;
}

test('activation never selects models, and clearing the folder disposes watchers and removes context', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-lifecycle-'));
  await writeFile(path.join(dir, 'a.md'), '---\ntopic: "Auth"\ntags: [auth]\n---\n## Summary\nUse JWT');
  const previous = config.syncFolder; config.syncFolder = dir;
  const extension = context();
  try {
    modelState.calls = 0; activate(extension);
    await registeredCommands.get('contextSync.syncNow')!();
    assert.equal(modelState.calls, 0);
    const status: any[] = [];
    ChatPanel.currentPanel = { _postMessage: (message: unknown) => status.push(message) } as unknown as ChatPanel;
    config.syncFolder = '';
    configurationListeners.forEach(fn => fn({ affectsConfiguration: key => key === 'contextSync.syncFolder' }));
    assert.equal(status[status.length - 1].fileCount, 0);
    assert.ok(watchers.every(watcher => watcher.disposed));
  } finally {
    ChatPanel.currentPanel = undefined;
    await deactivate(); extension.subscriptions.forEach(d => d.dispose()); config.syncFolder = previous;
  }
});

test('explicit recovery uses stored destinations and failed recovery remains durable', async () => {
  const extension = context();
  const pending = new PendingExports(extension.workspaceState);
  await pending.put({ id: 'alice_test', username: 'alice', startedAt: new Date(0).toISOString(), messages: [
    { role: 'user', content: 'decision', timestamp: new Date(0).toISOString() },
    { role: 'assistant', content: 'answer', timestamp: new Date(0).toISOString() },
  ] }, '/original-vault');
  const original = MarkdownExporter.prototype.exportSession;
  let fail = true; const destinations: string[] = [];
  MarkdownExporter.prototype.exportSession = async (_session, destination) => { destinations.push(destination); if (fail) throw new Error('offline'); return '/saved'; };
  try {
    activate(extension);
    await assert.rejects(async () => registeredCommands.get('contextSync.recoverPending')!(), /offline/);
    assert.equal(new PendingExports(extension.workspaceState).list().length, 1);
    fail = false;
    await registeredCommands.get('contextSync.recoverPending')!();
    assert.equal(new PendingExports(extension.workspaceState).list().length, 0);
    assert.deepEqual(destinations, ['/original-vault', '/original-vault']);
  } finally {
    MarkdownExporter.prototype.exportSession = original;
    await deactivate(); extension.subscriptions.forEach(d => d.dispose());
  }
});

test('legacy recovery requires an explicit vault choice before migrating global state', async () => {
  const extension = context();
  let legacy: unknown = { id: 'alice_legacy', username: 'alice', startedAt: new Date(0).toISOString(), messages: [
    { role: 'user', content: 'legacy decision', timestamp: new Date(0).toISOString() },
    { role: 'assistant', content: 'legacy answer', timestamp: new Date(0).toISOString() },
  ] };
  Object.defineProperty(extension, 'globalState', { value: { get: (key: string) => key === PENDING_SESSION_KEY ? legacy : undefined, update: async (_key: string, value: unknown) => { legacy = value; } } });
  const original = MarkdownExporter.prototype.exportSession; const paths: string[] = [];
  MarkdownExporter.prototype.exportSession = async (_session, folder) => { paths.push(folder); return '/saved'; };
  try {
    activate(extension); dialogState.paths = undefined;
    await registeredCommands.get('contextSync.recoverPending')!();
    assert.ok(legacy); assert.deepEqual(paths, []);
    dialogState.paths = [{ fsPath: '/chosen-original-vault' }];
    await registeredCommands.get('contextSync.recoverPending')!();
    assert.equal(legacy, undefined); assert.deepEqual(paths, ['/chosen-original-vault']);
    assert.equal(new PendingExports(extension.workspaceState).list().length, 0);
  } finally {
    dialogState.paths = undefined; MarkdownExporter.prototype.exportSession = original;
    await deactivate(); extension.subscriptions.forEach(d => d.dispose());
  }
});
