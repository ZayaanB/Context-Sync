import { ChatTurn } from './types';

export function modelInputBudget(maxInputTokens: number, outputTokens = 4096): number {
  return Math.max(1, maxInputTokens - Math.min(outputTokens, Math.floor(maxInputTokens / 4)));
}

// Drop complete older exchanges; never silently cut the current user prompt.
export async function fitPrompt(
  turns: ChatTurn[], budget: number,
  count: (turn: ChatTurn) => Promise<number> = async t => Buffer.byteLength(t.content, 'utf8') + 16
): Promise<ChatTurn[]> {
  if (!Number.isFinite(budget) || budget < 1) throw new Error('Invalid model input budget.');
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('A prompt must end with a user message.');
  const costs = await Promise.all(turns.map(count));
  if (costs.some(cost => !Number.isFinite(cost) || cost < 0)) throw new Error('Invalid model token count.');
  let result = turns.map((turn, index) => ({ turn, cost: costs[index] + 8 }));
  while (result.reduce((sum, t) => sum + t.cost, 0) > budget && result.length > 1) {
    result.shift();
    while (result.length > 1 && result[0].turn.role !== 'user') result.shift();
  }
  if (result.reduce((sum, t) => sum + t.cost, 0) > budget) {
    throw new Error('Your message exceeds this model’s input budget. Shorten it or choose a model with a larger context window.');
  }
  return result.map(t => t.turn);
}
