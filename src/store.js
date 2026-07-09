import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Per-user conversation storage. Backed by Redis when available (shared by
// every instance, so a user can hit any server behind the load balancer),
// otherwise an in-memory map for single-instance/zero-config mode.
//
// Keys:
//   ai:convs:<uid>          hash  convId -> {id,title,createdAt,updatedAt}
//   ai:msgs:<uid>:<convId>  list  of {id,role,content,ts,instance}
export function createStore(redis) {
  const memConvs = new Map(); // uid -> Map(convId -> meta)
  const memMsgs = new Map(); // `${uid}:${convId}` -> [messages]

  const convsKey = (uid) => `ai:convs:${uid}`;
  const msgsKey = (uid, id) => `ai:msgs:${uid}:${id}`;

  async function saveMeta(uid, meta) {
    if (redis.enabled) {
      await redis.client.hSet(convsKey(uid), meta.id, JSON.stringify(meta));
    } else {
      if (!memConvs.has(uid)) memConvs.set(uid, new Map());
      memConvs.get(uid).set(meta.id, meta);
    }
  }

  return {
    async listConversations(uid) {
      let metas;
      if (redis.enabled) {
        const raw = await redis.client.hGetAll(convsKey(uid));
        metas = Object.values(raw).map((v) => JSON.parse(v));
      } else {
        metas = [...(memConvs.get(uid)?.values() ?? [])];
      }
      return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getConversation(uid, id) {
      if (redis.enabled) {
        const raw = await redis.client.hGet(convsKey(uid), id);
        return raw ? JSON.parse(raw) : null;
      }
      return memConvs.get(uid)?.get(id) ?? null;
    },

    async createConversation(uid) {
      const now = Date.now();
      const meta = { id: randomUUID(), title: 'New chat', createdAt: now, updatedAt: now };
      await saveMeta(uid, meta);
      return meta;
    },

    async setTitle(uid, id, title) {
      const meta = await this.getConversation(uid, id);
      if (!meta) return null;
      meta.title = title;
      meta.updatedAt = Date.now();
      await saveMeta(uid, meta);
      return meta;
    },

    async deleteConversation(uid, id) {
      if (redis.enabled) {
        await redis.client.hDel(convsKey(uid), id);
        await redis.client.del(msgsKey(uid, id));
      } else {
        memConvs.get(uid)?.delete(id);
        memMsgs.delete(`${uid}:${id}`);
      }
    },

    async addMessage(uid, convId, message) {
      const meta = await this.getConversation(uid, convId);
      if (!meta) throw new Error('conversation not found');
      if (redis.enabled) {
        await redis.client.rPush(msgsKey(uid, convId), JSON.stringify(message));
        await redis.client.lTrim(msgsKey(uid, convId), -config.historyLimit, -1);
      } else {
        const key = `${uid}:${convId}`;
        const list = memMsgs.get(key) ?? [];
        list.push(message);
        if (list.length > config.historyLimit) list.shift();
        memMsgs.set(key, list);
      }
      meta.updatedAt = Date.now();
      await saveMeta(uid, meta);
    },

    async getMessages(uid, convId) {
      if (redis.enabled) {
        const raw = await redis.client.lRange(msgsKey(uid, convId), 0, -1);
        return raw.map((r) => JSON.parse(r));
      }
      return memMsgs.get(`${uid}:${convId}`) ?? [];
    },
  };
}
