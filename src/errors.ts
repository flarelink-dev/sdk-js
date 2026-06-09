// Shared error types. Callers get a concrete class to instanceof against,
// plus the BetterAuth machine-readable `code` so they can branch on
// "INVALID_PASSWORD" / "TOO_MANY_REQUESTS" / etc. without string-matching.

export class FlarelinkError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'FlarelinkError';
    this.status = status;
    this.code = code;
  }
}

export class AuthError extends FlarelinkError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = 'AuthError';
  }
}

export class StorageError extends FlarelinkError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = 'StorageError';
  }
}

export class DatabaseError extends FlarelinkError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = 'DatabaseError';
  }
}

/** Thrown when a server-only API is called without a service key. */
export class MissingServiceKeyError extends FlarelinkError {
  constructor(api: 'storage' | 'database') {
    super(
      `flarelink.${api} requires a service key. Pass it to createFlarelink({ serviceKey }) — only do this on the server (never in the browser). Mint a key from your project's dashboard.`,
      400,
      'MISSING_SERVICE_KEY',
    );
    this.name = 'MissingServiceKeyError';
  }
}
