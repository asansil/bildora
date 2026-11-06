import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_CHARACTER_LIMIT,
  createCredentialStore,
  createMemorySecretStore,
  credentialService,
  splitSecret,
} from './secret-store.js';

describe('splitSecret', () => {
  it('keeps a value at the limit in one piece', () => {
    expect(splitSecret('a'.repeat(CREDENTIAL_CHARACTER_LIMIT))).toHaveLength(1);
  });

  it('never cuts a surrogate pair in two', () => {
    const pieces = splitSecret('😀'.repeat(5), 3);

    expect(pieces.join('')).toBe('😀'.repeat(5));
    expect(pieces.every((piece) => piece.length <= 3)).toBe(true);
    expect(() => pieces.map((piece) => encodeURIComponent(piece))).not.toThrow();
  });
});

describe('chunked store', () => {
  it('has nothing for an unknown key', async () => {
    expect(await createMemorySecretStore().get('missing')).toBeUndefined();
  });

  it('round-trips a value far over the credential limit', async () => {
    const store = createMemorySecretStore();
    const value = 'ñ😀x'.repeat(1000);

    await store.set('key', value);

    expect(await store.get('key')).toBe(value);
  });

  it('leaves nothing behind when a shorter value replaces a longer one', async () => {
    const store = createMemorySecretStore();
    await store.set('key', 'a'.repeat(4000));
    await store.set('key', 'short');

    expect(await store.get('key')).toBe('short');
    expect(store.size()).toBe(2);
  });

  it('deletes every piece', async () => {
    const store = createMemorySecretStore();
    await store.set('key', 'a'.repeat(4000));

    await store.delete('key');

    expect(await store.get('key')).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe('credentialService', () => {
  it('differs by data directory, and ignores case as Windows paths do', () => {
    expect(credentialService('C:\\Data\\A')).not.toBe(credentialService('C:\\Data\\B'));
    expect(credentialService('C:\\Data\\A')).toBe(credentialService('c:\\data\\a'));
  });
});

describe.skipIf(process.platform !== 'win32')('OS credential store', () => {
  it('round-trips a long value, then removes it', async () => {
    const store = createCredentialStore(`bildora-test-${String(process.pid)}`);
    const value = 'x'.repeat(3000);

    try {
      await store.set('probe', value);
      expect(await store.get('probe')).toBe(value);
      await store.set('probe', 'short');
      expect(await store.get('probe')).toBe('short');
    } finally {
      await store.delete('probe');
    }

    expect(await store.get('probe')).toBeUndefined();
  });
});
