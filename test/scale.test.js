// Proves the horizontal-scaling story end to end: two independent server
// instances share nothing but Redis, yet a message sent to instance A is
// delivered to a client connected to instance B, presence is cluster-wide,
// and the bot reply fans out across instances.
//
// Requires a local Redis (redis://localhost:6379); tests are skipped if
// it isn't reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
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

function once(socket, event, predicate = () => true, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      ms,
    );
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

function joinRoom(socket, username, room) {
  return new Promise((resolve, reject) => {
    socket.emit('join', { username, room }, (res) =>
      res?.ok ? resolve(res) : reject(new Error(res?.error ?? 'join failed')),
    );
  });
}

test('chat scales across two server instances via Redis pub/sub', async (t) => {
  if (!(await redisAvailable())) {
    t.skip(`Redis not reachable at ${REDIS_URL}`);
    return;
  }

  const { createApp } = await import('../src/server.js');
  const room = `test-${Date.now()}`;

  const instanceA = await createApp({ port: 0 });
  const instanceB = await createApp({ port: 0 });

  const alice = connect(`http://localhost:${instanceA.port}`, { transports: ['websocket'] });
  const bob = connect(`http://localhost:${instanceB.port}`, { transports: ['websocket'] });

  t.after(async () => {
    alice.close();
    bob.close();
    // let disconnect handlers settle before tearing the servers down
    await new Promise((r) => setTimeout(r, 200));
    await instanceA.close();
    await instanceB.close();
  });

  await t.test('presence is visible cluster-wide', async () => {
    await joinRoom(alice, 'alice', room);
    const [presence] = await Promise.all([
      once(bob, 'presence', (p) => p.users.length === 2),
      joinRoom(bob, 'bob', room),
    ]);
    assert.deepEqual(presence.users, ['alice', 'bob']);
  });

  await t.test('message sent to instance A reaches client on instance B', async () => {
    const waiting = once(bob, 'message', (m) => m.username === 'alice');
    alice.emit('message', { text: 'hello across instances!' }, () => {});
    const received = await waiting;
    assert.equal(received.text, 'hello across instances!');
    assert.equal(received.room, room);
  });

  await t.test('history is shared: a late joiner on instance B sees the message', async () => {
    const charlie = connect(`http://localhost:${instanceB.port}`, { transports: ['websocket'] });
    t.after(() => charlie.close());
    const res = await joinRoom(charlie, 'charlie', room);
    assert.ok(
      res.messages.some((m) => m.text === 'hello across instances!'),
      'expected history to include the earlier message',
    );
  });

  await t.test('bot reply triggered on instance A arrives on instance B', async () => {
    const waiting = once(bob, 'message', (m) => m.bot === true, 8000);
    alice.emit('message', { text: '@ChatBot which server are you on?' }, () => {});
    const reply = await waiting;
    assert.equal(reply.username, 'ChatBot');
    assert.ok(reply.text.length > 0);
  });

  await t.test('typing indicators cross instances', async () => {
    const waiting = once(bob, 'typing', (p) => p.username === 'alice' && p.isTyping);
    alice.emit('typing', true);
    await waiting;
  });
});

test('rate limiting rejects a flood of messages', async (t) => {
  if (!(await redisAvailable())) {
    t.skip(`Redis not reachable at ${REDIS_URL}`);
    return;
  }
  const { createApp } = await import('../src/server.js');
  const app = await createApp({ port: 0 });
  const spammer = connect(`http://localhost:${app.port}`, { transports: ['websocket'] });
  t.after(async () => {
    spammer.close();
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
  });

  await joinRoom(spammer, 'spammer', `flood-${Date.now()}`);
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      new Promise((resolve) => spammer.emit('message', { text: `msg ${i}` }, resolve)),
    ),
  );
  const rejected = results.filter((r) => !r.ok);
  assert.ok(rejected.length > 0, 'expected some messages to be rate limited');
});
