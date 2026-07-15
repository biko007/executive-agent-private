import { describe, expect, test } from 'bun:test';
import { shouldExtractMemory } from '../extract.js';

describe('memory extraction owner guard', () => {
  test('skips non-bound senders', () => {
    const result = shouldExtractMemory('Bitte merke dir: Ich mag Blau.', '999', ['123']);
    expect(result).toEqual({ decision: 'skip', reason: 'non_owner' });
  });

  test('allows bound owner sender ids', () => {
    const result = shouldExtractMemory('Bitte merke dir: Ich mag Blau.', '123', ['123']);
    expect(result).toEqual({ decision: 'extract', reason: 'ok' });
  });
});
