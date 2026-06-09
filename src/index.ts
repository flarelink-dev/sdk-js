// @flarelink/client — typed client SDK for a Flarelink-provisioned project.
//
//   import { createFlarelink } from '@flarelink/client';
//   const flarelink = createFlarelink({ url: 'https://myapp-auth.workers.dev' });
//
// Auth works everywhere (browser + server). Storage + database require a
// per-project service key passed via `createFlarelink({ serviceKey })` and only
// work on the server — never include the service key in client bundles.

import { createAuth, type Auth } from './auth.js';
import { createDatabase, type QueryResult, type TableQuery } from './db.js';
import { createStorage, type Storage } from './storage.js';
import type { FlarelinkConfig } from './types.js';

export type Flarelink = {
  /** Auth surface — browser + server safe. */
  readonly auth: Auth;

  /** File storage (R2). Server-only — requires `serviceKey`. */
  readonly storage: Storage;

  /**
   * Build a query against a D1 table.
   * Server-only — requires `serviceKey`.
   */
  from<T extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
  ): TableQuery<T>;

  /**
   * Raw SQL escape hatch. Tagged-template syntax interpolates values as
   * bind params:
   *   await flarelink.sql`SELECT * FROM users WHERE id = ${userId}`
   *
   * Server-only — requires `serviceKey`.
   */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<QueryResult<T>>;
};

export function createFlarelink(config: FlarelinkConfig): Flarelink {
  if (!config?.url) {
    throw new Error(
      'createFlarelink({ url }) is required. The URL is your project\'s auth Worker, e.g. "https://myapp-auth.your-subdomain.workers.dev" — find it in the Flarelink dashboard.',
    );
  }
  const base = config.url.replace(/\/$/, '');
  const userFetch = config.fetch ?? fetch;
  const getCookies = normalizeCookies(config.cookies);
  const f = getCookies ? wrapFetchWithCookies(userFetch, getCookies) : userFetch;

  const auth = createAuth(base, f);
  const storage = createStorage(base, config.serviceKey, f);
  const db = createDatabase(base, config.serviceKey, f);

  return {
    auth,
    storage,
    from: (table) => db.from(table),
    sql: (strings, ...values) => db.sql(strings, ...values),
  };
}

function normalizeCookies(
  c: FlarelinkConfig['cookies'],
): (() => Promise<string>) | undefined {
  if (c === undefined) return undefined;
  if (typeof c === 'string') {
    const value = c;
    return async () => value;
  }
  return async () => c();
}

// Wraps the caller's fetch so every server-side request to the auth Worker
// carries the user's session cookie. No-op in browsers — fetch already
// forwards cookies via credentials: 'include', and the Cookie header is on
// the browser's forbidden-headers list anyway. If the caller's own headers
// already include Cookie, we don't override.
function wrapFetchWithCookies(
  base: typeof fetch,
  getCookies: () => Promise<string>,
): typeof fetch {
  return async (input, init) => {
    const cookie = await getCookies();
    if (!cookie) return base(input, init);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (!headers.has('cookie')) headers.set('cookie', cookie);
    return base(input, { ...init, headers });
  };
}

// Re-export everything callers might want to instanceof / annotate / catch.
export {
  AuthError,
  FlarelinkError,
  DatabaseError,
  MissingServiceKeyError,
  StorageError,
} from './errors.js';

export type { Auth } from './auth.js';
export type {
  Database,
  DeleteBuilder,
  Equality,
  InsertBuilder,
  QueryBuilder,
  QueryResult,
  TableQuery,
  UpdateBuilder,
} from './db.js';
export type {
  PresignOptions,
  Storage,
  StorageBucket,
  StorageBucketAPI,
  StorageListResponse,
  StorageObject,
} from './storage.js';
export type {
  FlarelinkConfig,
  RequestPasswordResetInput,
  ResetPasswordInput,
  SendVerificationEmailInput,
  Session,
  SignInInput,
  SignInWithMagicLinkOptions,
  SignInWithSocialOptions,
  SignUpInput,
  SocialProvider,
  User,
} from './types.js';
