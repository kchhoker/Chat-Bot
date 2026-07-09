import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const UID_RE = /^[\w-]{8,64}$/;

// Socket protocol:
//   client → server
//     conversations            (ack: {ok, conversations})
//     conversation:new         (ack: {ok, conversation})
//     conversation:open  {id}  (ack: {ok, conversation, messages}) — joins the conv room
//     conversation:delete {id} (ack: {ok})
//     message:send {conversationId, text} (ack: {ok, id})
//     assistant:stop {conversationId}
//   server → client (to everyone viewing that conversation, on any instance)
//     message:new     {conversationId, message}
//     assistant:start {conversationId, id}
//     assistant:delta {conversationId, id, delta}
//     assistant:done  {conversationId, message}
//     assistant:error {conversationId, id, error}
//     conversation:updated {conversation}   (title changes, etc.)
export function registerAssistant(io, { store, bot }) {
  // in-flight generations on THIS instance, so "stop" can abort them
  const inflight = new Map(); // `${uid}:${convId}` -> AbortController

  io.use((socket, next) => {
    const uid = String(socket.handshake.auth?.uid ?? '');
    if (!UID_RE.test(uid)) return next(new Error('invalid uid'));
    socket.data.uid = uid;
    next();
  });

  io.on('connection', (socket) => {
    const { uid } = socket.data;
    const room = (convId) => `conv:${uid}:${convId}`;
    const userRoom = `user:${uid}`;
    socket.join(userRoom); // all of this user's tabs, on every instance

    let windowStart = Date.now();
    let windowCount = 0;

    socket.emit('ready', {
      instance: config.instanceName,
      botMode: bot.mode,
      model: bot.mode === 'claude' ? config.botModel : null,
    });

    socket.on('conversations', async (ack) => {
      try {
        ack?.({ ok: true, conversations: await store.listConversations(uid) });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('conversation:new', async (ack) => {
      try {
        const existing = await store.listConversations(uid);
        if (existing.length >= config.maxConversations) {
          return ack?.({ ok: false, error: `Limit of ${config.maxConversations} chats reached — delete some first.` });
        }
        const conversation = await store.createConversation(uid);
        io.to(userRoom).emit('conversation:created', { conversation });
        ack?.({ ok: true, conversation });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('conversation:open', async ({ id } = {}, ack) => {
      try {
        const conversation = await store.getConversation(uid, String(id ?? ''));
        if (!conversation) return ack?.({ ok: false, error: 'Conversation not found.' });
        // leave other conversation rooms, join this one
        for (const r of socket.rooms) {
          if (r.startsWith('conv:')) socket.leave(r);
        }
        socket.join(room(conversation.id));
        const messages = await store.getMessages(uid, conversation.id);
        ack?.({ ok: true, conversation, messages });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('conversation:delete', async ({ id } = {}, ack) => {
      try {
        inflight.get(`${uid}:${id}`)?.abort();
        await store.deleteConversation(uid, String(id ?? ''));
        io.to(userRoom).emit('conversation:deleted', { id });
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('message:send', async ({ conversationId, text } = {}, ack) => {
      try {
        const now = Date.now();
        if (now - windowStart > config.rateLimit.windowMs) {
          windowStart = now;
          windowCount = 0;
        }
        if (++windowCount > config.rateLimit.maxMessages) {
          return ack?.({ ok: false, error: 'You are sending messages too quickly — give me a moment.' });
        }

        text = String(text ?? '').trim().slice(0, config.maxMessageLength);
        if (!text) return ack?.({ ok: false, error: 'Empty message.' });

        const conversation = await store.getConversation(uid, String(conversationId ?? ''));
        if (!conversation) return ack?.({ ok: false, error: 'Conversation not found.' });
        const convId = conversation.id;

        if (inflight.has(`${uid}:${convId}`)) {
          return ack?.({ ok: false, error: 'Wait for the current reply to finish (or stop it).' });
        }

        const userMsg = { id: randomUUID(), role: 'user', content: text, ts: now, instance: config.instanceName };
        await store.addMessage(uid, convId, userMsg);
        io.to(room(convId)).emit('message:new', { conversationId: convId, message: userMsg });
        ack?.({ ok: true, id: userMsg.id });

        // first message names the chat
        if (conversation.title === 'New chat') {
          const title = text.length > 42 ? `${text.slice(0, 42).trimEnd()}…` : text;
          const updated = await store.setTitle(uid, convId, title);
          if (updated) io.to(userRoom).emit('conversation:updated', { conversation: updated });
        }

        await generateReply(convId);
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('assistant:stop', ({ conversationId } = {}) => {
      inflight.get(`${uid}:${conversationId}`)?.abort();
    });

    async function generateReply(convId) {
      const key = `${uid}:${convId}`;
      const replyId = randomUUID();
      const controller = new AbortController();
      inflight.set(key, controller);
      io.to(room(convId)).emit('assistant:start', { conversationId: convId, id: replyId });

      try {
        const history = (await store.getMessages(uid, convId))
          .slice(-config.contextTurns)
          .map((m) => ({ role: m.role, content: m.content }));

        const content = await bot.reply({
          messages: history,
          signal: controller.signal,
          onDelta: (delta) =>
            io.to(room(convId)).emit('assistant:delta', { conversationId: convId, id: replyId, delta }),
        });

        const message = {
          id: replyId,
          role: 'assistant',
          content: content || '*(stopped before I could answer)*',
          ts: Date.now(),
          instance: config.instanceName,
        };
        await store.addMessage(uid, convId, message);
        io.to(room(convId)).emit('assistant:done', { conversationId: convId, message });
      } catch (err) {
        console.error('[assistant] generation failed:', err.message);
        try {
          io.to(room(convId)).emit('assistant:error', {
            conversationId: convId,
            id: replyId,
            error: 'The assistant could not reply. Please try again.',
          });
        } catch {
          /* instance shutting down — nothing to notify */
        }
      } finally {
        inflight.delete(key);
      }
    }
  });
}
