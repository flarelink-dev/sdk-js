// SDK smoke test — server-side surface.
//
// Run:  node server.mjs   (after `cp .env.example .env` + fill in vars)
//
// Walks the storage + db endpoints against a real deployed Worker. Each
// step prints "ok" / "fail" with timing. Exits 1 on any failure so this
// can be plugged into CI.
//
// What it does:
//   1. listBuckets    — confirms SigV4 + R2 creds wired up
//   2. presign + PUT  — uploads a tiny file via signed URL (Pattern 3: the
//                       byte path goes browser/client → R2 direct, never
//                       through the Worker)
//   3. list           — finds the file we just uploaded
//   4. presign + GET  — downloads the file and verifies the bytes
//   5. remove         — cleans up the test object
//   6. db SELECT      — reads from the auth user table (proves the gate
//                       + bind-param flow work)
//   7. builder chain  — .from('user').select('email').limit(1)
//   8. invalid ident  — confirms identifier validation throws sync

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createFlarelink,
  AuthError,
  StorageError,
  DatabaseError,
  MissingServiceKeyError,
} from '../dist/index.js';

// Tiny .env loader — avoids a dotenv dep for what is meant as a smoke
// test you can rip out and paste into anything.
function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '.env');
  try {
    const txt = readFileSync(path, 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (!m) continue;
      const [, k, raw] = m;
      const v = raw.replace(/^['"]|['"]$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // No .env — fall back to whatever's already in process.env.
  }
}
loadEnv();

const { URL: WORKER_URL, SERVICE_KEY, BUCKET } = process.env;
if (!WORKER_URL || !SERVICE_KEY) {
  console.error('Missing URL or SERVICE_KEY in env. See .env.example.');
  process.exit(1);
}

const flarelink = createFlarelink({ url: WORKER_URL, serviceKey: SERVICE_KEY });

// --- runner ---------------------------------------------------------------

let pass = 0;
let fail = 0;
let skip = 0;

async function step(name, fn) {
  process.stdout.write(`  ${name.padEnd(48)} `);
  const t0 = Date.now();
  try {
    const v = await fn();
    if (v === 'skip') {
      console.log(`skip   (${Date.now() - t0}ms)`);
      skip++;
      return;
    }
    console.log(`ok     (${Date.now() - t0}ms)`);
    pass++;
    return v;
  } catch (err) {
    console.log(`FAIL   (${Date.now() - t0}ms)`);
    console.log(`    ${err.constructor.name}: ${err.message}`);
    if (err.code) console.log(`    code: ${err.code}`);
    if (err.status) console.log(`    status: ${err.status}`);
    fail++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --- storage --------------------------------------------------------------

section(`Storage — ${WORKER_URL}`);

const testKey = `flarelink-sdk-smoke/${Date.now()}.txt`;
const testBody = `hello from @flarelink/client smoke test at ${new Date().toISOString()}\n`;

await step('listBuckets() returns at least one bucket', async () => {
  // SDK unwraps the wire `{ buckets: [...] }` and returns the array directly.
  const buckets = await flarelink.storage.listBuckets();
  if (!Array.isArray(buckets)) throw new Error('listBuckets() did not return an array');
  console.log(`\n    found ${buckets.length} bucket(s): ${buckets.map((b) => b.name).join(', ') || '(none)'}`);
  if (buckets.length === 0) {
    throw new Error('No buckets visible to the service key. Attach one in the dashboard Files page.');
  }
});

if (!BUCKET) {
  await step('storage (upload/list/download/remove)', () => 'skip');
} else {
  let uploadUrl;
  await step(`presign PUT  ${BUCKET}/${testKey}`, async () => {
    const r = await flarelink.storage
      .from(BUCKET)
      .createSignedUploadUrl(testKey, { contentType: 'text/plain' });
    if (!r.url) throw new Error('no url returned');
    uploadUrl = r.url;
  });

  await step('PUT bytes directly to R2', async () => {
    if (!uploadUrl) throw new Error('no upload url from previous step');
    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: testBody,
    });
    if (!r.ok) {
      throw new Error(`R2 PUT failed: ${r.status} ${await r.text()}`);
    }
  });

  await step(`list ${BUCKET}/flarelink-sdk-smoke/`, async () => {
    const r = await flarelink.storage
      .from(BUCKET)
      .list({ prefix: 'flarelink-sdk-smoke/' });
    const hit = r.objects?.find((o) => o.key === testKey);
    if (!hit) {
      throw new Error(`did not find ${testKey} in list (${r.objects?.length ?? 0} objects)`);
    }
  });

  let downloadUrl;
  await step(`presign GET  ${BUCKET}/${testKey}`, async () => {
    const r = await flarelink.storage.from(BUCKET).createSignedDownloadUrl(testKey);
    if (!r.url) throw new Error('no url returned');
    downloadUrl = r.url;
  });

  await step('GET bytes directly from R2 + verify body', async () => {
    if (!downloadUrl) throw new Error('no download url');
    const r = await fetch(downloadUrl);
    if (!r.ok) throw new Error(`R2 GET failed: ${r.status}`);
    const got = await r.text();
    if (got !== testBody) {
      throw new Error(`body mismatch:\n  sent:   ${JSON.stringify(testBody)}\n  got:    ${JSON.stringify(got)}`);
    }
  });

  await step(`remove ${BUCKET}/${testKey}`, async () => {
    await flarelink.storage.from(BUCKET).remove([testKey]);
  });
}

// --- database -------------------------------------------------------------

section('Database');

await step('flarelink.sql`SELECT 1 as one` → 1 row', async () => {
  // All db results have shape { rows: T[], meta }. Not `.results`.
  const r = await flarelink.sql`SELECT 1 as one`;
  if (!Array.isArray(r.rows) || r.rows[0]?.one !== 1) {
    throw new Error(`unexpected result: ${JSON.stringify(r)}`);
  }
});

await step('flarelink.from("user").select().limit(1)', async () => {
  // Awaiting the builder gives { rows, meta } — the builder is a PromiseLike
  // resolving to QueryResult, not bare rows.
  const r = await flarelink
    .from('user')
    .select(['id', 'email', 'name'])
    .limit(1);
  if (!Array.isArray(r.rows)) {
    throw new Error(`expected r.rows to be an array, got: ${typeof r.rows}`);
  }
  console.log(`\n    sample user: ${r.rows[0] ? JSON.stringify({ email: r.rows[0].email }) : '(no users yet)'} · D1 duration ${r.meta?.duration ?? '?'}ms`);
});

await step('builder is chainable + immutable', async () => {
  const q = flarelink.from('user').select(['email']);
  const a = q.limit(1);
  const b = q.limit(2);
  // Both should be valid; building one should not have mutated the other.
  await a;
  await b;
});

await step('tagged sql binds values, never concatenates', async () => {
  const fakeId = `not-a-real-id-${Date.now()}`;
  // Should be safe even though the value contains "; DROP TABLE user;"
  const evil = `'; DROP TABLE user; --`;
  const r = await flarelink.sql`SELECT id FROM user WHERE id = ${fakeId} OR id = ${evil}`;
  if (r.rows.length !== 0) {
    throw new Error(`expected 0 results for fake ids, got ${r.rows.length}`);
  }
});

await step('invalid identifier throws synchronously (no HTTP roundtrip)', async () => {
  let threw = false;
  try {
    flarelink.from('user; DROP TABLE user');
  } catch (err) {
    threw = true;
    if (!(err instanceof DatabaseError)) {
      throw new Error(`expected DatabaseError, got ${err.constructor.name}`);
    }
    if (err.code !== 'INVALID_IDENTIFIER') {
      throw new Error(`expected code INVALID_IDENTIFIER, got ${err.code}`);
    }
  }
  if (!threw) throw new Error('expected to throw on malicious table name');
});

await step('MissingServiceKeyError when no key passed', async () => {
  const noKey = createFlarelink({ url: WORKER_URL });
  let threw = false;
  try {
    await noKey.from('user').select(['id']).limit(1);
  } catch (err) {
    threw = true;
    if (!(err instanceof MissingServiceKeyError)) {
      throw new Error(`expected MissingServiceKeyError, got ${err.constructor.name}`);
    }
  }
  if (!threw) throw new Error('expected to throw without service key');
});

await step('bad service key → AuthError-like 401', async () => {
  const badKey = createFlarelink({
    url: WORKER_URL,
    serviceKey: 'flarelink_sk_definitely_not_valid_0000000000000000',
  });
  let threw = false;
  try {
    await badKey.from('user').select(['id']).limit(1);
  } catch (err) {
    threw = true;
    if (!(err instanceof DatabaseError)) {
      throw new Error(`expected DatabaseError, got ${err.constructor.name}`);
    }
    if (err.status !== 401) {
      throw new Error(`expected status 401, got ${err.status}`);
    }
  }
  if (!threw) throw new Error('expected to throw with bad key');
});

// --- summary --------------------------------------------------------------

console.log(`\n  → ${pass} pass · ${skip} skip · ${fail} fail`);
// Silence unused-import lint for the error classes we only conditionally throw
void AuthError;
void StorageError;
process.exit(fail > 0 ? 1 : 0);
