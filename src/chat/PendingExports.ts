import type * as vscode from 'vscode';
import { ChatSession } from '../types';

const KEY = 'contextSync.pendingExports.v2';
export interface PendingExport { session: ChatSession; destination: string; revision: number; }

export class PendingExports {
  private _entries: Record<string, PendingExport>;
  private _destinations = new Map<string, string>();
  private _acknowledged = new Map<string, number>();
  private _writes: Promise<void> = Promise.resolve();
  constructor(private readonly _state: vscode.Memento) {
    this._entries = Object.create(null) as Record<string, PendingExport>;
    const stored = _state.get<unknown>(KEY);
    if (stored && typeof stored === 'object') {
      for (const entry of Object.values(stored)) {
        if (isPendingExport(entry)) this._entries[entry.session.id] = entry;
      }
    }
  }
  public list(): PendingExport[] { return Object.values(this._entries).map(e => structuredClone(e)); }
  public get(id: string): PendingExport | undefined {
    const value = this._entries[id];
    return value ? structuredClone(value) : undefined;
  }
  public destinationFor(id: string): string | undefined { return this._entries[id]?.destination || this._destinations.get(id); }
  public put(session: ChatSession, destination: string): Promise<void> {
    destination = this.destinationFor(session.id) || destination;
    const messages = session.messages.filter(m => !m.private);
    const progress = Math.max(session.exportedMessageCount ?? 0, this._acknowledged.get(session.id) ?? 0, this._entries[session.id]?.session.exportedMessageCount ?? 0);
    if (!messages.length) return Promise.resolve();
    if (progress >= messages.length) return this._writes;
    const snapshot = structuredClone({ ...session, exportedMessageCount: progress, messages });
    this._entries[session.id] = { session: snapshot, destination, revision: messages.length };
    return this._persist();
  }
  public acknowledge(id: string, revision: number): Promise<void> {
    const entry = this._entries[id];
    if (entry?.destination) this._destinations.set(id, entry.destination);
    this._acknowledged.set(id, Math.max(revision, this._acknowledged.get(id) ?? 0));
    if (entry && entry.revision <= revision) delete this._entries[id];
    else if (entry) entry.session.exportedMessageCount = Math.max(entry.session.exportedMessageCount ?? 0, revision);
    return this._persist();
  }
  public flush(): Promise<void> { return this._writes; }
  private _persist(): Promise<void> {
    const snapshot = structuredClone(this._entries);
    this._writes = this._writes.catch(() => undefined).then(() => this._state.update(KEY, snapshot));
    return this._writes;
  }
}

export function isPendingExport(value: unknown): value is PendingExport {
  if (!value || typeof value !== 'object') return false;
  const e = value as PendingExport;
  const s = e.session;
  return typeof e.destination === 'string' && Number.isSafeInteger(e.revision) && e.revision > 0 &&
    !!s && typeof s.id === 'string' && typeof s.username === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && /^[A-Za-z0-9_-]{1,32}$/.test(s.username) &&
    typeof s.startedAt === 'string' && (s.selectedModel === undefined || typeof s.selectedModel === 'string') && Array.isArray(s.messages) && e.revision === s.messages.length &&
    s.messages.every(m => !!m && !m.private && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && typeof m.timestamp === 'string') &&
    (s.exportedMessageCount === undefined || (Number.isSafeInteger(s.exportedMessageCount) && s.exportedMessageCount >= 0 && s.exportedMessageCount <= s.messages.length));
}
