import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';

const base = { DATABASE_URL: 'postgresql://localhost:5432/nt_test' };

describe('loadEnv', () => {
  it('applies the fake-gateway defaults used in dev and test (D6)', () => {
    const env = loadEnv(base);
    expect(env.TRADING_GATEWAY).toBe('fake');
    expect(env.IDENTITY_GATEWAY).toBe('fake');
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('refuses to boot without a database url', () => {
    expect(() => loadEnv({})).toThrow();
  });

  it('rejects an unknown trading gateway instead of guessing', () => {
    expect(() => loadEnv({ ...base, TRADING_GATEWAY: 'scrape-mt5' })).toThrow();
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow();
  });

  it('accepts a 32-char JWT secret', () => {
    const env = loadEnv({ ...base, JWT_SECRET: 'x'.repeat(32) });
    expect(env.JWT_SECRET).toHaveLength(32);
  });
});
