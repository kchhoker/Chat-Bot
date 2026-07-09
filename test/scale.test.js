// Proves the horizontal-scaling story end to end: two independent server
// instances share nothing but Redis, yet a user connected to BOTH (e.g. two
// browser tabs landing on different servers) sees one consistent world —
// same conversation list, messages and streamed assistant replies on each.
//
// Requires a local Redis (redis://localhost:6379); tests are skipped if
// it isn't reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { io as connect } from 'socket.io-client';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.REDIS_URL = REDIS_URL;
delete process.env.ANTHROPIC_API_KEY; // force the deterministic local bot

async function redisAvailable() {
  const probe = createClient({ url: REDIS_URL });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.quit();
    return true;
  } catch {
    return false;
  }
}

function once(socket, event, predicate = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const call = (socket, event, payload) =>
  new Promise((resolve) =>
    payload === undefined ? socket.emit(event, resolve) : socket.emit(event, payload, resolve),
  );

test('assistant chat scales across two server instances via Redis pub/sub', async (t) => {
  if (!(await redisAvailable())) {
    t.skip(`Redis not reachable at ${REDIS_URL}`);
    return;
  }

  const { createApp } = await import('../src/server.js');
  const instanceA = await createApp({ port: 0 });
  const instanceB = await createApp({ port: 0 });

  const uid = randomUUID();
  // same user, two tabs, two different servers
  const tabA = connect(`http://localhost:${instanceA.port}`, { transports: ['websocket'], auth: { uid } });
  const tabB = connect(`http://localhost:${instanceB.port}`, { transports: ['websocket'], auth: { uid } });

  t.after(async () => {
    tabA.close();
    tabB.close();
    await new Promise((r) => setTimeout(r, 200));
    await instanceA.close();
    await instanceB.close();
  });

  let convId;

  await t.test('conversation created on instance A is listed on instance B', async () => {
    const created = await call(tabA, 'conversation:new');
    assert.ok(created.ok, created.error);
    convId = created.conversation.id;

    const list = await call(tabB, 'conversations');
    assert.ok(list.ok && list.conversations.some((c) => c.id === convId));
  });

  await t.test('message + streamed reply on A are mirrored to the tab on B', async () => {
    await call(tabA, 'conversation:open', { id: convId });
    await call(tabB, 'conversation:open', { id: convId });

    const sawUserMsg = once(tabB, 'message:new', (p) => p.message.role === 'user');
    const sawDelta = once(tabB, 'assistant:delta', (p) => p.conversationId === convId);
    const sawDone = once(tabB, 'assistant:done', (p) => p.conversationId === convId);

    const sent = await call(tabA, 'message:send', { conversationId: convId, text: 'hello there' });
    assert.ok(sent.ok, sent.error);

    assert.equal((await sawUserMsg).message.content, 'hello there');
    await sawDelta; // streaming chunks crossed instances
    const done = await sawDone;
    assert.equal(done.message.role, 'assistant');
    assert.ok(done.message.content.length > 0);
  });

  await t.test('first message auto-titles the conversation everywhere', async () => {
    const list = await call(tabB, 'conversations');
    const conv = list.conversations.find((c) => c.id === convId);
    assert.equal(conv.title, 'hello there');
  });

  await t.test('history is shared: opening on B returns messages sent via A', async () => {
    const res = await call(tabB, 'conversation:open', { id: convId });
    assert.ok(res.ok);
    assert.equal(res.messages.length, 2); // user + assistant
    assert.equal(res.messages[0].role, 'user');
    assert.equal(res.messages[1].role, 'assistant');
  });

  await t.test('multi-turn context is preserved (assistant answers follow-up math)', async () => {
    const sawDone = once(tabA, 'assistant:done', (p) => p.conversationId === convId);
    await call(tabA, 'message:send', { conversationId: convId, text: 'what is 12*(3+4)?' });
    const done = await sawDone;
    assert.ok(done.message.content.includes('84'), `expected math answer, got: ${done.message.content}`);
  });

  await t.test('deleting on B removes it for A', async () => {
    const del = await call(tabB, 'conversation:delete', { id: convId });
    assert.ok(del.ok);
    const list = await call(tabA, 'conversations');
    assert.ok(!list.conversations.some((c) => c.id === convId));
  });

  await t.test('users cannot open conversations without the owning uid', async () => {
    const created = await call(tabA, 'conversation:new');
    const stranger = connect(`http://localhost:${instanceB.port}`, {
      transports: ['websocket'],
      auth: { uid: randomUUID() },
    });
    t.after(() => stranger.close());
    const res = await call(stranger, 'conversation:open', { id: created.conversation.id });
    assert.equal(res.ok, false);
  });
});

test('rate limiting rejects a flood of messages', async (t) => {
  if (!(await redisAvailable())) {
    t.skip(`Redis not reachable at ${REDIS_URL}`);
    return;
  }
  const { createApp } = await import('../src/server.js');
  const app = await createApp({ port: 0 });
  const spammer = connect(`http://localhost:${app.port}`, {
    transports: ['websocket'],
    auth: { uid: randomUUID() },
  });
  t.after(async () => {
    spammer.close();
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
  });

  const created = await call(spammer, 'conversation:new');
  const convId = created.conversation.id;
  await call(spammer, 'conversation:open', { id: convId });

  const replyFinished = once(spammer, 'assistant:done', () => true, 15000);
  const results = [];
  for (let i = 0; i < 15; i++) {
    results.push(await call(spammer, 'message:send', { conversationId: convId, text: `msg ${i}` }));
  }
  const rejected = results.filter((r) => !r.ok);
  assert.ok(rejected.length > 0, 'expected some messages to be rejected');
  await replyFinished; // let the one in-flight generation settle before teardown
});
