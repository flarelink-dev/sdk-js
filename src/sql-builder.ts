// Internal SQL composer. Customer-facing API is in db.ts; this module is
// the engine. Every identifier (table + column names) is validated against
// IDENT_RE before composition — if a string doesn't match, we throw rather
// than letting it reach the SQL.
//
// Values always go through bind parameters. There is no path from a
// customer-supplied value into a SQL string. Try to find one in code review
// before adding any.

import { DatabaseError } from './errors.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Equality = string | number | boolean | null;

export function assertIdent(name: string, role: 'table' | 'column'): void {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new DatabaseError(
      `Invalid ${role} name: ${JSON.stringify(
        name,
      )}. Must match /^[A-Za-z_][A-Za-z0-9_]*$/ — use flarelink.sql\`...\` for anything more dynamic.`,
      400,
      'INVALID_IDENTIFIER',
    );
  }
}

// Build a WHERE clause from a filter object. Equality only, AND-chained.
// NULL becomes `IS NULL` (not `= NULL`, which is always false in SQL).
// Arrays + objects in the filter throw with a message pointing at
// flarelink.sql — keeps the builder surface honestly minimal.
export type WhereFilter = Record<string, Equality>;

export function composeWhere(
  filter: WhereFilter,
  paramOffset = 0,
): { sql: string; params: Equality[] } {
  const parts: string[] = [];
  const params: Equality[] = [];
  for (const [col, value] of Object.entries(filter)) {
    assertIdent(col, 'column');
    if (value === null) {
      parts.push(`"${col}" IS NULL`);
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      params.push(value);
      parts.push(`"${col}" = ?${paramOffset + params.length}`);
      continue;
    }
    throw new DatabaseError(
      `Unsupported filter value for column ${JSON.stringify(col)} (${typeof value}). ` +
        `where() takes equality on primitives or NULL — use flarelink.sql\`...\` for IN / ranges / OR / etc.`,
      400,
      'UNSUPPORTED_FILTER',
    );
  }
  return { sql: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

// Build a SELECT query.
export function composeSelect(opts: {
  table: string;
  columns: '*' | string[];
  where?: WhereFilter;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}): { sql: string; params: Equality[] } {
  assertIdent(opts.table, 'table');
  const cols =
    opts.columns === '*'
      ? '*'
      : opts.columns
          .map((c) => {
            assertIdent(c, 'column');
            return `"${c}"`;
          })
          .join(', ');
  let sql = `SELECT ${cols} FROM "${opts.table}"`;
  let params: Equality[] = [];
  if (opts.where) {
    const w = composeWhere(opts.where);
    sql += ` WHERE ${w.sql}`;
    params = params.concat(w.params);
  }
  if (opts.orderBy) {
    assertIdent(opts.orderBy.column, 'column');
    const dir = opts.orderBy.direction === 'desc' ? 'DESC' : 'ASC';
    sql += ` ORDER BY "${opts.orderBy.column}" ${dir}`;
  }
  if (typeof opts.limit === 'number') {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) {
      throw new DatabaseError('limit must be a non-negative integer', 400, 'INVALID_LIMIT');
    }
    sql += ` LIMIT ${opts.limit}`;
  }
  if (typeof opts.offset === 'number') {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) {
      throw new DatabaseError('offset must be a non-negative integer', 400, 'INVALID_OFFSET');
    }
    sql += ` OFFSET ${opts.offset}`;
  }
  return { sql, params };
}

// Build INSERT — accepts a single row or an array of rows. All rows must
// have the same column shape; we use the first row's keys as the schema.
export function composeInsert(opts: {
  table: string;
  rows: Record<string, Equality>[];
  returning?: '*' | string[];
}): { sql: string; params: Equality[] } {
  assertIdent(opts.table, 'table');
  if (opts.rows.length === 0) {
    throw new DatabaseError('insert(): no rows provided', 400, 'EMPTY_INSERT');
  }
  const cols = Object.keys(opts.rows[0]!);
  if (cols.length === 0) {
    throw new DatabaseError(
      'insert(): row has no columns. Pass at least one column to insert a row.',
      400,
      'EMPTY_ROW',
    );
  }
  for (const c of cols) assertIdent(c, 'column');
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const params: Equality[] = [];
  const valueGroups: string[] = [];
  for (const row of opts.rows) {
    const placeholders: string[] = [];
    for (const c of cols) {
      const v = row[c];
      // Allow undefined as null on insert — most ORMs default missing
      // columns to NULL; matches user expectation.
      params.push(v === undefined ? null : (v as Equality));
      placeholders.push(`?${params.length}`);
    }
    valueGroups.push(`(${placeholders.join(', ')})`);
  }
  let sql = `INSERT INTO "${opts.table}" (${colList}) VALUES ${valueGroups.join(', ')}`;
  if (opts.returning) {
    sql += ` RETURNING ${composeReturning(opts.returning)}`;
  }
  return { sql, params };
}

export function composeUpdate(opts: {
  table: string;
  patch: Record<string, Equality>;
  where?: WhereFilter;
  returning?: '*' | string[];
}): { sql: string; params: Equality[] } {
  assertIdent(opts.table, 'table');
  const cols = Object.keys(opts.patch);
  if (cols.length === 0) {
    throw new DatabaseError(
      'update(): patch is empty. Pass at least one column to update.',
      400,
      'EMPTY_PATCH',
    );
  }
  const params: Equality[] = [];
  const setParts: string[] = [];
  for (const c of cols) {
    assertIdent(c, 'column');
    const v = opts.patch[c]!;
    params.push(v);
    setParts.push(`"${c}" = ?${params.length}`);
  }
  let sql = `UPDATE "${opts.table}" SET ${setParts.join(', ')}`;
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

export function composeDelete(opts: {
  table: string;
  where?: WhereFilter;
}): { sql: string; params: Equality[] } {
  assertIdent(opts.table, 'table');
  let sql = `DELETE FROM "${opts.table}"`;
  const params: Equality[] = [];
  if (opts.where) {
    const w = composeWhere(opts.where);
    sql += ` WHERE ${w.sql}`;
    params.push(...w.params);
  }
  return { sql, params };
}

function composeReturning(returning: '*' | string[]): string {
  if (returning === '*') return '*';
  return returning
    .map((c) => {
      assertIdent(c, 'column');
      return `"${c}"`;
    })
    .join(', ');
}

// Tagged-template SQL: turn `SELECT * WHERE id = ${userId}` into
//   sql: "SELECT * WHERE id = ?1"
//   params: [userId]
// Every interpolated value becomes a bind param. There is no path to inject
// raw SQL via this entry point — interpolation is the only way values get
// in, and the result strings are concatenations of the developer-owned
// template parts.
export function composeTaggedSql(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: unknown[] } {
  let sql = '';
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i] ?? '';
    if (i < values.length) {
      params.push(values[i]);
      sql += `?${params.length}`;
    }
  }
  return { sql, params };
}
