import { config } from './../config.js';
import { createClaudeBot } from './claudeBot.js';
import { createLocalBot } from './localBot.js';

export function createBot() {
  const impl = config.anthropicApiKey ? createClaudeBot() : createLocalBot();
  console.log(
    `[bot] assistant online (mode: ${impl.mode}${impl.mode === 'claude' ? `, model: ${config.botModel}` : ''})`,
  );
  return impl;
}
