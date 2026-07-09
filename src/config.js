export const config = {
  port: Number(process.env.PORT) || 3000,
  instanceName: process.env.INSTANCE_NAME || `pid-${process.pid}`,
  redisUrl: process.env.REDIS_URL || null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  botModel: process.env.BOT_MODEL || 'claude-opus-4-8',
  botName: 'Assistant',
  historyLimit: 200, // messages kept per conversation
  contextTurns: 30, // most recent messages sent to the model as context
  maxMessageLength: 8000,
  maxConversations: 50, // per user
  rateLimit: { windowMs: 20_000, maxMessages: 10 },
};
