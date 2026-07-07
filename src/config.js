export const config = {
  port: Number(process.env.PORT) || 3000,
  instanceName: process.env.INSTANCE_NAME || `pid-${process.pid}`,
  redisUrl: process.env.REDIS_URL || null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  botModel: process.env.BOT_MODEL || 'claude-opus-4-8',
  botName: 'ChatBot',
  historyLimit: 50,
  maxMessageLength: 2000,
  rateLimit: { windowMs: 10_000, maxMessages: 15 },
};
