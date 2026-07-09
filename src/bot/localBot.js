import { config } from './../config.js';

// Zero-config offline assistant so the app is fully usable without an API
// key. Rule-based, streams its answer word by word for the real chat feel.
// Set ANTHROPIC_API_KEY to swap in the real model.

const MATH_RE = /[\d(][\d\s+\-*/().]*[\d)]/;

function tryMath(text) {
  const m = text.match(MATH_RE);
  if (!m) return null;
  const expr = m[0].trim();
  if (!/[+\-*/]/.test(expr)) return null;
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  try {
    // strictly numeric expression (validated above) — safe to evaluate
    const value = new Function(`"use strict"; return (${expr});`)();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `**${expr.replace(/\s+/g, ' ')} = ${value}**\n\nAnything else you'd like me to work out?`;
    }
  } catch {
    /* not valid math */
  }
  return null;
}

const RULES = [
  {
    match: /\b(hi|hello|hey|yo|howdy|good (morning|afternoon|evening))\b/i,
    reply: () =>
      `Hello! 👋 I'm running in **offline demo mode** right now, so my answers are simple — but the ` +
      `chat itself (streaming, history, multi-server scaling) is all real. Ask me about *the time*, ` +
      `*math*, *this project*, or set \`ANTHROPIC_API_KEY\` to unlock the full AI.`,
  },
  {
    match: /\b(who are you|what are you|your name)\b/i,
    reply: () =>
      `I'm the built-in assistant of this chat app. Right now I'm the lightweight offline version — ` +
      `when the server has an \`ANTHROPIC_API_KEY\`, I'm replaced by a real large language model with ` +
      `full conversational ability.`,
  },
  {
    match: /\b(how (do|does) (you|this|it) work|this (project|app)|architecture|scal(e|ing))\b/i,
    reply: () =>
      `Good question! Here's the short version:\n\n` +
      `1. **WebSockets** (Socket.IO) carry messages in real time\n` +
      `2. **Redis pub/sub** links every server instance together, so it can scale horizontally\n` +
      `3. Your conversations are stored in **Redis**, so any instance can serve them\n` +
      `4. Replies are **streamed** to you token by token\n\n` +
      `This reply was served by instance \`${config.instanceName}\`.`,
  },
  { match: /\btime\b/i, reply: () => `It's **${new Date().toLocaleTimeString('en-US')}** (server time).` },
  { match: /\b(date|today)\b/i, reply: () => `Today is **${new Date().toDateString()}**.` },
  { match: /flip a coin/i, reply: () => (Math.random() < 0.5 ? 'It landed on **heads**! 🪙' : 'It landed on **tails**! 🪙') },
  { match: /roll a (die|dice)/i, reply: () => `You rolled a **${1 + Math.floor(Math.random() * 6)}** 🎲` },
  {
    match: /\b(joke|funny)\b/i,
    reply: () => {
      const jokes = [
        `Why do programmers prefer dark mode?\n\nBecause light attracts bugs. 🐛`,
        `There are only two hard things in computer science: cache invalidation, naming things, and off-by-one errors.`,
        `A SQL query walks into a bar, goes up to two tables and asks: *"Can I join you?"*`,
      ];
      return jokes[Math.floor(Math.random() * jokes.length)];
    },
  },
  {
    match: /\b(which|what) (server|instance)\b/i,
    reply: () => `This reply came from instance \`${config.instanceName}\`. Behind the load balancer, each user can land on a different one.`,
  },
  {
    match: /\b(thanks|thank you|thx)\b/i,
    reply: () => `You're welcome! Anything else I can help with?`,
  },
  {
    match: /\bhelp\b/i,
    reply: () =>
      `In offline mode I can handle:\n\n` +
      `- Greetings and small talk\n` +
      `- **Math** — try \`what is 12*(3+4)?\`\n` +
      `- **Time and date**\n` +
      `- **Jokes**, coin flips, dice rolls\n` +
      `- Questions about **how this app works**\n\n` +
      `To turn me into a real AI, start the server with an \`ANTHROPIC_API_KEY\`.`,
  },
];

export function createLocalBot() {
  return {
    mode: 'local',

    async reply({ messages, onDelta, signal }) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = lastUser?.content ?? '';

      const answer =
        tryMath(text) ??
        RULES.find((r) => r.match.test(text))?.reply() ??
        `I'm the **offline demo assistant**, so I can't really answer that one — my full-AI twin can, ` +
          `once the server is started with an \`ANTHROPIC_API_KEY\`.\n\n` +
          `Meanwhile, try asking me for *help*, *a joke*, *the time*, or some *math*.`;

      // stream word by word so the offline mode demos the same UX
      const words = answer.split(/(?<=\s)/);
      let out = '';
      for (const w of words) {
        if (signal?.aborted) break;
        out += w;
        onDelta?.(w);
        await new Promise((r) => setTimeout(r, 12));
      }
      return out;
    },
  };
}
