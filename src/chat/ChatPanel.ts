import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChatHandler } from './ChatHandler';
import { ContextManager } from '../context/ContextManager';
import { ChatMessage, ChatSession, WebviewMessage } from '../types';
import { MarkdownExporter } from '../markdown/MarkdownExporter';
import { PendingExport, PendingExports } from './PendingExports';

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const EXPORT_DEBOUNCE_MS = 2 * 60 * 1000;
// Legacy global recovery data is deliberately retained: its original vault is unknown.
export const PENDING_SESSION_KEY = 'contextSync.pendingSession';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private static _closing = new Set<Promise<void>>();
  private static _exports: Promise<void> = Promise.resolve();
  private readonly _handler: ChatHandler;
  private readonly _exporter: MarkdownExporter;
  private _session: ChatSession;
  private _destination: string;
  private _privacyMode = false;
  private _inactivityTimer?: NodeJS.Timeout;
  private _exportTimer?: NodeJS.Timeout;
  private _activeRequest?: vscode.CancellationTokenSource;
  private _disposables: vscode.Disposable[] = [];
  private _disposed = false;

  public static createOrShow(extensionUri: vscode.Uri, manager: ContextManager, pending: PendingExports, secrets: vscode.SecretStorage) {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (this.currentPanel) { this.currentPanel._panel.reveal(column); return; }
    const panel = vscode.window.createWebviewPanel('contextSyncChat', 'ContextSync Chat', column, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')], retainContextWhenHidden: true,
    });
    this.currentPanel = new ChatPanel(panel, extensionUri, manager, pending, secrets);
  }

  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, manager: ContextManager, pending: PendingExports, secrets: vscode.SecretStorage) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')] };
    this.currentPanel = new ChatPanel(panel, extensionUri, manager, pending, secrets, false);
  }

  public static notifyContextUpdated(manager: ContextManager) {
    this.currentPanel?._postMessage({ type: 'syncStatus', status: 'Synced', fileCount: manager.fileCount, fileNames: manager.getLoadedFileNames() });
  }

  public static async flushExports(): Promise<void> {
    await Promise.all(this._closing);
    await this._exports;
  }
  public static queueExport(run: () => Promise<void>): Promise<void> {
    const work = this._exports.then(run);
    this._exports = work.catch(err => console.error('ContextSync: export failed', err));
    return work;
  }

  private constructor(private readonly _panel: vscode.WebviewPanel, extensionUri: vscode.Uri, manager: ContextManager, private readonly _pending: PendingExports, secrets: vscode.SecretStorage, private readonly _allowModelSelection = true) {
    this._handler = new ChatHandler(manager, secrets);
    this._exporter = new MarkdownExporter(manager, secrets);
    this._session = this._createNewSession();
    this._destination = this._configuredFolder();
    this._panel.webview.html = this._getHtml(extensionUri);
    this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this._handleWebviewMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  private _configuredFolder(): string {
    const folder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder') ?? '';
    return folder ? path.resolve(folder) : '';
  }

  private async _handleWebviewMessage(message: WebviewMessage) {
    try {
      if (!message || typeof message !== 'object' || this._disposed) return;
      if (message.type === 'sendMessage') {
        if (typeof message.content === 'string' && message.content.trim()) await this._handleUserMessage(message.content);
      } else if (message.type === 'newSession') await this._startNewSession();
      else if (message.type === 'forceSave') await this._forceSave();
      else if (message.type === 'setPrivacy') {
        if (this._privacyMode !== (message.enabled === true)) await this._startNewSession(message.enabled === true);
      } else if (message.type === 'setModel') {
        if (typeof message.modelId === 'string') this._session.selectedModel = message.modelId;
      } else if (message.type === 'restoreSession') this._restoreSession(message.messages, message.sessionId, message.destination);
      else if (message.type === 'requestModels') await this._sendModelList(true);
      else if (message.type === 'ready') {
        ChatPanel.notifyContextUpdated(this._handler.contextManager);
        this._postMessage({ type: 'sessionInfo', id: this._session.id, destination: this._destination });
        this._validateConfig();
        await this._sendModelList();
      }
    } catch (err) { this._postMessage({ type: 'error', message: String(err) }); }
  }

  private async _sendModelList(allowSelection = this._allowModelSelection) {
    this._postMessage({ type: 'modelList', models: await this._handler.getAvailableModels(allowSelection) });
  }

  private async _handleUserMessage(content: string) {
    if (this._activeRequest || this._disposed) return;
    this._destination = this._pending.destinationFor(this._session.id) || this._destination;
    if (!this._destination) this._destination = this._configuredFolder();
    if (this._destination !== this._configuredFolder()) await this._startNewSession();
    if (this._activeRequest || this._disposed) return;
    const session = this._session;
    const privateTurn = this._privacyMode;
    const request = new vscode.CancellationTokenSource();
    this._activeRequest = request;
    const user: ChatMessage = { role: 'user', content, timestamp: new Date().toISOString(), private: privateTurn };
    session.messages.push(user);
    this._postMessage({ type: 'addMessage', message: user });
    this._postMessage({ type: 'setLoading', loading: true });
    this._resetInactivityTimer();
    try {
      await this._stashPendingSession();
      if (request.token.isCancellationRequested || this._session !== session || this._disposed) return;
      const reply = await this._handler.sendMessage(session, request.token);
      if (request.token.isCancellationRequested || this._session !== session || this._disposed) return;
      const assistant: ChatMessage = { role: 'assistant', content: reply, timestamp: new Date().toISOString(), private: privateTurn };
      session.messages.push(assistant);
      this._postMessage({ type: 'addMessage', message: assistant });
      await this._stashPendingSession();
      if (!privateTurn && this._session === session && !this._disposed) this._scheduleExport();
    } catch (err) {
      if (!(err instanceof vscode.CancellationError) && !request.token.isCancellationRequested && this._session === session && !this._disposed) {
        this._postMessage({ type: 'error', message: String(err) });
      }
    } finally {
      request.dispose();
      if (this._activeRequest === request) {
        this._activeRequest = undefined;
        if (!this._disposed) this._resetInactivityTimer();
        this._postMessage({ type: 'setLoading', loading: false });
      }
    }
  }

  private _restoreSession(messages: ChatMessage[], sessionId?: string, destination?: string) {
    if (!Array.isArray(messages) || this._session.messages.length || typeof sessionId !== 'string') return;
    const entry = this._pending.get(sessionId);
    // Durable state is authoritative. Webview state alone cannot reassign an old session to a new vault.
    if (entry && entry.destination === this._destination && entry.session.username === this._session.username) {
      this._session = entry.session;
    } else if (!entry && destination === this._destination) {
      const valid = messages.filter(m => m && !m.private && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && typeof m.timestamp === 'string');
      this._session.messages = valid.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp }));
      // A webview snapshot proves availability, not successful export. Retain it for retry.
      this._session.exportedMessageCount = 0;
    } else this._postMessage({ type: 'sessionReset' });
  }

  private _stashPendingSession(): Promise<void> {
    this._destination = this._pending.destinationFor(this._session.id) || this._destination || this._configuredFolder();
    return this._pending.put(this._session, this._destination);
  }

  private _scheduleExport() {
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = setTimeout(() => { this._exportTimer = undefined; void this._exportSession(); }, EXPORT_DEBOUNCE_MS);
  }

  private _exportSession(force = false): Promise<void> {
    if (this._activeRequest && !this._activeRequest.token.isCancellationRequested) return ChatPanel._exports;
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = undefined;
    const entry = this._pending.get(this._session.id);
    if (!entry || entry.session.messages.length < 2 || !this._destination) return ChatPanel._exports;
    return this._enqueueExport(entry, force);
  }

  private _enqueueExport(entry: PendingExport, force: boolean): Promise<void> {
    const run = async () => {
      const current = this._pending.get(entry.session.id);
      if (!current || !entry.destination) return;
      // Preserve progress acknowledged by an earlier serialized export.
      entry.session.exportedMessageCount = Math.max(entry.session.exportedMessageCount ?? 0, current.session.exportedMessageCount ?? 0);
      const file = await this._exporter.exportSession(entry.session, entry.destination, force, !force);
      if (file) {
        await this._pending.acknowledge(entry.session.id, entry.revision);
        if (this._session.id === entry.session.id) this._session.exportedMessageCount = entry.revision;
        this._postMessage({ type: 'syncStatus', status: 'Saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
      } else if (force) throw new Error('No export was produced. The conversation remains queued.');
      else this._postMessage({ type: 'qualityGateRejected' });
    };
    const work = ChatPanel.queueExport(run);
    return work.catch(err => {
      console.error('ContextSync: export failed', err);
      this._postMessage({ type: 'error', message: `Export failed; conversation retained for retry: ${String(err)}` });
    });
  }

  public async flushPendingExport(): Promise<void> {
    await this._stashPendingSession();
    await this._exportSession();
    await this._pending.flush();
  }

  private async _startNewSession(privacy = this._privacyMode) {
    const old = this._session;
    const destination = this._destination;
    this._activeRequest?.cancel();
    this._activeRequest = undefined;
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = undefined;
    this._privacyMode = privacy;
    this._session = this._createNewSession();
    this._session.selectedModel = old.selectedModel;
    this._destination = this._configuredFolder();
    this._postMessage({ type: 'setLoading', loading: false });
    this._postMessage({ type: 'sessionReset' });
    this._postMessage({ type: 'sessionInfo', id: this._session.id, destination: this._destination });
    this._resetInactivityTimer();
    await this._pending.put(old, destination);
    const entry = this._pending.get(old.id);
    if (entry && entry.session.messages.length >= 2) void this._enqueueExport(entry, false);
  }

  private async _forceSave() {
    if (this._privacyMode) throw new Error('Turn privacy mode off before saving.');
    if (this._activeRequest && !this._activeRequest.token.isCancellationRequested) throw new Error('Wait for the current reply before saving.');
    const session = this._session;
    await this._stashPendingSession();
    if (this._session !== session || this._privacyMode || this._disposed) return;
    if (!this._destination) throw new Error('No sync folder configured. The conversation is retained for recovery.');
    if (this._session.messages.filter(m => !m.private).length < 2) throw new Error('Nothing to save yet.');
    await this._exportSession(true);
  }

  private _resetInactivityTimer() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      if (this._disposed || this._activeRequest) return;
      void this._startNewSession().catch(err => console.error('ContextSync: session reset failed', err));
    }, INACTIVITY_TIMEOUT_MS);
  }

  private _validateConfig() {
    const warnings: string[] = [];
    const config = vscode.workspace.getConfiguration('contextSync');
    if (!config.get<string>('username')) warnings.push('contextSync.username is not set.');
    if (!config.get<string>('syncFolder')) warnings.push('contextSync.syncFolder is not set.');
    if (this._pending.list().length) warnings.push('Unsaved conversations can be retried with ContextSync: Recover Pending Exports.');
    if (warnings.length) this._postMessage({ type: 'configWarning', warnings });
  }

  private _postMessage(message: object) { if (!this._disposed) void this._panel.webview.postMessage(message); }
  private _createNewSession(): ChatSession {
    const raw = vscode.workspace.getConfiguration('contextSync').get<string>('username') || 'user';
    const username = raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32);
    const date = new Date().toISOString();
    return { id: `${username}_${date.split('T')[0]}_${crypto.randomBytes(8).toString('hex')}`, username, messages: [], startedAt: date };
  }
  private _getHtml(extensionUri: vscode.Uri): string {
    return fs.readFileSync(path.join(extensionUri.fsPath, 'src', 'webview', 'chat.html'), 'utf-8').replace(/{{NONCE}}/g, crypto.randomBytes(16).toString('hex'));
  }
  public shutdown(): void {
    this._dispose();
    this._panel.dispose();
  }

  private _dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._activeRequest?.cancel();
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    const closing = this.flushPendingExport().catch(err => console.error('ContextSync: closing export failed', err));
    ChatPanel._closing.add(closing);
    void closing.finally(() => ChatPanel._closing.delete(closing));
    if (ChatPanel.currentPanel === this) ChatPanel.currentPanel = undefined;
    this._disposables.forEach(d => d.dispose());
  }
}
