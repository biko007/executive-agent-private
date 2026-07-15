#!/usr/bin/env bun
/**
 * Telegram binding CLI.
 *
 * Usage:
 *   bun run scripts/telegram-binding.ts create --role operativ
 *   bun run scripts/telegram-binding.ts create --role dev
 *   bun run scripts/telegram-binding.ts list
 *
 * Prints the cleartext nonce once. The DB stores only the SHA-256 hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPendingTelegramBinding, listActiveTelegramBindings, type TelegramBindingRole } from '../src/modules/telegram-binding/index.js';

const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');

function loadEnv(): void {
  if (process.env.POSTGRES_URL) return;
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Keep error non-specific; do not print secret paths beyond the env file path.
    throw new Error(`Cannot load ${ENV_FILE}`);
  }
}

function parseRole(args: string[]): TelegramBindingRole {
  const idx = args.indexOf('--role');
  const role = idx >= 0 ? args[idx + 1] : '';
  if (role !== 'operativ' && role !== 'dev') {
    throw new Error('create requires --role operativ|dev');
  }
  return role;
}

async function main(): Promise<void> {
  loadEnv();
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'create') {
    const pending = await createPendingTelegramBinding(parseRole(args));
    process.stdout.write(`Binding: ${pending.bindingId}\n`);
    process.stdout.write(`Role: ${pending.roleTag}\n`);
    process.stdout.write(`Nonce: ${pending.nonce}\n`);
    process.stdout.write(`Send /bind ${pending.nonce} in the target Telegram chat within 15 minutes.\n`);
    process.stdout.write('DONE\n');
    return;
  }

  if (cmd === 'list') {
    const bindings = await listActiveTelegramBindings();
    if (bindings.length === 0) {
      process.stdout.write('No active bindings.\n');
      return;
    }
    for (const binding of bindings) {
      process.stdout.write(`${binding.bindingId} role=${binding.roleTag} chat=${binding.telegramChatId} user=${binding.telegramUserId} type=${binding.chatType}\n`);
    }
    return;
  }

  throw new Error('Usage: create --role operativ|dev | list');
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
