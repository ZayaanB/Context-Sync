import * as vscode from 'vscode';
import { ChatTurn } from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60 * 1000;

// tie an abort signal to the vscode cancellation token plus a hard timeout
function makeSignal(token?: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const sub = token?.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timeout); sub?.dispose(); },
  };
}

// anthropic requires strictly alternating roles starting with user
function mergeConsecutiveTurns(turns: ChatTurn[]): ChatTurn[] {
  const merged: ChatTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.content += `\n\n${t.content}`;
    } else {
      merged.push({ ...t });
    }
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(conversation continues)' });
  }
  return merged;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return (body?.error?.message ?? res.statusText).slice(0, 200);
  } catch {
    return res.statusText;
  }
}

// user cancellation stays silent but a timeout must surface as an error
function mapAbort(err: unknown, signal: AbortSignal, provider: string, token?: vscode.CancellationToken): never {
  if (signal.aborted) {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    throw new Error(`${provider} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
  }
  throw err;
}

export async function completeAnthropic(
  apiKey: string,
  model: string,
  turns: ChatTurn[],
  maxTokens: number,
  token?: vscode.CancellationToken
): Promise<string> {
  const { signal, dispose } = makeSignal(token);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: mergeConsecutiveTurns(turns),
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error (${res.status}): ${await readError(res)}`);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text.trim()) throw new Error('Anthropic returned an empty response.');
    return text;
  } catch (err) {
    mapAbort(err, signal, 'Anthropic', token);
  } finally {
    dispose();
  }
}

export async function completeOpenAI(
  apiKey: string,
  model: string,
  turns: ChatTurn[],
  maxTokens: number,
  token?: vscode.CancellationToken
): Promise<string> {
  const { signal, dispose } = makeSignal(token);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API error (${res.status}): ${await readError(res)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new Error('OpenAI returned an empty response.');
    return text;
  } catch (err) {
    mapAbort(err, signal, 'OpenAI', token);
  } finally {
    dispose();
  }
}
