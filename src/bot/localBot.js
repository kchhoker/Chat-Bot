import { config } from './../config.js';

// Zero-config fallback bot so the app is fully usable without an API key.
// Rule-based and intentionally simple — the point of this project is the
// real-time architecture; set ANTHROPIC_API_KEY to swap in the real AI.
const RULES = [
  {
    match: /\b(hi|hello|hey|yo|sup)\b/i,
    reply: (name) => `Hey ${name}! I'm ${config.botName}. Ask me for "help" to see what I can do.`,
  },
  {
    match: /\bhelp\b/i,
    reply: () =>
      `I can respond to: greetings, "time", "date", "flip a coin", "roll a die", simple math like "12*(3+4)", ` +
      `and "which server" to show which instance handled your message. ` +
      `Set ANTHROPIC_API_KEY to upgrade me to a real AI.`,
  },
  { match: /\btime\b/i, reply: () => `It's ${new Date().toLocaleTimeString('en-US')} (server time).` },
  { match: /\bdate\b/i, reply: () => `Today is ${new Date().toDateString()}.` },
  { match: /flip a coin/i, reply: () => (Math.random() < 0.5 ? 'Heads!' : 'Tails!') },
  { match: /roll a (die|dice)/i, reply: () => `You rolled a ${1 + Math.floor(Math.random() * 6)}.` },
  {
    match: /which (server|instance)/i,
    reply: () => `I'm answering from instance "${config.instanceName}".`,
  },
];

// grabs the longest run of math-y characters, e.g. "12*(3+4)" out of
// "@ChatBot what is 12*(3+4)?"
const MATH_RE = /[\d(][\d\s+\-*/().]*[\d)]/;

function tryMath(text) {
  const m = text.match(MATH_RE);
  if (!m) return null;
  const expr = m[0].trim();
  // must contain an operator, only safe numeric characters, balanced parens
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
      return `${expr.replace(/\s+/g, ' ')} = ${value}`;
    }
  } catch {
    /* not valid math — fall through */
  }
  return null;
}

export function createLocalBot() {
  return {
    mode: 'local',
    async reply(transcript, onChunk) {
      // last line of the transcript is the message that addressed the bot
      const lastLine = transcript.trim().split('\n').at(-1) ?? '';
      const [, name = 'friend', text = lastLine] = lastLine.match(/^(.+?):\s*(.*)$/s) ?? [];

      const math = tryMath(text);
      const rule = RULES.find((r) => r.match.test(text));
      const answer =
        math ??
        rule?.reply(name) ??
        `I'm a simple offline bot, so I didn't understand that — try "help". ` +
          `(Set ANTHROPIC_API_KEY to make me much smarter.)`;

      onChunk?.(answer);
      return answer;
    },
  };
}
