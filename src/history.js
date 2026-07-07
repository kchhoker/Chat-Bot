import { config } from './config.js';

// Per-room message history. Backed by a capped Redis list when Redis is
// available (shared by all instances), otherwise an in-memory map.
export function createHistory(redis) {
  const memory = new Map(); // room -> [messages]
  const key = (room) => `chat:history:${room}`;

  return {
    async add(room, message) {
      if (redis.enabled) {
        await redis.client.rPush(key(room), JSON.stringify(message));
        await redis.client.lTrim(key(room), -config.historyLimit, -1);
      } else {
        const list = memory.get(room) ?? [];
        list.push(message);
        if (list.length > config.historyLimit) list.shift();
        memory.set(room, list);
      }
    },

    async get(room) {
      if (redis.enabled) {
        const raw = await redis.client.lRange(key(room), 0, -1);
        return raw.map((r) => JSON.parse(r));
      }
      return memory.get(room) ?? [];
    },
  };
}
