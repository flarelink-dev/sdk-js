// Storage surface — Supabase-shaped facade over the project's R2 buckets.
//
// Wire shape:
//   POST   {url}/api/storage/presign  { bucket, key, op, contentType?, expiresIn? }
//   DELETE {url}/api/storage/object   { bucket, key }
//   GET    {url}/api/storage/list?bucket&prefix&cursor
//   GET    {url}/api/storage/buckets
//
// All gated by `Authorization: Bearer <serviceKey>`. Browser PUT/GET hits R2
// directly via presigned URL — the Worker is only in the control plane.
//
// Service key is required for every call. Without it (or if it's invalid),
// the Worker returns 401 / 412 and we surface a clear error rather than a
// raw fetch failure.

import { MissingServiceKeyError, StorageError } from './errors.js';

export type StorageBucket = {
  name: string;
  createdAt: string;
};

export type StorageObject = {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
};

export type StorageListResponse = {
  objects: StorageObject[];
  prefixes: string[];
  nextCursor?: string;
};

export type PresignOptions = {
  /** Default 300s (5 min). Server clamps to [60s, 3600s]. */
  expiresIn?: number;
  contentType?: string;
};

export type StorageBucketAPI = {
  /**
   * Mint a presigned PUT URL. Use it with a plain `fetch` (or XHR for
   * progress) — bytes go direct to R2, the Worker never sees them.
   *
   * @returns `url` to PUT to, and `signedHeaders` you must send on the PUT
   *   request (currently `content-type` when supplied). Don't add extra
   *   headers — they'll break the signature.
   */
  createSignedUploadUrl(
    key: string,
    opts?: PresignOptions,
  ): Promise<{ url: string; signedHeaders: Record<string, string> }>;

  /**
   * Mint a presigned GET URL. Open it in the browser, embed it as an
   * `<img src>`, or fetch it server-side — same URL works anywhere until
   * it expires.
   */
  createSignedDownloadUrl(
    key: string,
    opts?: PresignOptions,
  ): Promise<{ url: string }>;

  /** Delete an object. */
  remove(keys: string[]): Promise<void>;

  /**
   * List objects under an optional prefix. Returns up to 1000 per call;
   * pass `cursor` from the previous response to page further.
   */
  list(opts?: { prefix?: string; cursor?: string }): Promise<StorageListResponse>;
};

export type Storage = {
  /** List buckets attached to the project's R2 account. */
  listBuckets(): Promise<StorageBucket[]>;
  /** Scope all operations to a single bucket. */
  from(bucket: string): StorageBucketAPI;
};

export function createStorage(
  base: string,
  serviceKey: string | undefined,
  f: typeof fetch,
): Storage {
  const requireKey = (): string => {
    if (!serviceKey) throw new MissingServiceKeyError('storage');
    return serviceKey;
  };

  async function call<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const key = requireKey();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const url = new URL(`${base}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }
    const res = await f(url.toString(), { ...init, headers });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new StorageError(
        body.error ?? res.statusText,
        res.status,
        body.code,
      );
    }
    return (await res.json()) as T;
  }

  return {
    listBuckets: async () => {
      const r = await call<{ buckets: StorageBucket[] }>('/api/storage/buckets');
      return r.buckets;
    },
    from: (bucket) => ({
      createSignedUploadUrl: async (key, opts = {}) => {
        const r = await call<{ url: string; signedHeaders: Record<string, string> }>(
          '/api/storage/presign',
          {
            method: 'POST',
            body: JSON.stringify({
              bucket,
              key,
              op: 'put',
              contentType: opts.contentType,
              expiresIn: opts.expiresIn,
            }),
          },
        );
        return { url: r.url, signedHeaders: r.signedHeaders };
      },
      createSignedDownloadUrl: async (key, opts = {}) => {
        const r = await call<{ url: string }>('/api/storage/presign', {
          method: 'POST',
          body: JSON.stringify({
            bucket,
            key,
            op: 'get',
            expiresIn: opts.expiresIn,
          }),
        });
        return { url: r.url };
      },
      remove: async (keys) => {
        // Each delete is its own request — R2's S3-compatible API supports
        // batch delete but the wire format (signed XML body) is materially
        // more code on the Worker. Sequential deletes are fine for typical
        // app use; revisit if customer needs bulk delete UX.
        for (const k of keys) {
          await call<{ ok: true }>('/api/storage/object', {
            method: 'DELETE',
            body: JSON.stringify({ bucket, key: k }),
          });
        }
      },
      list: async (opts = {}) => {
        return call<StorageListResponse>('/api/storage/list', {
          method: 'GET',
          query: {
            bucket,
            ...(opts.prefix !== undefined && { prefix: opts.prefix }),
            ...(opts.cursor !== undefined && { cursor: opts.cursor }),
          },
        });
      },
    }),
  };
}
