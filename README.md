# 💬 Chat-Bot — Real-Time Chat with WebSockets at Scale

A real-time, multi-room chat application built to demonstrate **horizontal scaling**, not just CRUD. Any number of server instances can run side by side — Redis pub/sub keeps them all in sync, so two users connected to *different* servers still chat in the same room seamlessly. A built-in AI chatbot (Claude API, with a zero-config local fallback) lives in every room.

```
                        ┌──────────────────────┐
   Browser A ──ws──►    │                      │    ┌────────────┐
   Browser B ──ws──►    │   nginx (ip_hash)    │    │   chat-1   │◄─┐
   Browser C ──ws──►    │   load balancer      ├───►│   chat-2   │  │  Socket.IO
                        │      :8080           │    │   chat-3   │  │  Redis adapter
                        └──────────────────────┘    └─────┬──────┘  │  (pub/sub)
                                                          │         │
                                                    ┌─────▼──────┐  │
                                                    │   Redis    │◄─┘
                                                    │  pub/sub + │
                                                    │  history   │
                                                    └────────────┘
```

**Why this matters:** a naive Socket.IO server keeps connections and rooms in local memory. Add a second instance behind a load balancer and users on instance A can no longer see messages from users on instance B. This project solves that with the [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) — every `emit` is published through Redis and re-broadcast by every instance, message history lives in capped Redis lists shared by the cluster, and presence is computed cluster-wide with `fetchSockets()`.

## Features

- **Multi-room chat** over WebSockets (Socket.IO, with long-polling fallback)
- **Horizontal scaling** via Redis pub/sub — run 1 or 100 instances, behavior is identical
- **Shared message history** (capped Redis lists) — late joiners see recent messages regardless of which instance they land on
- **Cluster-wide presence** — the online-users list covers every instance
- **Typing indicators** that cross instance boundaries
- **AI chatbot** — mention `@ChatBot` in any room:
  - with `ANTHROPIC_API_KEY` set: powered by the Claude API, replies **streamed token-by-token** to every client on every instance
  - without a key: a local rule-based bot (greetings, math, coin flips, server info) so the app works with zero config
- **Instance badges** — every message shows which server handled it, so you can *see* the load balancing work
- **Rate limiting** (sliding window per connection) and input validation
- **Graceful degradation** — no Redis? Runs in single-instance mode with in-memory history.

## Quick start (single instance, zero config)

```bash
npm install
npm start
# open http://localhost:3000
```

## Full cluster (3 instances + nginx + Redis)

```bash
docker compose up --build
# open http://localhost:8080
```

Open the app in two browsers (or a normal + private window) — the sidebar and message badges show which instance each user landed on, while chat flows freely between them.

## Run multiple instances by hand

```bash
redis-server &  # or: docker run -p 6379:6379 redis:7-alpine

REDIS_URL=redis://localhost:6379 INSTANCE_NAME=chat-1 PORT=3000 npm start &
REDIS_URL=redis://localhost:6379 INSTANCE_NAME=chat-2 PORT=3001 npm start &

# connect one tab to :3000 and another to :3001 — same rooms, shared history
```

## Enable the AI bot

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start            # or docker compose up (the key is passed through)
```

Then mention the bot in chat: `@ChatBot explain how this app scales`. The bot runs on whichever instance receives the triggering message; its streamed reply fans out through Redis to clients everywhere.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `INSTANCE_NAME` | `pid-<pid>` | Name shown on message badges |
| `REDIS_URL` | *(unset)* | Redis connection; unset = single-instance mode |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables the Claude-powered bot |
| `BOT_MODEL` | `claude-opus-4-8` | Claude model for the bot |

## Tests

The integration suite boots **two real server instances** sharing a Redis and proves the scaling claims end to end:

```bash
redis-server --daemonize yes   # tests skip gracefully if Redis is absent
npm test
```

Covered: cross-instance message delivery, cluster-wide presence, shared history for late joiners, bot replies fanning out across instances, typing indicators across instances, and rate limiting.

## How the scaling works

1. **Pub/sub fan-out.** Each instance registers the `@socket.io/redis-adapter`. `io.to(room).emit(...)` publishes to a Redis channel; every instance subscribed to that channel re-emits to its own local sockets. No instance needs to know the others exist.
2. **Shared state lives in Redis, not process memory.** Message history is a `RPUSH`/`LTRIM`-capped list per room. Any instance can serve a room's history to a late joiner.
3. **Presence without stored state.** `io.in(room).fetchSockets()` performs a cluster-wide request/response over Redis and returns sockets from *all* instances — presence can never drift out of sync because it's derived from live connections.
4. **Sticky sessions at the balancer.** nginx `ip_hash` pins each client to one instance, which Socket.IO's HTTP long-polling fallback requires (WebSocket-only clients would work without it).
5. **Stateless instances.** Any instance can crash or be added at any time; clients reconnect through the balancer, re-join their room, and continue.

## Project structure

```
src/
  server.js       entry point — Express + Socket.IO + wiring
  config.js       env-driven configuration
  redis.js        Redis clients + Socket.IO pub/sub adapter (optional)
  chat.js         socket handlers: join/message/typing/disconnect
  history.js      capped per-room history (Redis list or in-memory)
  presence.js     cluster-wide online users via fetchSockets()
  bot/
    index.js      mention detection, transcript building, streaming plumbing
    claudeBot.js  Claude API bot (streaming)
    localBot.js   zero-config rule-based fallback
public/           single-page frontend (vanilla JS, no build step)
test/
  scale.test.js   2-instance integration suite proving the scaling story
nginx/nginx.conf  websocket-aware load balancer config
docker-compose.yml  redis + 3 app instances + nginx
```
