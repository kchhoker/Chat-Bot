import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const USERNAME_RE = /^[\w .\-]{1,32}$/;
const ROOM_RE = /^[\w\-]{1,32}$/;

export function registerChat(io, { history, presence, bot }) {
  io.on('connection', (socket) => {
    // sliding-window rate limit, per connection
    let windowStart = Date.now();
    let windowCount = 0;

    const systemMessage = (room, text) => {
      const msg = {
        id: randomUUID(),
        room,
        username: 'system',
        text,
        ts: Date.now(),
        instance: config.instanceName,
        system: true,
      };
      io.to(room).emit('message', msg);
    };

    socket.on('join', async ({ username, room }, ack) => {
      username = String(username ?? '').trim();
      room = String(room ?? 'general').trim().toLowerCase() || 'general';
      if (!USERNAME_RE.test(username)) {
        return ack?.({ ok: false, error: 'Invalid username (1-32 letters, numbers, spaces, . _ -).' });
      }
      if (!ROOM_RE.test(room)) {
        return ack?.({ ok: false, error: 'Invalid room name (1-32 letters, numbers, _ -).' });
      }
      if (username.toLowerCase() === config.botName.toLowerCase() || username.toLowerCase() === 'system') {
        return ack?.({ ok: false, error: 'That name is reserved.' });
      }

      const previousRoom = socket.data.room;
      if (previousRoom && previousRoom !== room) {
        socket.leave(previousRoom);
        systemMessage(previousRoom, `${socket.data.username} left`);
        await presence.broadcast(previousRoom);
      }

      const isNew = previousRoom !== room;
      socket.data.username = username;
      socket.data.room = room;
      socket.join(room);

      const messages = await history.get(room);
      ack?.({
        ok: true,
        room,
        username,
        instance: config.instanceName,
        botName: config.botName,
        botMode: bot.mode,
        messages,
      });

      if (isNew) {
        systemMessage(room, `${username} joined`);
      }
      await presence.broadcast(room);
    });

    socket.on('message', async ({ text }, ack) => {
      const { username, room } = socket.data;
      if (!username || !room) return ack?.({ ok: false, error: 'Join a room first.' });

      const now = Date.now();
      if (now - windowStart > config.rateLimit.windowMs) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > config.rateLimit.maxMessages) {
        return ack?.({ ok: false, error: 'Slow down — you are sending messages too fast.' });
      }

      text = String(text ?? '').trim().slice(0, config.maxMessageLength);
      if (!text) return ack?.({ ok: false, error: 'Empty message.' });

      const msg = {
        id: randomUUID(),
        room,
        username,
        text,
        ts: now,
        instance: config.instanceName,
      };
      await history.add(room, msg);
      io.to(room).emit('message', msg);
      ack?.({ ok: true });

      // Hand off to the bot if it was addressed. The bot runs on whichever
      // instance received the message; its reply fans out through the Redis
      // adapter to clients on every instance.
      if (bot.isAddressed(text)) {
        bot.respond({ io, room, history, trigger: msg }).catch((err) => {
          console.error('[bot] failed to respond:', err);
          systemMessage(room, `${config.botName} could not reply (${err.message ?? 'unknown error'})`);
        });
      }
    });

    socket.on('typing', (isTyping) => {
      const { username, room } = socket.data;
      if (!username || !room) return;
      socket.to(room).emit('typing', { username, isTyping: Boolean(isTyping) });
    });

    socket.on('disconnect', async () => {
      const { username, room } = socket.data;
      if (!username || !room) return;
      try {
        systemMessage(room, `${username} left`);
        await presence.broadcast(room);
      } catch (err) {
        // emitting can fail if this instance is shutting down — not fatal
        console.warn(`[chat] disconnect cleanup failed: ${err.message}`);
      }
    });
  });
}
