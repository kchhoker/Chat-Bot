import { randomUUID } from 'node:crypto';
import { config } from './../config.js';
import { createClaudeBot } from './claudeBot.js';
import { createLocalBot } from './localBot.js';

const MENTION_RE = new RegExp(`(^|\\W)@?${config.botName}\\b|^@?bot\\b`, 'i');

// Wraps the underlying bot (Claude or local fallback) with the chat-side
// plumbing: mention detection, transcript building, streaming the reply to
// the room, and persisting the final message.
export function createBot() {
  const impl = config.anthropicApiKey ? createClaudeBot() : createLocalBot();
  console.log(`[bot] ${config.botName} online (mode: ${impl.mode}${impl.mode === 'claude' ? `, model: ${config.botModel}` : ''})`);

  return {
    mode: impl.mode,

    isAddressed(text) {
      return MENTION_RE.test(text);
    },

    async respond({ io, room, history, trigger }) {
      const recent = await history.get(room);
      const transcript = recent
        .filter((m) => !m.system)
        .slice(-20)
        .map((m) => `${m.username}: ${m.text}`)
        .join('\n');

      const id = randomUUID();
      io.to(room).emit('typing', { username: config.botName, isTyping: true });
      io.to(room).emit('bot-stream', { id, room, phase: 'start' });

      let text;
      try {
        text = await impl.reply(transcript || `${trigger.username}: ${trigger.text}`, (chunk) => {
          io.to(room).emit('bot-stream', { id, room, phase: 'chunk', chunk });
        });
      } finally {
        io.to(room).emit('typing', { username: config.botName, isTyping: false });
      }

      const msg = {
        id,
        room,
        username: config.botName,
        text,
        ts: Date.now(),
        instance: config.instanceName,
        bot: true,
      };
      await history.add(room, msg);
      io.to(room).emit('bot-stream', { id, room, phase: 'end' });
      io.to(room).emit('message', msg);
    },
  };
}
