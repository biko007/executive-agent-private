import { describe, expect, test } from 'bun:test';
import { extractTelegramIdentity } from '../index.js';

describe('telegram binding helpers', () => {
  test('extracts explicit chat and sender ids', () => {
    const identity = extractTelegramIdentity({
      chatId: '-10042',
      senderId: '777',
      chatType: 'supergroup',
    });
    expect(identity).toEqual({ chatId: '-10042', userId: '777', chatType: 'supergroup' });
  });

  test('falls back to sender id for direct chats', () => {
    const identity = extractTelegramIdentity({
      metadata: { senderId: '12345' },
    });
    expect(identity).toEqual({ chatId: '12345', userId: '12345', chatType: 'private' });
  });

  test('normalizes telegram-prefixed ids', () => {
    const identity = extractTelegramIdentity({
      chatId: 'telegram:-10042',
      senderId: 'telegram:777',
      chatType: 'group',
    });
    expect(identity).toEqual({ chatId: '-10042', userId: '777', chatType: 'group' });
  });
});
