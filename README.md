# ✦ Chat-Bot — an AI assistant that scales horizontally

A ChatGPT-style AI assistant built on **WebSockets at scale**. Conversations stream in real time over Socket.IO, persist in Redis, and the whole app runs across **any number of server instances** behind a load balancer — Redis pub/sub keeps every instance in sync, so the same user can hit different servers and see one consistent world.

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
                                                    │ pub/sub +  │
                                                    │ chat store │
                                                    └────────────┘
```

**Why this matters:** a naive chat server keeps connections and state in local memory — add a second instance behind a load balancer and everything breaks. Here, every streamed token is published through the [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/), conversations live in Redis, and no instance needs to know the others exist. Kill one, add five — the user never notices.

## Features

- **ChatGPT-style experience** — conversation sidebar, auto-titled chats, welcome screen with suggestions, markdown rendering (tables, code blocks, copy button), token-by-token streaming with a stop button
- **Real AI or zero-config demo** — with `ANTHROPIC_API_KEY` the assistant is a Claude model with full multi-turn context; without it, a built-in offline bot answers (math, jokes, questions about the architecture) using the same streaming pipeline
- **Horizontal scaling** — run 1 or 100 instances; Redis pub/sub fans streamed replies out to every tab on every server
- **Persistent conversations** — stored per anonymous user in Redis, survive reloads, sync live across tabs (create/rename/delete anywhere, see it everywhere)
- **Production touches** — rate limiting, input validation, XSS-safe markdown (DOMPurify), graceful single-instance fallback when Redis is absent, health endpoint

## Quick start (zero config)

```bash
npm install
npm start
# open http://localhost:3000
```

## Enable the real AI

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

## Full cluster (3 instances + nginx + Redis)

```bash
docker compose up --build
# open http://localhost:8080
```

Open the app in two different browsers — the sidebar footer shows which instance each one landed on, while your conversations stay perfectly in sync between them.

## Run multiple instances by hand

```bash
redis-server &   # or: docker run -p 6379:6379 redis:7-alpine

REDIS_URL=redis://localhost:6379 INSTANCE_NAME=chat-1 PORT=3000 npm start &
REDIS_URL=redis://localhost:6379 INSTANCE_NAME=chat-2 PORT=3001 npm start &
```

Open one tab on `:3000` and another on `:3001` — same conversations, and a reply generated on one server streams live into both tabs.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `INSTANCE_NAME` | `pid-<pid>` | Name shown in the sidebar footer |
| `REDIS_URL` | *(unset)* | Redis connection; unset = single-instance mode |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables the Claude-powered assistant |
| `BOT_MODEL` | `claude-opus-4-8` | Claude model for the assistant |

## Tests

The integration suite boots **two real server instances** sharing a Redis and proves the scaling claims end to end:

```bash
redis-server --daemonize yes   # tests skip gracefully if Redis is absent
npm test
```

Covered: conversations created on one instance appear on the other, user messages and **streamed** assistant replies mirror across instances, auto-titling, shared history, multi-turn context, per-user access control, cross-instance deletes, and flood protection.

## How the scaling works

1. **Pub/sub fan-out.** Each instance registers the `@socket.io/redis-adapter`. Every `emit` — including each streamed token — publishes to Redis and is re-broadcast by whichever instances hold sockets in that room.
2. **State lives in Redis, not process memory.** Conversations and messages are Redis hashes/lists keyed per user, so any instance can serve any request.
3. **Rooms scope the traffic.** Each conversation is a Socket.IO room (`conv:<uid>:<id>`), and each user has a room (`user:<uid>`) for sidebar sync — only interested sockets receive events, wherever they're connected.
4. **Sticky sessions at the balancer.** nginx `ip_hash` pins each client to one instance, which Socket.IO's HTTP long-polling fallback requires (WebSocket-only clients would work without it).
5. **Stateless instances.** The assistant generates on whichever instance received the message; the reply streams out cluster-wide. Any instance can crash or be added at any time.

## Project structure

```
src/
  server.js        entry point — Express + Socket.IO + wiring
  config.js        env-driven configuration
  redis.js         Redis clients + Socket.IO pub/sub adapter (optional)
  assistant.js     socket protocol: conversations, messages, streaming replies
  store.js         per-user conversation store (Redis or in-memory)
  bot/
    index.js       picks the bot implementation
    claudeBot.js   Claude API assistant (multi-turn, streaming, abortable)
    localBot.js    zero-config offline fallback (same streaming pipeline)
public/            single-page frontend — vanilla JS, no build step
  vendor/          marked (markdown) + DOMPurify (sanitizer)
test/
  scale.test.js    2-instance integration suite proving the scaling story
nginx/nginx.conf   websocket-aware load balancer config
docker-compose.yml redis + 3 app instances + nginx
```
