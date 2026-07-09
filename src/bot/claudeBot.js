import Anthropic from '@anthropic-ai/sdk';
import { config } from './../config.js';

const SYSTEM_PROMPT = `You are a helpful, knowledgeable AI assistant inside a chat application.
Be conversational and clear. Use markdown when it helps (lists, tables, fenced code blocks with a
language tag), but don't over-format short answers. Match the length of your reply to the question —
short question, short answer.`;

export function createClaudeBot() {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    mode: 'claude',

    // messages: [{role: 'user'|'assistant', content: string}, ...] ending with
    // the newest user message. Streams deltas via onDelta and returns the full
    // text. Aborting via the signal returns whatever was generated so far.
    async reply({ messages, onDelta, signal }) {
      const stream = client.messages.stream({
        model: config.botModel,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      });

      if (signal) {
        if (signal.aborted) stream.abort();
        else signal.addEventListener('abort', () => stream.abort(), { once: true });
      }

      let text = '';
      stream.on('text', (delta) => {
        text += delta;
        onDelta?.(delta);
      });

      try {
        await stream.finalMessage();
      } catch (err) {
        // user pressed stop — return the partial reply
        if (err instanceof Anthropic.APIUserAbortError) return text;
        throw err;
      }
      return text;
    },
  };
}
