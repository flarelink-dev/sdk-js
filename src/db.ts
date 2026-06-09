// Database surface — server-only query builder over the project's D1.
//
// Wire shape:
//   POST {url}/api/db/query  { sql, params? } → { results, meta }
//   POST {url}/api/db/batch  { statements }   → { responses: [{ results, meta }] }
//
// Server-only because the service key is the only auth: anyone with the
// key has full DB access. Use server env (process.env, CF env binding,
// SvelteKit `$env/static/private`, etc.). Never bundle the service key
// into client-side code.
//
// The chainable builder is a thin facade over composeSelect/Insert/Update/
// Delete in sql-builder.ts. Every method returns the same chainable object
// so calls compose into one terminal request. Awaiting (via the .then on
// the chainable) sends the HTTP request.

import { DatabaseError, MissingServiceKeyError } from './errors.js';
import {
  assertIdent,
  composeDelete,
  composeInsert,
  composeSelect,
  composeTaggedSql,
  composeUpdate,
  type Equality,
} from './sql-builder.js';

export type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  meta: {
    duration: number;
    rows_read?: number;
    rows_written?: number;
    last_row_id?: number;
    changes?: number;
  };
};

export type { Equality };

export type QueryBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
  /** `*` is the default — call this only when you want to narrow. */
  select(columns: '*' | (keyof T & string)[] | string[]): QueryBuilder<T>;
  /** Equality filter, AND-chained. NULL becomes `IS NULL`. */
  where(filter: Partial<Record<keyof T & string, Equality>>): QueryBuilder<T>;
  orderBy(column: keyof T & string, direction?: 'asc' | 'desc'): QueryBuilder<T>;
  limit(n: number): QueryBuilder<T>;
  offset(n: number): QueryBuilder<T>;
};

export type InsertBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
  /** Return the inserted row(s). Without this, the promise resolves with `rows: []`. */
  returning(columns?: '*' | (keyof T & string)[] | string[]): InsertBuilder<T>;
};

export type UpdateBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
  where(filter: Partial<Record<keyof T & string, Equality>>): UpdateBuilder<T>;
  returning(columns?: '*' | (keyof T & string)[] | string[]): UpdateBuilder<T>;
};

export type DeleteBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
  where(filter: Partial<Record<keyof T & string, Equality>>): DeleteBuilder<T>;
};

export type TableQuery<T = Record<string, unknown>> = QueryBuilder<T> & {
  insert(row: Partial<T> | Partial<T>[]): InsertBuilder<T>;
  update(patch: Partial<T>): UpdateBuilder<T>;
  delete(): DeleteBuilder<T>;
};

export type Database = {
  from<T extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
  ): TableQuery<T>;

  /**
   * Raw SQL escape hatch. Tagged-template syntax interpolates values as
   * bind params — there's no way for an interpolated value to inject SQL:
   *   await flarelink.sql`SELECT * FROM users WHERE id = ${userId}`
   */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<QueryResult<T>>;
};

// Internal HTTP transport for a single query.
async function postQuery(
  base: string,
  serviceKey: string,
  f: typeof fetch,
  sql: string,
  params: unknown[],
): Promise<QueryResult> {
  const res = await f(`${base}/api/db/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new DatabaseError(body.error ?? res.statusText, res.status, body.code);
  }
  const data = (await res.json()) as {
    results: Record<string, unknown>[];
    meta: QueryResult['meta'];
  };
  return { rows: data.results, meta: data.meta };
}

export function createDatabase(
  base: string,
  serviceKey: string | undefined,
  f: typeof fetch,
): Database {
  const requireKey = (): string => {
    if (!serviceKey) throw new MissingServiceKeyError('database');
    return serviceKey;
  };

  // SELECT builder. State accumulates via clone-and-return so a builder
  // can't be mutated mid-chain (each call returns a fresh object that
  // shares immutable state).
  type SelectState = {
    table: string;
    columns: '*' | string[];
    where?: Record<string, Equality>;
    orderBy?: { column: string; direction: 'asc' | 'desc' };
    limit?: number;
    offset?: number;
  };
  function makeSelect<T extends Record<string, unknown>>(
    state: SelectState,
  ): QueryBuilder<T> {
    const exec = async (): Promise<QueryResult<T>> => {
      const key = requireKey();
      const { sql, params } = composeSelect(state);
      return (await postQuery(base, key, f, sql, params)) as QueryResult<T>;
    };
    return {
      select: (columns) => makeSelect<T>({ ...state, columns: normalizeCols(columns) }),
      where: (filter) =>
        makeSelect<T>({ ...state, where: filter as Record<string, Equality> }),
      orderBy: (column, direction = 'asc') =>
        makeSelect<T>({
          ...state,
          orderBy: { column: column as string, direction },
        }),
      limit: (n) => makeSelect<T>({ ...state, limit: n }),
      offset: (n) => makeSelect<T>({ ...state, offset: n }),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected),
    };
  }

  function makeInsert<T extends Record<string, unknown>>(
    table: string,
    rows: Record<string, Equality>[],
    returning?: '*' | string[],
  ): InsertBuilder<T> {
    const exec = async (): Promise<QueryResult<T>> => {
      const key = requireKey();
      const { sql, params } = composeInsert({ table, rows, returning });
      return (await postQuery(base, key, f, sql, params)) as QueryResult<T>;
    };
    return {
      returning: (cols) => makeInsert<T>(table, rows, normalizeCols(cols ?? '*')),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected),
    };
  }

  function makeUpdate<T extends Record<string, unknown>>(
    table: string,
    patch: Record<string, Equality>,
    where?: Record<string, Equality>,
    returning?: '*' | string[],
  ): UpdateBuilder<T> {
    const exec = async (): Promise<QueryResult<T>> => {
      const key = requireKey();
      const { sql, params } = composeUpdate({ table, patch, where, returning });
      return (await postQuery(base, key, f, sql, params)) as QueryResult<T>;
    };
    return {
      where: (filter) =>
        makeUpdate<T>(table, patch, filter as Record<string, Equality>, returning),
      returning: (cols) => makeUpdate<T>(table, patch, where, normalizeCols(cols ?? '*')),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected),
    };
  }

  function makeDelete<T extends Record<string, unknown>>(
    table: string,
    where?: Record<string, Equality>,
  ): DeleteBuilder<T> {
    const exec = async (): Promise<QueryResult<T>> => {
      const key = requireKey();
      const { sql, params } = composeDelete({ table, where });
      return (await postQuery(base, key, f, sql, params)) as QueryResult<T>;
    };
    return {
      where: (filter) => makeDelete<T>(table, filter as Record<string, Equality>),
      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected),
    };
  }

  return {
    from: <T extends Record<string, unknown>>(table: string) => {
      // Defer key check until execution — instantiating a builder without a
      // key shouldn't throw (lets callers compose builders for codegen,
      // tests, etc.). Identifier validation IS eager because that's a
      // programmer error caught early.
      assertIdent(table, 'table');
      const select = makeSelect<T>({ table, columns: '*' });
      const tableQuery = select as TableQuery<T>;
      // Augment with the write methods. TS already knows the shape via the
      // intersection — these casts are just glue.
      (tableQuery as TableQuery<T>).insert = (row) => {
        // Partial<T> permits undefined per-field; the composer turns those
        // into NULL on insert. Cast at the boundary — runtime handles it.
        const rows = (Array.isArray(row) ? row : [row]) as Record<string, Equality>[];
        return makeInsert<T>(table, rows) as InsertBuilder<T>;
      };
      (tableQuery as TableQuery<T>).update = (patch) =>
        makeUpdate<T>(table, patch as Record<string, Equality>);
      (tableQuery as TableQuery<T>).delete = () => makeDelete<T>(table);
      return tableQuery;
    },
    sql: async <T extends Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const key = requireKey();
      const { sql, params } = composeTaggedSql(strings, values);
      return (await postQuery(base, key, f, sql, params)) as QueryResult<T>;
    },
  };
}

function normalizeCols(cols: '*' | string[] | readonly string[]): '*' | string[] {
  if (cols === '*') return '*';
  return [...cols];
}
