# @flarelink/client — local test harness

Two scripts that exercise the SDK against a real deployed auth Worker. No
npm publish needed — both import directly from `../dist/index.js`.

## Setup

```bash
cp .env.example .env
# Edit .env: paste your Worker URL + service key (+ optional R2 bucket)
```

Get values from the Flarelink dashboard:

- **URL** — Authentication page → deployment card → Endpoint
- **SERVICE_KEY** — minted once on provision (one-time secret modal), or
  rotate via the service-key panel inside the card
- **BUCKET** — Files page → any bucket attached to this project (skip the
  storage tests by leaving blank)

If you change the SDK source, rebuild before retesting:

```bash
cd /Users/jaan/dev/cloudflare-stack/sdk
npm run build
```

## Server-side surface — storage + db

```bash
cd /Users/jaan/dev/cloudflare-stack/sdk/examples
node server.mjs
```

Output is a checklist of 14 steps with timing + a pass/fail summary. Exits
1 on any failure so it slots into CI later.

What it walks:

1. `storage.listBuckets()`
2. `storage.from(bucket).createSignedUploadUrl(key)` + raw PUT
3. `storage.from(bucket).list({ prefix })`
4. `storage.from(bucket).createSignedDownloadUrl(key)` + raw GET + body verify
5. `storage.from(bucket).remove([key])`
6. `flarelink.sql\`SELECT 1\``
7. `flarelink.from('user').select(['id','email']).limit(1)`
8. Chain immutability (`.limit(1)` and `.limit(2)` on same base)
9. Tagged-sql binds values safely (interpolating `'; DROP TABLE user; --` returns 0 rows)
10. `flarelink.from('user; DROP TABLE user')` throws `DatabaseError` synchronously
11. `MissingServiceKeyError` when no key passed
12. `DatabaseError` status=401 with a bad key

## Browser surface — auth

```bash
# From sdk/ (one level up — NOT sdk/examples/):
cd /Users/jaan/dev/cloudflare-stack/sdk
python3 -m http.server 8000
```

Open <http://localhost:8000/examples/browser.html>.

Paste your Worker URL in the Config field (persisted to localStorage). Then
click any button — the log pane shows the call result, errors include the
`code` + `status` BetterAuth surfaces.

> The page imports the SDK via `../dist/index.js` — serve from `sdk/`, not
> from `sdk/examples/`, otherwise path traversal gets rejected. The `node
> server.mjs` test has no such constraint.

What it lets you test:

- `auth.signUp / signIn / signOut`
- `auth.signInWithMagicLink` (email module must be configured)
- `auth.signInWithSocial('google' | 'github')` (providers must be configured)
- `auth.getSession / getMe`
- `auth.requestPasswordReset / sendVerificationEmail`

The pill at the top right shows live signed-in / signed-out state by
calling `getSession()` after every action.

## Things that should NOT work

If you're poking holes — these all return clear errors with codes:

- Calling `storage.*` without a service key → `MissingServiceKeyError`
- Bad service key → `StorageError` / `DatabaseError` with status 401
- `flarelink.from('bad name')` → synchronous `DatabaseError` code `INVALID_IDENTIFIER`
- `flarelink.from('user').where({ ids: [1, 2] })` → `DatabaseError` code `UNSUPPORTED_FILTER`
  (suggests `flarelink.sql\`…IN…\`` instead)

## Going from here to npm

When the smoke tests pass, ship:

```bash
cd /Users/jaan/dev/cloudflare-stack/sdk
npm publish --access public
```
