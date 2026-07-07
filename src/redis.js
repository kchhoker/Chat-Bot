import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from './config.js';

// Wires Socket.IO to Redis pub/sub so every server instance sees every
// event. Returns the clients so other modules (history, presence) can
// share them. When REDIS_URL is unset the app degrades gracefully to a
// single-instance in-memory mode.
export async function setupRedis(io) {
  if (!config.redisUrl) {
    console.log('[redis] REDIS_URL not set — running in single-instance mode');
    return { enabled: false, client: null, close: async () => {} };
  }

  const pubClient = createClient({ url: config.redisUrl });
  const subClient = pubClient.duplicate();
  const dataClient = pubClient.duplicate();

  for (const c of [pubClient, subClient, dataClient]) {
    c.on('error', (err) => console.error('[redis] error:', err.message));
  }

  await Promise.all([pubClient.connect(), subClient.connect(), dataClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.log(`[redis] connected — pub/sub adapter active (${config.redisUrl})`);

  return {
    enabled: true,
    client: dataClient,
    async close() {
      await Promise.allSettled([pubClient.quit(), subClient.quit(), dataClient.quit()]);
    },
  };
}
