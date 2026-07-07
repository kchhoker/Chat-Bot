import Anthropic from '@anthropic-ai/sdk';
import { config } from './../config.js';

const SYSTEM_PROMPT = `You are ${config.botName}, a friendly assistant living inside a multi-room chat app.
You are talking in a public chat room, so keep replies short and conversational — a few sentences at most,
plain text (no markdown headers or code fences unless someone asks for code). You receive a recent
transcript of the room; reply to the last message that mentioned you. Never invent messages from other users.`;

export function createClaudeBot() {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    mode: 'claude',
    // Streams the reply: onChunk fires per text delta, returns the full text.
    async reply(transcript, onChunk) {
      const stream = client.messages.stream({
        model: config.botModel,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: transcript }],
      });
      stream.on('text', (delta) => onChunk?.(delta));
      const final = await stream.finalMessage();
      return final.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
  };
}
