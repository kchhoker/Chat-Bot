import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';
import { setupRedis } from './redis.js';
import { createStore } from './store.js';
import { createBot } from './bot/index.js';
import { registerAssistant } from './assistant.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createApp({ port = config.port } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    // behind nginx the client may fall back to polling before upgrading;
    // both transports work with the Redis adapter
    transports: ['websocket', 'polling'],
  });

  const redis = await setupRedis(io);
  const store = createStore(redis);
  const bot = createBot();

  app.use(express.static(path.join(here, '..', 'public')));
  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, instance: config.instanceName, redis: redis.enabled }),
  );

  registerAssistant(io, { store, bot });

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[server] instance "${config.instanceName}" listening on :${server.address().port}`);

  return {
    io,
    server,
    port: server.address().port,
    async close() {
      io.close();
      await new Promise((resolve) => server.close(resolve));
      await redis.close();
    },
  };
}

// Start immediately when run directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
