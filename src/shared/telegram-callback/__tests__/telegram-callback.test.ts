import { describe, expect, test } from 'bun:test';
import { parseCallbackEvent } from '../index.js';

describe('parseCallbackEvent', () => {
  // (a) Matches prefix, splits args
  test('matches prefix and splits args by `::`', () => {
    const event = {
      content: 'icraft_jb-1805-1xkk::ja',
      metadata: { senderId: '12345' },
    };
    const result = parseCallbackEvent(event, 'icraft');
    expect(result).toEqual({
      prefix: 'icraft',
      payload: 'jb-1805-1xkk::ja',
      args: ['jb-1805-1xkk', 'ja'],
      senderId: '12345',
      chatId: '',
      content: 'icraft_jb-1805-1xkk::ja',
    });
  });

  // (b) Non-matching prefix → null
  test('returns null for non-matching prefix', () => {
    const event = { content: 'other_thing', metadata: { senderId: '1' } };
    expect(parseCallbackEvent(event, 'icraft')).toBeNull();
  });

  // (c) No `::` separator → single arg
  test('returns single arg when no `::` separator', () => {
    const event = { content: 'icraft_no-separator', metadata: {} };
    const result = parseCallbackEvent(event, 'icraft');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['no-separator']);
  });

  // (d) Trailing `::` → empty last arg
  test('trailing `::` produces empty last arg', () => {
    const event = { content: 'icraft_empty::', metadata: {} };
    const result = parseCallbackEvent(event, 'icraft');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['empty', '']);
  });

  // (e) Missing metadata → senderId=''
  test('missing metadata yields empty senderId', () => {
    const event = { content: 'icraft_x' };
    const result = parseCallbackEvent(event, 'icraft');
    expect(result).not.toBeNull();
    expect(result!.senderId).toBe('');
    expect(result!.chatId).toBe('');
  });

  test('extracts explicit chatId without falling back to senderId', () => {
    const event = {
      content: 'memdrop_42',
      metadata: { chatId: 'telegram:-10042', senderId: '777' },
    };
    const result = parseCallbackEvent(event, 'memdrop');
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe('-10042');
    expect(result!.senderId).toBe('777');
  });

  test('does not invent chatId from senderId for callbacks', () => {
    const event = {
      content: 'memdrop_42',
      metadata: { senderId: '777' },
    };
    const result = parseCallbackEvent(event, 'memdrop');
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe('');
    expect(result!.senderId).toBe('777');
  });

  // (f) undefined content → null
  test('returns null when content is undefined', () => {
    const event = { content: undefined };
    expect(parseCallbackEvent(event, 'icraft')).toBeNull();
  });

  // (g) Real-world: iscan_ask_sess::craft
  test('real-world: iscan_ask_sess::craft', () => {
    const event = {
      content: 'iscan_ask_sess::craft',
      metadata: { senderId: '99' },
    };
    const result = parseCallbackEvent(event, 'iscan');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('iscan');
    expect(result!.args).toEqual(['ask_sess', 'craft']);
  });

  // (h) Real-world: segdel_abc::yes
  test('real-world: segdel_abc::yes', () => {
    const event = {
      content: 'segdel_abc::yes',
      metadata: { senderId: '7' },
    };
    const result = parseCallbackEvent(event, 'segdel');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('segdel');
    expect(result!.args).toEqual(['abc', 'yes']);
  });
});
