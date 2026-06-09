// src/errors.ts
var FlarelinkError = class extends Error {
  status;
  code;
  constructor(message, status, code) {
    super(message);
    this.name = "FlarelinkError";
    this.status = status;
    this.code = code;
  }
};
var AuthError = class extends FlarelinkError {
  constructor(message, status, code) {
    super(message, status, code);
    this.name = "AuthError";
  }
};
var StorageError = class extends FlarelinkError {
  constructor(message, status, code) {
    super(message, status, code);
    this.name = "StorageError";
  }
};
var DatabaseError = class extends FlarelinkError {
  constructor(message, status, code) {
    super(message, status, code);
    this.name = "DatabaseError";
  }
};
var MissingServiceKeyError = class extends FlarelinkError {
  constructor(api) {
    super(
      `flarelink.${api} requires a service key. Pass it to createFlarelink({ serviceKey }) \u2014 only do this on the server (never in the browser). Mint a key from your project's dashboard.`,
      400,
      "MISSING_SERVICE_KEY"
    );
    this.name = "MissingServiceKeyError";
  }
};

// src/auth.ts
function createAuth(base, f) {
  async function call(path, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyBearing = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const headers = {
      ...init.headers ?? {}
    };
    let body = init.body;
    if (bodyBearing) {
      if (body === void 0 || body === null) body = "{}";
      if (headers["Content-Type"] === void 0) headers["Content-Type"] = "application/json";
    }
    const res = await f(`${base}${path}`, {
      ...init,
      credentials: "include",
      headers,
      body
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new AuthError(
        data.message ?? data.error ?? res.statusText,
        res.status,
        data.code
      );
    }
    return await res.json();
  }
  const fetchMe = async () => {
    try {
      return await call("/api/me");
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) return null;
      throw err;
    }
  };
  const browserDefault = () => typeof location !== "undefined" ? location.href : void 0;
  return {
    signUp: (input) => call("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        callbackURL: input.callbackURL ?? browserDefault()
      })
    }),
    signIn: (input) => call("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify(input)
    }),
    signInWithSocial: async (provider, opts = {}) => {
      const callbackURL = opts.callbackURL ?? browserDefault();
      const r = await call("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider, callbackURL })
      });
      if (!opts.noRedirect && typeof location !== "undefined") {
        location.href = r.url;
      }
      return r;
    },
    signInWithMagicLink: (email, opts = {}) => {
      const callbackURL = opts.callbackURL ?? browserDefault();
      return call("/api/auth/sign-in/magic-link", {
        method: "POST",
        body: JSON.stringify({ email, callbackURL })
      });
    },
    signOut: async () => {
      await call("/api/auth/sign-out", { method: "POST" });
    },
    requestPasswordReset: (input) => call("/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify(input)
    }),
    resetPassword: (input) => call("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(input)
    }),
    sendVerificationEmail: (input) => call("/api/auth/send-verification-email", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        callbackURL: input.callbackURL ?? browserDefault()
      })
    }),
    getMe: async () => (await fetchMe())?.user ?? null,
    getSession: async () => (await fetchMe())?.session ?? null
  };
}

// src/sql-builder.ts
var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name, role) {
  if (typeof name !== "string" || !IDENT_RE.test(name)) {
    throw new DatabaseError(
      `Invalid ${role} name: ${JSON.stringify(
        name
      )}. Must match /^[A-Za-z_][A-Za-z0-9_]*$/ \u2014 use flarelink.sql\`...\` for anything more dynamic.`,
      400,
      "INVALID_IDENTIFIER"
    );
  }
}
function composeWhere(filter, paramOffset = 0) {
  const parts = [];
  const params = [];
  for (const [col, value] of Object.entries(filter)) {
    assertIdent(col, "column");
    if (value === null) {
      parts.push(`"${col}" IS NULL`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.push(value);
      parts.push(`"${col}" = ?${paramOffset + params.length}`);
      continue;
    }
    throw new DatabaseError(
      `Unsupported filter value for column ${JSON.stringify(col)} (${typeof value}). where() takes equality on primitives or NULL \u2014 use flarelink.sql\`...\` for IN / ranges / OR / etc.`,
      400,
      "UNSUPPORTED_FILTER"
    );
  }
  return { sql: parts.length > 0 ? parts.join(" AND ") : "1=1", params };
}
function composeSelect(opts) {
  assertIdent(opts.table, "table");
  const cols = opts.columns === "*" ? "*" : opts.columns.map((c) => {
    assertIdent(c, "column");
    return `"${c}"`;
  }).join(", ");
  let sql = `SELECT ${cols} FROM "${opts.table}"`;
  let params = [];
  if (opts.where) {
    const w = composeWhere(opts.where);
    sql += ` WHERE ${w.sql}`;
    params = params.concat(w.params);
  }
  if (opts.orderBy) {
    assertIdent(opts.orderBy.column, "column");
    const dir = opts.orderBy.direction === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY "${opts.orderBy.column}" ${dir}`;
  }
  if (typeof opts.limit === "number") {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) {
      throw new DatabaseError("limit must be a non-negative integer", 400, "INVALID_LIMIT");
    }
    sql += ` LIMIT ${opts.limit}`;
  }
  if (typeof opts.offset === "number") {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) {
      throw new DatabaseError("offset must be a non-negative integer", 400, "INVALID_OFFSET");
    }
    sql += ` OFFSET ${opts.offset}`;
  }
  return { sql, params };
}
function composeInsert(opts) {
  assertIdent(opts.table, "table");
  if (opts.rows.length === 0) {
    throw new DatabaseError("insert(): no rows provided", 400, "EMPTY_INSERT");
  }
  const cols = Object.keys(opts.rows[0]);
  if (cols.length === 0) {
    throw new DatabaseError(
      "insert(): row has no columns. Pass at least one column to insert a row.",
      400,
      "EMPTY_ROW"
    );
  }
  for (const c of cols) assertIdent(c, "column");
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const params = [];
  const valueGroups = [];
  for (const row of opts.rows) {
    const placeholders = [];
    for (const c of cols) {
      const v = row[c];
      params.push(v === void 0 ? null : v);
      placeholders.push(`?${params.length}`);
    }
    valueGroups.push(`(${placeholders.join(", ")})`);
  }
  let sql = `INSERT INTO "${opts.table}" (${colList}) VALUES ${valueGroups.join(", ")}`;
  if (opts.returning) {
    sql += ` RETURNING ${composeReturning(opts.returning)}`;
  }
  return { sql, params };
}
function composeUpdate(opts) {
  assertIdent(opts.table, "table");
  const cols = Object.keys(opts.patch);
  if (cols.length === 0) {
    throw new DatabaseError(
      "update(): patch is empty. Pass at least one column to update.",
      400,
      "EMPTY_PATCH"
    );
  }
  const params = [];
  const setParts = [];
  for (const c of cols) {
    assertIdent(c, "column");
    const v = opts.patch[c];
    params.push(v);
    setParts.push(`"${c}" = ?${params.length}`);
  }
  let sql = `UPDATE "${opts.table}" SET ${setParts.join(", ")}`;
  if (opts.where) {
    const w = composeWhere(opts.where, params.length);
    sql += ` WHERE ${w.sql}`;
    params.push(...w.params);
  }
  if (opts.returning) {
    sql += ` RETURNING ${composeReturning(opts.returning)}`;
  }
  return { sql, params };
}
function composeDelete(opts) {
  assertIdent(opts.table, "table");
  let sql = `DELETE FROM "${opts.table}"`;
  const params = [];
  if (opts.where) {
    const w = composeWhere(opts.where);
    sql += ` WHERE ${w.sql}`;
    params.push(...w.params);
  }
  return { sql, params };
}
function composeReturning(returning) {
  if (returning === "*") return "*";
  return returning.map((c) => {
    assertIdent(c, "column");
    return `"${c}"`;
  }).join(", ");
}
function composeTaggedSql(strings, values) {
  let sql = "";
  const params = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i] ?? "";
    if (i < values.length) {
      params.push(values[i]);
      sql += `?${params.length}`;
    }
  }
  return { sql, params };
}

// src/db.ts
async function postQuery(base, serviceKey, f, sql, params) {
  const res = await f(`${base}/api/db/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sql, params })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DatabaseError(body.error ?? res.statusText, res.status, body.code);
  }
  const data = await res.json();
  return { rows: data.results, meta: data.meta };
}
function createDatabase(base, serviceKey, f) {
  const requireKey = () => {
    if (!serviceKey) throw new MissingServiceKeyError("database");
    return serviceKey;
  };
  function makeSelect(state) {
    const exec = async () => {
      const key = requireKey();
      const { sql, params } = composeSelect(state);
      return await postQuery(base, key, f, sql, params);
    };
    return {
      select: (columns) => makeSelect({ ...state, columns: normalizeCols(columns) }),
      where: (filter) => makeSelect({ ...state, where: filter }),
      orderBy: (column, direction = "asc") => makeSelect({
        ...state,
        orderBy: { column, direction }
      }),
      limit: (n) => makeSelect({ ...state, limit: n }),
      offset: (n) => makeSelect({ ...state, offset: n }),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected)
    };
  }
  function makeInsert(table, rows, returning) {
    const exec = async () => {
      const key = requireKey();
      const { sql, params } = composeInsert({ table, rows, returning });
      return await postQuery(base, key, f, sql, params);
    };
    return {
      returning: (cols) => makeInsert(table, rows, normalizeCols(cols ?? "*")),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected)
    };
  }
  function makeUpdate(table, patch, where, returning) {
    const exec = async () => {
      const key = requireKey();
      const { sql, params } = composeUpdate({ table, patch, where, returning });
      return await postQuery(base, key, f, sql, params);
    };
    return {
      where: (filter) => makeUpdate(table, patch, filter, returning),
      returning: (cols) => makeUpdate(table, patch, where, normalizeCols(cols ?? "*")),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected)
    };
  }
  function makeDelete(table, where) {
    const exec = async () => {
      const key = requireKey();
      const { sql, params } = composeDelete({ table, where });
      return await postQuery(base, key, f, sql, params);
    };
    return {
      where: (filter) => makeDelete(table, filter),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected)
    };
  }
  return {
    from: (table) => {
      assertIdent(table, "table");
      const select = makeSelect({ table, columns: "*" });
      const tableQuery = select;
      tableQuery.insert = (row) => {
        const rows = Array.isArray(row) ? row : [row];
        return makeInsert(table, rows);
      };
      tableQuery.update = (patch) => makeUpdate(table, patch);
      tableQuery.delete = () => makeDelete(table);
      return tableQuery;
    },
    sql: async (strings, ...values) => {
      const key = requireKey();
      const { sql, params } = composeTaggedSql(strings, values);
      return await postQuery(base, key, f, sql, params);
    }
  };
}
function normalizeCols(cols) {
  if (cols === "*") return "*";
  return [...cols];
}

// src/storage.ts
function createStorage(base, serviceKey, f) {
  const requireKey = () => {
    if (!serviceKey) throw new MissingServiceKeyError("storage");
    return serviceKey;
  };
  async function call(path, init = {}) {
    const key = requireKey();
    const headers = {
      Authorization: `Bearer ${key}`,
      ...init.headers ?? {}
    };
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && headers["Content-Type"] === void 0) {
      headers["Content-Type"] = "application/json";
    }
    const url = new URL(`${base}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== void 0 && v !== "") url.searchParams.set(k, v);
      }
    }
    const res = await f(url.toString(), { ...init, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new StorageError(
        body.error ?? res.statusText,
        res.status,
        body.code
      );
    }
    return await res.json();
  }
  return {
    listBuckets: async () => {
      const r = await call("/api/storage/buckets");
      return r.buckets;
    },
    from: (bucket) => ({
      createSignedUploadUrl: async (key, opts = {}) => {
        const r = await call(
          "/api/storage/presign",
          {
            method: "POST",
            body: JSON.stringify({
              bucket,
              key,
              op: "put",
              contentType: opts.contentType,
              expiresIn: opts.expiresIn
            })
          }
        );
        return { url: r.url, signedHeaders: r.signedHeaders };
      },
      createSignedDownloadUrl: async (key, opts = {}) => {
        const r = await call("/api/storage/presign", {
          method: "POST",
          body: JSON.stringify({
            bucket,
            key,
            op: "get",
            expiresIn: opts.expiresIn
          })
        });
        return { url: r.url };
      },
      remove: async (keys) => {
        for (const k of keys) {
          await call("/api/storage/object", {
            method: "DELETE",
            body: JSON.stringify({ bucket, key: k })
          });
        }
      },
      list: async (opts = {}) => {
        return call("/api/storage/list", {
          method: "GET",
          query: {
            bucket,
            ...opts.prefix !== void 0 && { prefix: opts.prefix },
            ...opts.cursor !== void 0 && { cursor: opts.cursor }
          }
        });
      }
    })
  };
}

// src/index.ts
function createFlarelink(config) {
  if (!config?.url) {
    throw new Error(
      `createFlarelink({ url }) is required. The URL is your project's auth Worker, e.g. "https://myapp-auth.your-subdomain.workers.dev" \u2014 find it in the Flarelink dashboard.`
    );
  }
  const base = config.url.replace(/\/$/, "");
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
    sql: (strings, ...values) => db.sql(strings, ...values)
  };
}
function normalizeCookies(c) {
  if (c === void 0) return void 0;
  if (typeof c === "string") {
    const value = c;
    return async () => value;
  }
  return async () => c();
}
function wrapFetchWithCookies(base, getCookies) {
  return async (input, init) => {
    const cookie = await getCookies();
    if (!cookie) return base(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has("cookie")) headers.set("cookie", cookie);
    return base(input, { ...init, headers });
  };
}

export { AuthError, DatabaseError, FlarelinkError, MissingServiceKeyError, StorageError, createFlarelink };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map