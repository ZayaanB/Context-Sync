import * as vscode from 'vscode';
import { ChatHandler } from './ChatHandler';
import { ContextManager } from '../context/ContextManager';
import { ChatSession, WebviewMessage } from '../types';
import { MarkdownExporter } from '../markdown/MarkdownExporter';

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _handler: ChatHandler;
  private readonly _exporter: MarkdownExporter;
  private _session: ChatSession;
  private _inactivityTimer?: NodeJS.Timeout;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, contextManager: ContextManager) {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (ChatPanel.currentPanel) { ChatPanel.currentPanel._panel.reveal(column); return; }
    const panel = vscode.window.createWebviewPanel('contextSyncChat', 'ContextSync Chat', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    ChatPanel.currentPanel = new ChatPanel(panel, contextManager);
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

  private constructor(panel: vscode.WebviewPanel, contextManager: ContextManager) {
    this._panel = panel;
    this._handler = new ChatHandler(contextManager);
    this._exporter = new MarkdownExporter();
    this._session = this._createNewSession();
    this._panel.webview.html = this._getHtml();
    this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this._handleWebviewMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
  }

  private async _handleWebviewMessage(message: WebviewMessage) {
    if (message.type === 'sendMessage') { await this._handleUserMessage(message.content); }
    else if (message.type === 'newSession') { this._startNewSession(); }
    else if (message.type === 'forceSave') { await this._forceSave(); }
    else if (message.type === 'ready') {
      this._postMessage({ type: 'syncStatus', status: 'Loaded', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
      this._validateConfig();
    }
  }

  private async _handleUserMessage(content: string) {
    const config = vscode.workspace.getConfiguration('contextSync');
    const syncFolder = config.get<string>('syncFolder') ?? '';
    this._resetInactivityTimer();
    const userMsg = { role: 'user' as const, content, timestamp: new Date().toISOString() };
    this._session.messages.push(userMsg);
    this._postMessage({ type: 'addMessage', message: userMsg });
    this._postMessage({ type: 'setLoading', loading: true });
    try {
      const reply = await this._handler.sendMessage(this._session);
      const assistantMsg = { role: 'assistant' as const, content: reply, timestamp: new Date().toISOString() };
      this._session.messages.push(assistantMsg);
      this._postMessage({ type: 'addMessage', message: assistantMsg });
      if (syncFolder) {
        const filePath = await this._exporter.exportSession(this._session, syncFolder);
        if (filePath) {
          this._postMessage({ type: 'syncStatus', status: 'Saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
        } else {
          this._postMessage({ type: 'qualityGateRejected' });
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ContextSync: ${err}`);
      this._postMessage({ type: 'error', message: String(err) });
    } finally {
      this._postMessage({ type: 'setLoading', loading: false });
    }
  }

  private _startNewSession() {
    this._session = this._createNewSession();
    this._postMessage({ type: 'sessionReset' });
  }

  private async _forceSave() {
    const syncFolder = vscode.workspace.getConfiguration('contextSync').get<string>('syncFolder') ?? '';
    if (!syncFolder) { this._postMessage({ type: 'error', message: 'No sync folder configured.' }); return; }
    if (this._session.messages.length < 2) { this._postMessage({ type: 'error', message: 'Nothing to save yet.' }); return; }
    const filePath = await this._exporter.exportSession(this._session, syncFolder, true);
    if (filePath) {
      this._postMessage({ type: 'syncStatus', status: 'Force saved', fileCount: this._handler.contextManager.fileCount, fileNames: this._handler.contextManager.getLoadedFileNames() });
    }
  }

  private _resetInactivityTimer() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      this._startNewSession();
      this._postMessage({ type: 'inactivityReset', message: 'New session started after 30 minutes of inactivity.' });
    }, INACTIVITY_TIMEOUT_MS);
  }

  private _validateConfig() {
    const config = vscode.workspace.getConfiguration('contextSync');
    const warnings: string[] = [];
    if (!config.get<string>('username')) warnings.push('contextSync.username is not set.');
    if (!config.get<string>('syncFolder')) warnings.push('contextSync.syncFolder is not set.');
    if (warnings.length) this._postMessage({ type: 'configWarning', warnings });
  }

  private _postMessage(message: object) { this._panel.webview.postMessage(message); }

  private _createNewSession(): ChatSession {
    const config = vscode.workspace.getConfiguration('contextSync');
    const username = config.get<string>('username') || 'user';
    const date = new Date().toISOString().split('T')[0];
    return { id: `${username}_${date}_${Date.now()}`, username, messages: [], startedAt: new Date().toISOString() };
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ContextSync Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --user-bubble: var(--vscode-editorWidget-background);
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --warn: var(--vscode-editorWarning-foreground);
      --success: #73c991;
      --font: var(--vscode-font-family);
      --font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--font); font-size: var(--font-size); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #config-warning { display: none; background: var(--vscode-inputValidation-warningBackground); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder); padding: 6px 12px; font-size: 11px; color: var(--warn); flex-shrink: 0; }
    #config-warning.visible { display: block; }
    #header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; gap: 8px; }
    #header h1 { font-size: 13px; font-weight: 600; }
    .icon-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .icon-btn:hover { color: var(--fg); border-color: var(--fg); }
    #sync-badge { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 4px; cursor: pointer; position: relative; }
    #sync-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
    #sync-dot.green { background: var(--success); }
    #context-tooltip { display: none; position: absolute; top: calc(100% + 6px); right: 0; background: var(--vscode-editorWidget-background); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; font-size: 11px; z-index: 100; min-width: 200px; max-width: 320px; }
    #context-tooltip.visible { display: block; }
    #context-tooltip ul { margin-top: 4px; padding-left: 14px; color: var(--muted); max-height: 150px; overflow-y: auto; }
    #context-tooltip li { margin-bottom: 2px; word-break: break-all; }
    #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .message { display: flex; flex-direction: column; gap: 3px; max-width: 90%; }
    .message.user { align-self: flex-end; }
    .message.assistant { align-self: flex-start; }
    .message.system { align-self: center; max-width: 100%; }
    .bubble { padding: 8px 12px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    .message.user .bubble { background: var(--button-bg); color: var(--button-fg); border-bottom-right-radius: 2px; }
    .message.assistant .bubble { background: var(--user-bubble); border-bottom-left-radius: 2px; }
    .message.system .bubble { background: transparent; color: var(--muted); font-size: 11px; font-style: italic; text-align: center; padding: 4px 8px; }
    .message.warning .bubble { background: var(--vscode-inputValidation-warningBackground); color: var(--warn); font-size: 11px; }
    .message-meta { font-size: 10px; color: var(--muted); padding: 0 4px; }
    #typing { display: none; align-self: flex-start; padding: 8px 12px; background: var(--user-bubble); border-radius: 8px; font-size: 12px; color: var(--muted); }
    #typing.visible { display: block; }
    #input-bar { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--border); flex-shrink: 0; }
    #input-row { display: flex; gap: 8px; }
    #user-input { flex: 1; background: var(--input-bg); border: 1px solid var(--input-border); color: var(--fg); font-family: var(--font); font-size: var(--font-size); padding: 6px 10px; border-radius: 4px; resize: none; height: 36px; max-height: 120px; outline: none; overflow: hidden; }
    #user-input:focus { border-color: var(--vscode-focusBorder); }
    #send-btn { background: var(--button-bg); color: var(--button-fg); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; flex-shrink: 0; align-self: flex-end; }
    #send-btn:hover { opacity: 0.9; }
    #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #action-row { display: flex; gap: 6px; justify-content: flex-end; }
  </style>
</head>
<body>
  <div id="config-warning"></div>
  <div id="header">
    <h1>⚡ ContextSync</h1>
    <div id="sync-badge" title="Click to see loaded context files">
      <span id="sync-dot"></span>
      <span id="sync-label">Starting…</span>
      <div id="context-tooltip">
        <strong>Loaded context files</strong>
        <ul id="context-file-list"></ul>
      </div>
    </div>
  </div>
  <div id="messages">
    <div class="message assistant">
      <div class="bubble">Hello! I'm ContextSync — your team's shared AI assistant. Ask me anything. Useful conversations will automatically sync to your team's context graph.</div>
    </div>
  </div>
  <div id="typing">AI is thinking…</div>
  <div id="input-bar">
    <div id="input-row">
      <textarea id="user-input" placeholder="Ask something…" rows="1"></textarea>
      <button id="send-btn">Send</button>
    </div>
    <div id="action-row">
      <button class="icon-btn" id="force-save-btn" title="Force save this conversation">💾 Force Save</button>
      <button class="icon-btn" id="new-session-btn" title="Start a fresh chat session">＋ New Session</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const typingEl = document.getElementById('typing');
    const syncLabel = document.getElementById('sync-label');
    const syncDot = document.getElementById('sync-dot');
    const syncBadge = document.getElementById('sync-badge');
    const tooltip = document.getElementById('context-tooltip');
    const fileList = document.getElementById('context-file-list');
    const configWarning = document.getElementById('config-warning');
    const newSessionBtn = document.getElementById('new-session-btn');
    const forceSaveBtn = document.getElementById('force-save-btn');

    syncBadge.addEventListener('click', () => tooltip.classList.toggle('visible'));
    document.addEventListener('click', (e) => { if (!syncBadge.contains(e.target)) tooltip.classList.remove('visible'); });

    newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    forceSaveBtn.addEventListener('click', () => vscode.postMessage({ type: 'forceSave' }));

    function sendMessage() {
      const content = inputEl.value.trim();
      if (!content) return;
      inputEl.value = '';
      inputEl.style.height = '36px';
      vscode.postMessage({ type: 'sendMessage', content });
    }
    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    inputEl.addEventListener('input', () => { inputEl.style.height = '36px'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'addMessage') appendMessage(msg.message);
      if (msg.type === 'setLoading') { typingEl.classList.toggle('visible', msg.loading); sendBtn.disabled = msg.loading; inputEl.disabled = msg.loading; }
      if (msg.type === 'syncStatus') {
        syncLabel.textContent = msg.status + ' · ' + msg.fileCount + ' context file' + (msg.fileCount !== 1 ? 's' : '');
        syncDot.className = msg.fileCount > 0 ? 'green' : '';
        fileList.innerHTML = msg.fileNames && msg.fileNames.length ? msg.fileNames.map(f => '<li>' + f + '</li>').join('') : '<li style="font-style:italic">No files loaded yet</li>';
      }
      if (msg.type === 'qualityGateRejected') appendSystemMessage('💬 Chat not saved — not technically useful enough yet. Keep discussing or use Force Save.');
      if (msg.type === 'sessionReset') appendSystemMessage('─── New session started ───');
      if (msg.type === 'inactivityReset') appendSystemMessage('⏱ ' + msg.message);
      if (msg.type === 'configWarning') { configWarning.textContent = '⚠ ' + msg.warnings.join(' | ') + ' — Open Settings (Ctrl+,) and search "ContextSync".'; configWarning.classList.add('visible'); }
      if (msg.type === 'error') appendWarningMessage('⚠ ' + msg.message);
    });

    function appendMessage(msg) {
      const wrapper = document.createElement('div');
      wrapper.className = 'message ' + msg.role;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = msg.content;
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.textContent = msg.role === 'user' ? 'You · ' + time : 'AI · ' + time;
      wrapper.appendChild(bubble);
      wrapper.appendChild(meta);
      messagesEl.appendChild(wrapper);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function appendSystemMessage(text) {
      const wrapper = document.createElement('div');
      wrapper.className = 'message system';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      wrapper.appendChild(bubble);
      messagesEl.appendChild(wrapper);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function appendWarningMessage(text) {
      const wrapper = document.createElement('div');
      wrapper.className = 'message warning';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      wrapper.appendChild(bubble);
      messagesEl.appendChild(wrapper);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private _dispose() {
    if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}
