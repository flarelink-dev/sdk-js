# @flarelink/client

Typed client SDK for [Flarelink](https://flarelink.dev) — auth + storage + database for the Cloudflare developer stack.

```bash
npm install @flarelink/client
```

```ts
import { createFlarelink } from '@flarelink/client';

const flarelink = createFlarelink({
  url: 'https://myapp-auth.your-subdomain.workers.dev',
});

await flarelink.auth.signUp({ email, password, name });
await flarelink.auth.signIn({ email, password });
const user = await flarelink.auth.getMe();
```

## What you get

- `flarelink.auth.*` — email/password, magic-link, OAuth (Google + GitHub), email verification, password reset. Browser + server safe.
- `flarelink.storage.*` — file storage on R2. Every SDK call runs **server-side** (it needs the service key), but presigned URLs let the **browser** PUT/GET R2 directly — your bytes never go through Flarelink or your own server. See "Service key" below.
- `flarelink.from(...)` + `flarelink.sql\`...\`` — typed query builder for D1, plus a raw-SQL escape hatch. **Server-only.** Browser-side queries with row-level security policies are deferred to a later release.

## Setup

### 1. Create a Flarelink project

Sign up at [dash.flarelink.dev](https://dash.flarelink.dev), connect your Cloudflare account, and click **Provision new project** in the dashboard. Flarelink uploads an auth Worker to your CF account and gives you back its URL.

### 2. Add the deployment URL to your env

```bash
# .env / .dev.vars / process.env / Cloudflare env binding
FLARELINK_AUTH_URL=https://myapp-auth.your-subdomain.workers.dev
```

### 3. Configure trusted origins

In the Flarelink dashboard's Authentication page, add every URL your app runs on — production, staging, `http://localhost:3000` for dev. The Worker rejects requests from anywhere else with a 403. **This is the most common misconfiguration.**

### 4. Create the client and use it

```ts
import { createFlarelink } from '@flarelink/client';

const flarelink = createFlarelink({ url: process.env.FLARELINK_AUTH_URL! });

// In a sign-up form:
const result = await flarelink.auth.signUp({
  email: 'jane@example.com',
  password: 'correct horse battery staple',
  name: 'Jane',
});

// On a protected route:
const user = await flarelink.auth.getMe(); // null if not signed in
```

## Auth API

Every method sends `credentials: 'include'`, so the browser carries the session cookie automatically. On the server, you'll need to forward the `Cookie` header yourself (see SSR section below).

```ts
// Sign up
await flarelink.auth.signUp({ email, password, name });

// Sign in
await flarelink.auth.signIn({ email, password });

// Magic link
await flarelink.auth.signInWithMagicLink('user@example.com');

// OAuth
await flarelink.auth.signInWithSocial('google'); // redirects to provider
await flarelink.auth.signInWithSocial('github', { noRedirect: true }); // returns URL

// Sign out
await flarelink.auth.signOut();

// Who's signed in?
const user = await flarelink.auth.getMe(); // User | null
const session = await flarelink.auth.getSession(); // Session | null

// Password reset (two steps)
await flarelink.auth.requestPasswordReset({
  email: 'user@example.com',
  redirectTo: 'https://myapp.com/reset', // your app's reset page
});
// ...user clicks the link, your page reads ?token=
await flarelink.auth.resetPassword({ token, newPassword });

// Email verification (manual trigger; v0.1 deployments default to auto-on-signup)
await flarelink.auth.sendVerificationEmail({ email });
```

### Error handling

Auth failures are `AuthError` instances with BetterAuth's machine-readable `code`:

```ts
import { AuthError } from '@flarelink/client';

try {
  await flarelink.auth.signIn({ email, password });
} catch (err) {
  if (err instanceof AuthError && err.code === 'INVALID_PASSWORD') {
    // …
  }
}
```

## Server-only: storage + database

`flarelink.storage.*` and `flarelink.from(...)` require a per-project **service key**. The key grants full DB + R2 access — **never include it in a client-side bundle.** Read it from server env only.

```ts
// In server-side code (Next.js server action, SvelteKit +server.ts, a CF Worker, etc.)
const flarelink = createFlarelink({
  url: process.env.FLARELINK_AUTH_URL!,
  serviceKey: process.env.FLARELINK_SERVICE_KEY!, // never ship this to the browser
});
```

The service key is shown once after project provisioning (in the Flarelink dashboard's secret-bundle modal). If you lose it, hit **Rotate service key** on the Authentication page — that invalidates the old one and surfaces a new one. Apps using the old key will get `INVALID_SERVICE_KEY` (401) immediately.

### Storage

The SDK methods always run **server-side** — every call needs the service key, which must never reach the browser. But uploads and downloads themselves go **browser → R2 directly**, with no server in the byte path. That's the whole point: your server hands out short-lived presigned URLs; the browser uses them to talk to R2.

Two patterns, depending on whether bytes need to move:

**Presigning** (server mints URL → browser uses it):

```ts
// SERVER (Next.js route handler, SvelteKit +server.ts, Express, …):
const { url, signedHeaders } = await flarelink.storage
  .from('uploads')
  .createSignedUploadUrl('avatars/jane.png', { contentType: 'image/png' });
// Return `url` (and signedHeaders) to the browser via your API.

// BROWSER (anywhere):
await fetch(url, {
  method: 'PUT',
  headers: signedHeaders,
  body: file,                       // a File, Blob, ArrayBuffer, etc.
});
// File is now on R2 — your server saw zero bytes.

// Same pattern for downloads — mint server-side, embed in browser:
const { url: dl } = await flarelink.storage
  .from('uploads')
  .createSignedDownloadUrl('avatars/jane.png');
// Return `dl` to the browser; <img src={dl} />, window.open(dl), etc.
```

**Server-only** (no browser involvement):

```ts
// Delete an object
await flarelink.storage.from('uploads').remove(['avatars/old.png']);

// List objects under a prefix
const { objects, prefixes } = await flarelink.storage
  .from('uploads')
  .list({ prefix: 'avatars/' });

// All buckets on the customer's R2 account
const buckets = await flarelink.storage.listBuckets();
```

Throws `StorageError` (with `.code`: `INVALID_SERVICE_KEY` / `SERVICE_KEY_NOT_PROVISIONED` / `R2_NOT_CONFIGURED`).

### Database

`flarelink.from(table)` returns a chainable that resolves on `await`. The query builder is intentionally small — equality + AND in `where`, `orderBy`, `limit`, `offset`, plus `insert` / `update` / `delete` / `returning`. Anything more dynamic goes through `flarelink.sql\`…\``.

```ts
// SELECT
const users = await flarelink
  .from('users')
  .select(['id', 'email', 'active'])
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(20);
// users.rows is typed if you parameterize: flarelink.from<{ id: string; ... }>('users')

// SELECT * is the default; .select() is only for narrowing
const everyone = await flarelink.from('users');

// IS NULL semantics
const unverified = await flarelink.from('users').where({ verified_at: null });

// INSERT (single row, multi-row, with RETURNING)
await flarelink.from('users').insert({ email: 'a@b.com', name: 'A' });
const created = await flarelink
  .from('users')
  .insert([{ email: 'a@b.com' }, { email: 'c@d.com' }])
  .returning('*');

// UPDATE + DELETE
await flarelink.from('users').update({ active: false }).where({ id: 42 });
await flarelink.from('users').delete().where({ id: 99 });

// Raw SQL escape hatch — interpolated values are SAFE bind params,
// never concatenated into the SQL string.
const top = await flarelink.sql`
  SELECT email, count(*) AS n
  FROM events
  WHERE created_at > ${cutoff}
  GROUP BY email
  ORDER BY n DESC
  LIMIT 10
`;
```

Identifiers (table + column names) must match `/^[A-Za-z_][A-Za-z0-9_]*$/` — anything else throws `DatabaseError` with code `INVALID_IDENTIFIER` before the request is sent. There's no way for an interpolated value to inject SQL — all values go through bind params.

All results have shape `{ rows: T[], meta: { duration, rows_read?, rows_written?, last_row_id?, changes? } }`. Throws `DatabaseError` on failure with `.code` set to the underlying D1 error category (`D1_QUERY_FAILED`, `INVALID_IDENTIFIER`, `UNSUPPORTED_FILTER`, etc.).

The customer's D1 also holds Flarelink's auth tables (`user`, `account`, `verification`, `flarelink_config`) — `flarelink.from('user')` reads those just like any other table. Avoid creating customer tables with those names.

**Not yet supported** (use `flarelink.sql\`…\``): `IN (…)`, `>` / `<` / `LIKE`, `OR`, joins, transactions. These land in a later release alongside browser-side queries with row-level security policies.

## SSR: forwarding the session cookie

In server frameworks (Next.js, SvelteKit, Remix, …) the browser's session cookie isn't on the server `fetch` by default — so `flarelink.auth.getMe()` would return `null` from a route handler / loader even when the user is signed in. Pass a `cookies` function and the SDK adds the `Cookie` header to every request:

```ts
// Next.js (App Router)
import { cookies } from 'next/headers';
import { createFlarelink } from '@flarelink/client';

const flarelink = createFlarelink({
  url: process.env.FLARELINK_AUTH_URL!,
  serviceKey: process.env.FLARELINK_SERVICE_KEY!,
  cookies: () => cookies().toString(),
});
```

```ts
// Anything with a Request (Remix, SvelteKit, Hono, Astro, …)
const flarelink = createFlarelink({
  url, serviceKey,
  cookies: () => request.headers.get('cookie') ?? '',
});
```

`cookies` is called per-request, so it's safe to define the client at module scope when your framework's cookie API is request-scoped. Pass a plain string instead of a function if cookies are static. No effect in the browser — `credentials: 'include'` carries cookies automatically there. Use `fetch:` for full control if you need it (e.g. tests).

## AGENTS.md / Claude / Cursor

Paste this into your project's `AGENTS.md` / `CLAUDE.md` so AI agents helping you integrate Flarelink know what to do:

````markdown
# Flarelink integration (`@flarelink/client`)

This project uses `@flarelink/client` for auth, file storage, and database access against a Cloudflare-hosted Flarelink project.

## Setup
- `process.env.FLARELINK_AUTH_URL` — the project's auth Worker URL.
- `process.env.FLARELINK_SERVICE_KEY` — **server-only.** Required for storage + database. NEVER include in browser bundles.
- Trusted origins are configured in the Flarelink dashboard — every origin this app runs on must be listed there or requests come back 403.

## Client
Browser-safe (auth only):
```ts
import { createFlarelink } from '@flarelink/client';
const flarelink = createFlarelink({ url: process.env.FLARELINK_AUTH_URL! });
```

Server-side (auth + storage + db):
```ts
const flarelink = createFlarelink({
  url: process.env.FLARELINK_AUTH_URL!,
  serviceKey: process.env.FLARELINK_SERVICE_KEY!,
});
```

## Auth (browser + server)
- `flarelink.auth.signUp({ email, password, name })`
- `flarelink.auth.signIn({ email, password })`
- `flarelink.auth.signInWithMagicLink(email)`
- `flarelink.auth.signInWithSocial('google' | 'github')`
- `flarelink.auth.signOut()`
- `flarelink.auth.getMe()` → User | null
- `flarelink.auth.getSession()` → Session | null
- `flarelink.auth.requestPasswordReset({ email, redirectTo })`
- `flarelink.auth.resetPassword({ token, newPassword })`
- `flarelink.auth.sendVerificationEmail({ email })`

All send `credentials: 'include'`. On the server, forward cookies via the `fetch` option.

## Storage
All SDK calls run server-side (service key required). Two patterns:

**Presign + browser-direct** — server mints a short-lived URL, browser PUTs/GETs R2 directly:
```ts
// Server: mint a URL and return it to the client
const { url, signedHeaders } = await flarelink.storage
  .from('bucket-name')
  .createSignedUploadUrl('path/key.png', { contentType: 'image/png' });
// Then in the browser:
//   await fetch(url, { method: 'PUT', headers: signedHeaders, body: file });

const { url: dl } = await flarelink.storage
  .from('bucket-name')
  .createSignedDownloadUrl('path/key.png');
// Use `dl` as <img src>, fetch it, redirect to it — anywhere a URL works.
```

**Server-only** — no browser path; the SDK call IS the operation:
```ts
await flarelink.storage.from('bucket-name').remove(['path/key.png']);
const { objects, prefixes } = await flarelink.storage
  .from('bucket-name')
  .list({ prefix: 'path/' });
```

## Database (server-only)
```ts
// SELECT
const users = await flarelink
  .from('users')
  .select(['id', 'email'])
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(20);
// → { rows: [...], meta: { duration, rows_read, ... } }

// INSERT (single, multi, with RETURNING)
await flarelink.from('users').insert({ email: 'a@b.com', name: 'A' });
const inserted = await flarelink
  .from('users')
  .insert([{ email: 'a' }, { email: 'b' }])
  .returning('*');

// UPDATE / DELETE
await flarelink.from('users').update({ active: false }).where({ id: 42 });
await flarelink.from('users').delete().where({ id: 99 });

// Raw SQL escape hatch — interpolated values are SAFE bind params.
// Use this for: IN, range, LIKE, OR, joins, anything else.
const top = await flarelink.sql`
  SELECT email, count(*) AS n FROM events
  WHERE created_at > ${cutoff}
  GROUP BY email ORDER BY n DESC LIMIT 10
`;
```

The query builder only supports equality + AND in `where`. For `IN`, ranges, joins, etc., use `flarelink.sql\`…\`` — interpolated values are bind params, not concatenated strings, so SQL injection is impossible through that surface.

Flarelink's auth tables live in the same D1: `user`, `account`, `verification`, `flarelink_config`. Avoid naming customer tables with those names.

## Errors
- `AuthError` — auth failures (check `err.code`: `INVALID_PASSWORD`, `USER_NOT_FOUND`, `TOO_MANY_REQUESTS`, etc.)
- `StorageError` — storage failures (`INVALID_SERVICE_KEY`, `R2_NOT_CONFIGURED`)
- `DatabaseError` — db failures (`INVALID_IDENTIFIER`, `D1_QUERY_FAILED`, `UNSUPPORTED_FILTER`)
- `MissingServiceKeyError` — `serviceKey` not provided to `createFlarelink` but you tried to use storage/db

## Don't
- Don't include `FLARELINK_SERVICE_KEY` in client-side bundles. There is no "scoped" or "read-only" service key — leaking it = full DB + R2 access.
- Don't roll a custom session cookie — use `flarelink.auth.getMe()`.
- Don't store auth tokens manually — cookies are handled by the Worker.
- Don't concatenate user input into `flarelink.sql\`…\`` template parts. Always pass values as `${interpolations}` so they become bind params.
- Don't use `flarelink.from(...)` for anything more complex than `=` filters with AND. Use `flarelink.sql\`…\`` instead — it's the same `await`, just more flexible.
````

## License

MIT.
