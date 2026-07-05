import { AgentiveClient } from './agentive-client.ts';
import type { BotConfig } from './types.ts';

const DEFAULT_URL = 'ws://localhost:8080/game';
const DEFAULT_NICKNAME = 'AgentiveBot';

function main(): void {
  const config = parseConfig(process.argv.slice(2), process.env);
  const client = new AgentiveClient(config);

  process.on('SIGINT', () => {
    console.log('\n[DISCONNECTED] shutting down');
    client.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\n[DISCONNECTED] shutting down');
    client.stop();
    process.exit(0);
  });

  client.start();
}

function parseConfig(args: string[], env: NodeJS.ProcessEnv): BotConfig {
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (!arg.startsWith('--')) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }

    options.set(key, next);
    i++;
  }

  const url = stringOption(options, 'url') ?? env.BOT_WS_URL ?? DEFAULT_URL;
  const roomCode = (stringOption(options, 'room') ?? env.BOT_ROOM)?.toUpperCase();
  const nickname = stringOption(options, 'nickname') ?? env.BOT_NICKNAME ?? DEFAULT_NICKNAME;
  const createRoom = booleanOption(options, 'create-room') || env.BOT_CREATE_ROOM === '1';

  return {
    url,
    nickname,
    roomCode,
    createRoom,
    reconnectMinMs: numberOption(options, 'reconnect-min-ms', env.BOT_RECONNECT_MIN_MS, 1000),
    reconnectMaxMs: numberOption(options, 'reconnect-max-ms', env.BOT_RECONNECT_MAX_MS, 10000),
  };
}

function stringOption(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanOption(options: Map<string, string | boolean>, key: string): boolean {
  const value = options.get(key);
  return value === true || value === 'true' || value === '1';
}

function numberOption(
  options: Map<string, string | boolean>,
  key: string,
  envValue: string | undefined,
  fallback: number
): number {
  const raw = stringOption(options, key) ?? envValue;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function printUsage(): void {
  console.log(`DotRace Agentive Client Bot

Usage:
  npm run bot -- --room ABCDE [--nickname AgentiveBot] [--url ws://localhost:8080/game]

Options:
  --url <ws-url>              WebSocket server URL (default: ${DEFAULT_URL})
  --room <code>               Existing room code to join
  --nickname <name>           Bot display name (default: ${DEFAULT_NICKNAME})
  --create-room               Create a room instead of joining one
  --reconnect-min-ms <ms>     Initial reconnect delay (default: 1000)
  --reconnect-max-ms <ms>     Maximum reconnect delay (default: 10000)

Environment:
  BOT_WS_URL, BOT_ROOM, BOT_NICKNAME, BOT_CREATE_ROOM,
  BOT_RECONNECT_MIN_MS, BOT_RECONNECT_MAX_MS
`);
}

main();
