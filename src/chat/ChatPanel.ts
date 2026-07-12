import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChatHandler } from './ChatHandler';
import { ContextManager } from '../context/ContextManager';
import { ChatMessage, ChatSession, WebviewMessage, CopilotModel } from '../types';
import { MarkdownExporter } from '../markdown/MarkdownExporter';

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const EXPORT_DEBOUNCE_MS = 2 * 60 * 1000;

export const PENDING_SESSION_KEY = 'contextSync.pendingSession';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _handler: ChatHandler;
  private readonly _exporter: MarkdownExporter;
  private readonly _memento: vscode.Memento;
  private _session: ChatSession;
  private _privacyMode: boolean = false;
  private _inactivityTimer?: NodeJS.Timeout;
  private _exportTimer?: NodeJS.Timeout;
  private _exportPromise?: Promise<void>;
  private _activeRequest?: vscode.CancellationTokenSource;
  private _busy: boolean = false;
  private _lastExportedCount: number = 0;
  private _disposables: vscode.Disposable[] = [];
  private _disposed: boolean = false;

  public static createOrShow(extensionUri: vscode.Uri, contextManager: ContextManager, memento: vscode.Memento, secrets: vscode.SecretStorage) {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (ChatPanel.currentPanel) { ChatPanel.currentPanel._panel.reveal(column); return; }
    const panel = vscode.window.createWebviewPanel('contextSyncChat', 'ContextSync Chat', column, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
      retainContextWhenHidden: true,
    });
    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, contextManager, memento, secrets);
  }

  // rebuild a panel restored by the webview serializer
  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, contextManager: ContextManager, memento: vscode.Memento, secrets: vscode.SecretStorage) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
    };
    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, contextManager, memento, secrets);
  }

  public static notifyContextUpdated(contextManager: ContextManager) {
    if (!ChatPanel.currentPanel) return;
    ChatPanel.currentPanel._postMessage({
      type: 'syncStatus',
      status: 'Synced',
      fileCount: contextManager.fileCount,
      fileNames: contextManager.getLoadedFileNames(),
    });
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, contextManager: ContextManager, memento: vscode.Memento, secrets: vscode.SecretStorage) {
    this._panel = panel;
    this._memento = memento;
    this._handler = new ChatHandler(contextManager, secrets);
    this._exporter = new MarkdownExporter(contextManager, secrets);
    this._session = this._createNewSession();
    this._panel.webview.html = this._getHtml(extensionUri);
    this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this._handleWebviewMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  private async _handleWebviewMessage(message: WebviewMessage) {
    try {
      // type check payloads from the webview
      if (message.type === 'sendMessage')      { if (typeof message.content === 'string' && message.content.trim()) await this._handleUserMessage(message.content); }
      else if (message.type === 'newSession')  { await this._startNewSession(); }
      else if (message.type === 'forceSave')   { await this._forceSave(); }
      else if (message.type === 'setPrivacy')  { this._privacyMode = message.enabled === true; }
      else if (message.type === 'setModel')    { if (typeof message.modelId === 'string') this._session.selectedModel = message.modelId; }
      else if (message.type === 'restoreSession') { this._restoreSession(message.messages, message.sessionId); }
      else if (message.type === 'requestModels') { await this._sendModelList(); }
      else if (message.type === 'ready') {
        this._postMessage({ type: 'syncStatus', status: 'Loaded', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
        this._postMessage({ type: 'sessionInfo', id: this._session.id });
        this._validateConfig();
        await this._sendModelList();
      }
    } catch (err) {
      this._postMessage({ type: 'error', message: String(err) });
    }
  }

  private async _sendModelList() {
    const models = await this._handler.getAvailableModels();
    this._postMessage({ type: 'modelList', models });
  }

  private async _handleUserMessage(content: string) {
    if (this._busy) return;
    this._busy = true;
    this._resetInactivityTimer();
    const userMsg = { role: 'user' as const, content, timestamp: new Date().toISOString(), ...(this._privacyMode ? { private: true } : {}) };
    this._session.messages.push(userMsg);
    this._postMessage({ type: 'addMessage', message: userMsg });
    this._postMessage({ type: 'setLoading', loading: true });
    this._activeRequest = new vscode.CancellationTokenSource();
    try {
      const reply = await this._handler.sendMessage(this._session, this._activeRequest.token);
      const assistantMsg = { role: 'assistant' as const, content: reply, timestamp: new Date().toISOString(), ...(this._privacyMode ? { private: true } : {}) };
      this._session.messages.push(assistantMsg);
      this._postMessage({ type: 'addMessage', message: assistantMsg });
      this._stashPendingSession();
      this._scheduleExport();
    } catch (err) {
      if (err instanceof vscode.CancellationError) return;
      vscode.window.showErrorMessage(`ContextSync: ${err}`);
      this._postMessage({ type: 'error', message: String(err) });
    } finally {
      this._activeRequest.dispose();
      this._activeRequest = undefined;
      this._busy = false;
      this._resetInactivityTimer();
      this._postMessage({ type: 'setLoading', loading: false });
    }
  }

  // restore chat history persisted by the webview after a window reload
  private _restoreSession(messages: ChatMessage[], sessionId?: string) {
    if (!Array.isArray(messages) || this._session.messages.length) return;
    const valid = messages.filter(
      (m): m is ChatMessage =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        typeof m.timestamp === 'string'
    );
    this._session.messages = valid;
    // adopt the old id only if it belongs to the current user
    if (
      typeof sessionId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(sessionId) &&
      sessionId.startsWith(`${this._session.username}_`)
    ) {
      this._session.id = sessionId;
    }
  }

  // keep an off-panel copy so a crash or shutdown cannot lose the session
  private _stashPendingSession() {
    const shareable = this._session.messages.filter((m) => !m.private);
    if (shareable.length < 2) return;
    // exporter reads only the last 10 messages so bound the stash
    void this._memento.update(PENDING_SESSION_KEY, { ...this._session, messages: shareable.slice(-10) });
  }

  // debounce export so each turn does not trigger llm calls
  private _scheduleExport() {
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = setTimeout(() => { void this._exportSession(); }, EXPORT_DEBOUNCE_MS);
  }

  // single-flight so concurrent triggers never double-export
  private _exportSession(notifyRejection = true): Promise<void> {
    if (this._exportPromise) return this._exportPromise;
    this._exportPromise = this._doExport(notifyRejection).finally(() => {
      this._exportPromise = undefined;
    });
    return this._exportPromise;
  }

  private async _doExport(notifyRejection: boolean): Promise<void> {
    if (this._exportTimer) { clearTimeout(this._exportTimer); this._exportTimer = undefined; }
    const syncFolder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder') ?? '';
    if (!syncFolder || this._privacyMode || this._session.messages.length < 2) return;
    // skip llm spend when nothing new has been said since the last export
    if (this._session.messages.length === this._lastExportedCount) return;
    try {
      const messageCount = this._session.messages.length;
      const filePath = await this._exporter.exportSession(this._session, syncFolder);
      void this._memento.update(PENDING_SESSION_KEY, undefined);
      if (filePath) {
        this._lastExportedCount = messageCount;
        this._postMessage({ type: 'syncStatus', status: 'Saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
      } else if (notifyRejection) {
        this._postMessage({ type: 'qualityGateRejected' });
      }
    } catch (err) {
      console.error('ContextSync: export failed', err);
    }
  }

  // flush a pending export on shutdown
  public async flushPendingExport(): Promise<void> {
    if (!this._exportTimer) return;
    await this._exportSession(false);
  }

  private async _startNewSession() {
    // keep the stash if the export failed
    await this._exportSession(false);
    this._session = this._createNewSession();
    this._lastExportedCount = 0;
    this._postMessage({ type: 'sessionReset' });
    this._postMessage({ type: 'sessionInfo', id: this._session.id });
  }

  private async _forceSave() {
    if (this._privacyMode) { this._postMessage({ type: 'error', message: 'Privacy mode is on — turn it off to save this conversation.' }); return; }
    const syncFolder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder') ?? '';
    if (!syncFolder) { this._postMessage({ type: 'error', message: 'No sync folder configured.' }); return; }
    if (this._session.messages.filter((m) => !m.private).length < 2) { this._postMessage({ type: 'error', message: 'Nothing to save yet.' }); return; }
    if (this._exportTimer) { clearTimeout(this._exportTimer); this._exportTimer = undefined; }
    // claim the single flight slot so exports never overlap
    if (this._exportPromise) await this._exportPromise;
    this._exportPromise = (async () => {
      const messageCount = this._session.messages.length;
      const filePath = await this._exporter.exportSession(this._session, syncFolder, true);
      if (filePath) {
        this._lastExportedCount = messageCount;
        void this._memento.update(PENDING_SESSION_KEY, undefined);
        this._postMessage({ type: 'syncStatus', status: 'Force saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
      }
    })().finally(() => {
      this._exportPromise = undefined;
    });
    await this._exportPromise;
  }

  private _resetInactivityTimer() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      if (this._disposed) return;
      void this._startNewSession().then(() => {
        this._postMessage({ type: 'inactivityReset', message: 'New session started after 30 minutes of inactivity.' });
      });
    }, INACTIVITY_TIMEOUT_MS);
  }

  private _validateConfig() {
    const config = vscode.workspace.getConfiguration('contextSync');
    const warnings: string[] = [];
    if (!config.get<string>('username')) warnings.push('contextSync.username is not set.');
    if (!config.get<string>('syncFolder')) warnings.push('contextSync.syncFolder is not set.');
    if (warnings.length) this._postMessage({ type: 'configWarning', warnings });
  }

  private _postMessage(message: object) {
    if (this._disposed) return;
    this._panel.webview.postMessage(message);
  }

  private _createNewSession(): ChatSession {
    const config = vscode.workspace.getConfiguration('contextSync');

    // sanitise username to prevent path traversal via filenames
    const rawUsername = config.get<string>('username') || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32);

    const date = new Date().toISOString().split('T')[0];
    const uid = crypto.randomBytes(4).toString('hex');

    return { id: `${username}_${date}_${uid}`, username, messages: [], startedAt: new Date().toISOString() };
  }

  private _getHtml(extensionUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const htmlPath = path.join(extensionUri.fsPath, 'src', 'webview', 'chat.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return html.replace(/{{NONCE}}/g, nonce);
  }

  private _dispose() {
    const hadPendingExport = !!this._exportTimer;
    this._disposed = true;
    this._activeRequest?.cancel();
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    // disarm the timer so it cannot fire after dispose
    if (this._exportTimer) { clearTimeout(this._exportTimer); this._exportTimer = undefined; }
    if (hadPendingExport) void this._exportSession(false);
    ChatPanel.currentPanel = undefined;
    this._disposables.forEach((d) => d.dispose());
  }
}