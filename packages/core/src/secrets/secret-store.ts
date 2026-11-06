import { createHash } from 'node:crypto';

/** Windows refuses a credential over 2560 bytes, which is this many UTF-16 characters. */
export const CREDENTIAL_CHARACTER_LIMIT = 1280;

/** Where secret values live. Keys are not secret; the values never leave through any other path. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Removes a value. A key with no value is left as it was. */
  delete(key: string): Promise<void>;
}

/** The raw entries of a credential store, which hold values up to the limit. */
export interface CredentialBackend {
  read(account: string): string | undefined;
  write(account: string, value: string): void;
  erase(account: string): void;
}

/** Cuts a value into pieces, never between the two halves of a surrogate pair. */
export function splitSecret(value: string, limit = CREDENTIAL_CHARACTER_LIMIT): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of value) {
    if (piece.length + character.length > limit) {
      pieces.push(piece);
      piece = '';
    }
    piece += character;
  }
  return piece === '' ? pieces : [...pieces, piece];
}

function pieceAccount(key: string, index: number): string {
  return `${key}#${String(index)}`;
}

function storedPieceCount(backend: CredentialBackend, key: string): number {
  const count = Number(backend.read(key) ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/**
 * Keeps values of any length in a store with a size limit. The entry named by the key holds only
 * how many pieces follow, so a shorter value can replace a longer one and leave nothing behind.
 */
export function createChunkedStore(backend: CredentialBackend): SecretStore {
  return {
    get: (key) =>
      Promise.resolve().then(() => {
        if (backend.read(key) === undefined) {
          return undefined;
        }
        const count = storedPieceCount(backend, key);
        return Array.from({ length: count }, (_unused, index) => {
          const piece = backend.read(pieceAccount(key, index));
          if (piece === undefined) {
            throw new Error('A stored secret is incomplete');
          }
          return piece;
        }).join('');
      }),
    set: (key, value) =>
      Promise.resolve().then(() => {
        const previous = storedPieceCount(backend, key);
        const pieces = splitSecret(value);
        pieces.forEach((piece, index) => {
          backend.write(pieceAccount(key, index), piece);
        });
        backend.write(key, String(pieces.length));
        for (let index = pieces.length; index < previous; index += 1) {
          backend.erase(pieceAccount(key, index));
        }
      }),
    delete: (key) =>
      Promise.resolve().then(() => {
        const count = storedPieceCount(backend, key);
        for (let index = 0; index < count; index += 1) {
          backend.erase(pieceAccount(key, index));
        }
        backend.erase(key);
      }),
  };
}

/** A store that lives and dies with the process, for tests. */
export function createMemorySecretStore(): SecretStore & { readonly size: () => number } {
  const entries = new Map<string, string>();
  const store = createChunkedStore({
    read: (account) => entries.get(account),
    write: (account, value) => {
      if (value.length > CREDENTIAL_CHARACTER_LIMIT) {
        throw new Error('The value is too long for one credential');
      }
      entries.set(account, value);
    },
    erase: (account) => {
      entries.delete(account);
    },
  });
  return { ...store, size: () => entries.size };
}

/**
 * The service name separates data directories, so a second one, such as a test's, cannot read or
 * overwrite the secrets of the first.
 */
export function credentialService(dataDir: string): string {
  const digest = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16);
  return `bildora.${digest}`;
}

/** The OS credential store. The native module loads on first use, as nobody may need it. */
export function createCredentialStore(dataDir: string): SecretStore {
  const service = credentialService(dataDir);
  let inner: Promise<SecretStore> | undefined;

  function load(): Promise<SecretStore> {
    inner ??= import('@napi-rs/keyring').then(({ Entry }) =>
      createChunkedStore({
        read: (account) => new Entry(service, account).getPassword() ?? undefined,
        write: (account, value) => {
          new Entry(service, account).setPassword(value);
        },
        erase: (account) => {
          new Entry(service, account).deletePassword();
        },
      }),
    );
    return inner;
  }

  return {
    get: async (key) => (await load()).get(key),
    set: async (key, value) => {
      await (await load()).set(key, value);
    },
    delete: async (key) => {
      await (await load()).delete(key);
    },
  };
}
