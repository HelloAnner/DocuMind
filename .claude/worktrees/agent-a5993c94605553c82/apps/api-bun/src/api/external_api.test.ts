import { describe, expect, test } from 'bun:test';
import { constantTimeEq, generateToken, parseTokenId, tokenHash } from './external_api.ts';
import { newUuid } from '../infra/uuid.ts';

describe('external_api', () => {
  test('generated token can be parsed and hashed', () => {
    const id = newUuid();
    const token = generateToken(id);
    expect(parseTokenId(token)).toBe(id);
    expect(tokenHash(token).length).toBe(64);
    expect(constantTimeEq('same', 'same')).toBe(true);
    expect(constantTimeEq('same', 'diff')).toBe(false);
  });
});
