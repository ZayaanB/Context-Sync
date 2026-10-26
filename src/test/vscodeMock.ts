import Module = require('node:module');
export const config: Record<string, unknown> = { maxContextFiles: 5, syncFolder: '/tmp/vault', username: 'alice', maxInputTokens: 12000 };
export const watchers: FakeWatcher[] = [];
export class FakeWatcher {
  disposed = false;
  create?: (uri: { fsPath: string }) => void;
  change?: (uri: { fsPath: string }) => void;
  delete?: (uri: { fsPath: string }) => void;
  onDidCreate(fn: typeof this.create) { this.create = fn; }
  onDidChange(fn: typeof this.change) { this.change = fn; }
  onDidDelete(fn: typeof this.delete) { this.delete = fn; }
  dispose() { this.disposed = true; }
}
export class CancellationError extends Error {}
export class CancellationTokenSource {
  private listeners = new Set<() => void>();
  token = { isCancellationRequested: false, onCancellationRequested: (fn: () => void) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; } };
  cancel() { this.token.isCancellationRequested = true; this.listeners.forEach(fn => fn()); }
  dispose() { this.listeners.clear(); }
}
export const modelState = { calls: 0, models: [] as any[] };
export const dialogState = { paths: undefined as { fsPath: string }[] | undefined };
export const registeredCommands = new Map<string, (...args: any[]) => unknown>();
export const configurationListeners = new Set<(event: { affectsConfiguration: (key: string) => boolean }) => void>();
const disposable = () => ({ dispose() {} });
export const vscodeMock = {
  lm: { selectChatModels: async (selector: { id?: string }) => { modelState.calls++; return modelState.models.filter(model => !selector.id || model.id === selector.id); } },
  CancellationError, CancellationTokenSource,
  commands: { registerCommand: (name: string, fn: (...args: any[]) => unknown) => { registeredCommands.set(name, fn); return disposable(); } },
  chat: { createChatParticipant: () => ({ dispose() {} }) },
  workspace: { onDidChangeConfiguration: (fn: (event: { affectsConfiguration: (key: string) => boolean }) => void) => { configurationListeners.add(fn); return { dispose: () => configurationListeners.delete(fn) }; }, getConfiguration: () => ({ get: (key: string) => config[key] }), createFileSystemWatcher: () => { const watcher = new FakeWatcher(); watchers.push(watcher); return watcher; } },
  window: { showOpenDialog: async () => dialogState.paths, registerWebviewPanelSerializer: disposable, showInformationMessage: () => undefined, showWarningMessage: () => undefined, showErrorMessage: () => undefined },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  LanguageModelChatMessage: { User: (content: string) => ({ role: 1, content }), Assistant: (content: string) => ({ role: 2, content }) },
};
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function(name: string, ...args: unknown[]) { return name === 'vscode' ? vscodeMock : original.call(this, name, ...args); };
