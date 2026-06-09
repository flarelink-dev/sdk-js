type FlarelinkConfig = {
    /**
     * URL of the Flarelink auth Worker provisioned for your project. Looks like
     * `https://myapp-auth.your-subdomain.workers.dev`. Find it in the Flarelink
     * dashboard under your project's Authentication page.
     */
    url: string;
    /**
     * Per-project service key. Required to use `flarelink.storage.*` or
     * `flarelink.from(...)`. NEVER include this in client-side bundles — it grants
     * full DB + R2 access for the project. Read from server env (process.env,
     * Cloudflare env binding, etc.).
     *
     * Mint a service key from the project's Flarelink dashboard.
     */
    serviceKey?: string;
    /**
     * Cookie header forwarded on every server-side request to the auth Worker.
     * Needed by `flarelink.auth.getMe()` / `getSession()` from server contexts
     * (Next.js route handlers, SvelteKit loaders, Remix loaders, etc.) because
     * browser cookies aren't on the server `fetch` by default.
     *
     * Accepts a string (read once at construction) or a function called
     * per-request (sync or async — best when cookies are request-scoped):
     *
     *   // Next.js (App Router)
     *   cookies: () => cookies().toString()
     *
     *   // Anything with a Request
     *   cookies: () => request.headers.get('cookie') ?? ''
     *
     * No effect in the browser, where cookies flow automatically via
     * `credentials: 'include'`. If you provide both `cookies` and `fetch`, the
     * SDK adds the Cookie header before delegating to your custom fetch.
     */
    cookies?: string | (() => string | Promise<string>);
    /**
     * Replace the global `fetch`. Useful for tests or low-level customisation
     * beyond what `cookies` covers. Defaults to the global `fetch`.
     */
    fetch?: typeof fetch;
};
type User = {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
    updatedAt: string;
};
type Session = {
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
};
type SocialProvider = 'google' | 'github';
type SignUpInput = {
    email: string;
    password: string;
    name: string;
    /**
     * URL the user lands on after clicking the verification email link
     * (only relevant when email verification is enabled on this deployment).
     * Defaults to the current page URL when called from a browser.
     */
    callbackURL?: string;
};
type SignInInput = {
    email: string;
    password: string;
};
type SignInWithSocialOptions = {
    /** Where to send the user after the OAuth dance finishes. Default: current URL. */
    callbackURL?: string;
    /** If true, return the provider URL instead of navigating. Useful for SSR. */
    noRedirect?: boolean;
};
type SignInWithMagicLinkOptions = {
    /** URL the user lands on after the magic-link sign-in succeeds. Default: current URL. */
    callbackURL?: string;
};
type RequestPasswordResetInput = {
    email: string;
    /**
     * Page on your app the user lands on after clicking the link in the email.
     * BetterAuth appends `?token=...` to it; your page reads the token and
     * calls `resetPassword({ newPassword, token })`.
     */
    redirectTo: string;
};
type ResetPasswordInput = {
    newPassword: string;
    token: string;
};
type SendVerificationEmailInput = {
    email: string;
    /** URL the user lands on after the email is verified. Default: current URL. */
    callbackURL?: string;
};

type Auth = {
    signUp(input: SignUpInput): Promise<{
        user: User;
    }>;
    signIn(input: SignInInput): Promise<{
        user: User;
    }>;
    signInWithSocial(provider: SocialProvider, opts?: SignInWithSocialOptions): Promise<{
        url: string;
    }>;
    signInWithMagicLink(email: string, opts?: SignInWithMagicLinkOptions): Promise<{
        status: boolean;
    }>;
    signOut(): Promise<void>;
    /**
     * Triggers a password-reset email. Always resolves with `{ status: true }`
     * even when the email is unknown — that's deliberate, BetterAuth doesn't
     * leak account existence on this endpoint.
     */
    requestPasswordReset(input: RequestPasswordResetInput): Promise<{
        status: boolean;
    }>;
    /**
     * Completes the reset using the token from the email link. Your reset
     * page reads `?token=` from the URL and passes it here alongside the
     * new password.
     */
    resetPassword(input: ResetPasswordInput): Promise<{
        status: boolean;
    }>;
    /**
     * Sends a verification email to the address. The link in the email lands
     * the user on `callbackURL` after the email is marked verified.
     */
    sendVerificationEmail(input: SendVerificationEmailInput): Promise<{
        status: boolean;
    }>;
    /** Current user, or null when not signed in. */
    getMe(): Promise<User | null>;
    /** Active session, or null when not signed in. */
    getSession(): Promise<Session | null>;
};

type Equality = string | number | boolean | null;

type QueryResult<T = Record<string, unknown>> = {
    rows: T[];
    meta: {
        duration: number;
        rows_read?: number;
        rows_written?: number;
        last_row_id?: number;
        changes?: number;
    };
};

type QueryBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
    /** `*` is the default — call this only when you want to narrow. */
    select(columns: '*' | (keyof T & string)[] | string[]): QueryBuilder<T>;
    /** Equality filter, AND-chained. NULL becomes `IS NULL`. */
    where(filter: Partial<Record<keyof T & string, Equality>>): QueryBuilder<T>;
    orderBy(column: keyof T & string, direction?: 'asc' | 'desc'): QueryBuilder<T>;
    limit(n: number): QueryBuilder<T>;
    offset(n: number): QueryBuilder<T>;
};
type InsertBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
    /** Return the inserted row(s). Without this, the promise resolves with `rows: []`. */
    returning(columns?: '*' | (keyof T & string)[] | string[]): InsertBuilder<T>;
};
type UpdateBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
    where(filter: Partial<Record<keyof T & string, Equality>>): UpdateBuilder<T>;
    returning(columns?: '*' | (keyof T & string)[] | string[]): UpdateBuilder<T>;
};
type DeleteBuilder<T = Record<string, unknown>> = PromiseLike<QueryResult<T>> & {
    where(filter: Partial<Record<keyof T & string, Equality>>): DeleteBuilder<T>;
};
type TableQuery<T = Record<string, unknown>> = QueryBuilder<T> & {
    insert(row: Partial<T> | Partial<T>[]): InsertBuilder<T>;
    update(patch: Partial<T>): UpdateBuilder<T>;
    delete(): DeleteBuilder<T>;
};
type Database = {
    from<T extends Record<string, unknown> = Record<string, unknown>>(table: string): TableQuery<T>;
    /**
     * Raw SQL escape hatch. Tagged-template syntax interpolates values as
     * bind params — there's no way for an interpolated value to inject SQL:
     *   await flarelink.sql`SELECT * FROM users WHERE id = ${userId}`
     */
    sql<T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult<T>>;
};

type StorageBucket = {
    name: string;
    createdAt: string;
};
type StorageObject = {
    key: string;
    size: number;
    lastModified: string;
    etag: string;
};
type StorageListResponse = {
    objects: StorageObject[];
    prefixes: string[];
    nextCursor?: string;
};
type PresignOptions = {
    /** Default 300s (5 min). Server clamps to [60s, 3600s]. */
    expiresIn?: number;
    contentType?: string;
};
type StorageBucketAPI = {
    /**
     * Mint a presigned PUT URL. Use it with a plain `fetch` (or XHR for
     * progress) — bytes go direct to R2, the Worker never sees them.
     *
     * @returns `url` to PUT to, and `signedHeaders` you must send on the PUT
     *   request (currently `content-type` when supplied). Don't add extra
     *   headers — they'll break the signature.
     */
    createSignedUploadUrl(key: string, opts?: PresignOptions): Promise<{
        url: string;
        signedHeaders: Record<string, string>;
    }>;
    /**
     * Mint a presigned GET URL. Open it in the browser, embed it as an
     * `<img src>`, or fetch it server-side — same URL works anywhere until
     * it expires.
     */
    createSignedDownloadUrl(key: string, opts?: PresignOptions): Promise<{
        url: string;
    }>;
    /** Delete an object. */
    remove(keys: string[]): Promise<void>;
    /**
     * List objects under an optional prefix. Returns up to 1000 per call;
     * pass `cursor` from the previous response to page further.
     */
    list(opts?: {
        prefix?: string;
        cursor?: string;
    }): Promise<StorageListResponse>;
};
type Storage = {
    /** List buckets attached to the project's R2 account. */
    listBuckets(): Promise<StorageBucket[]>;
    /** Scope all operations to a single bucket. */
    from(bucket: string): StorageBucketAPI;
};

declare class FlarelinkError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(message: string, status: number, code?: string);
}
declare class AuthError extends FlarelinkError {
    constructor(message: string, status: number, code?: string);
}
declare class StorageError extends FlarelinkError {
    constructor(message: string, status: number, code?: string);
}
declare class DatabaseError extends FlarelinkError {
    constructor(message: string, status: number, code?: string);
}
/** Thrown when a server-only API is called without a service key. */
declare class MissingServiceKeyError extends FlarelinkError {
    constructor(api: 'storage' | 'database');
}

type Flarelink = {
    /** Auth surface — browser + server safe. */
    readonly auth: Auth;
    /** File storage (R2). Server-only — requires `serviceKey`. */
    readonly storage: Storage;
    /**
     * Build a query against a D1 table.
     * Server-only — requires `serviceKey`.
     */
    from<T extends Record<string, unknown> = Record<string, unknown>>(table: string): TableQuery<T>;
    /**
     * Raw SQL escape hatch. Tagged-template syntax interpolates values as
     * bind params:
     *   await flarelink.sql`SELECT * FROM users WHERE id = ${userId}`
     *
     * Server-only — requires `serviceKey`.
     */
    sql<T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult<T>>;
};
declare function createFlarelink(config: FlarelinkConfig): Flarelink;

export { type Auth, AuthError, type Database, DatabaseError, type DeleteBuilder, type Equality, type Flarelink, type FlarelinkConfig, FlarelinkError, type InsertBuilder, MissingServiceKeyError, type PresignOptions, type QueryBuilder, type QueryResult, type RequestPasswordResetInput, type ResetPasswordInput, type SendVerificationEmailInput, type Session, type SignInInput, type SignInWithMagicLinkOptions, type SignInWithSocialOptions, type SignUpInput, type SocialProvider, type Storage, type StorageBucket, type StorageBucketAPI, StorageError, type StorageListResponse, type StorageObject, type TableQuery, type UpdateBuilder, type User, createFlarelink };
