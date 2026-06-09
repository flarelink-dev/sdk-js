// Auth surface. Ported verbatim from auth-module/client/flarelinkAuth.ts —
// every method sends `credentials: 'include'` so the browser carries the
// session cookie automatically. Caller's app origin must be in the
// deployment's trustedOrigins list (Authentication page in the dashboard),
// otherwise the Worker rejects with 403.

import { AuthError } from './errors.js';
import type {
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

export type Auth = {
  signUp(input: SignUpInput): Promise<{ user: User }>;
  signIn(input: SignInInput): Promise<{ user: User }>;
  signInWithSocial(
    provider: SocialProvider,
    opts?: SignInWithSocialOptions,
  ): Promise<{ url: string }>;
  signInWithMagicLink(
    email: string,
    opts?: SignInWithMagicLinkOptions,
  ): Promise<{ status: boolean }>;
  signOut(): Promise<void>;
  /**
   * Triggers a password-reset email. Always resolves with `{ status: true }`
   * even when the email is unknown — that's deliberate, BetterAuth doesn't
   * leak account existence on this endpoint.
   */
  requestPasswordReset(input: RequestPasswordResetInput): Promise<{ status: boolean }>;
  /**
   * Completes the reset using the token from the email link. Your reset
   * page reads `?token=` from the URL and passes it here alongside the
   * new password.
   */
  resetPassword(input: ResetPasswordInput): Promise<{ status: boolean }>;
  /**
   * Sends a verification email to the address. The link in the email lands
   * the user on `callbackURL` after the email is marked verified.
   */
  sendVerificationEmail(input: SendVerificationEmailInput): Promise<{ status: boolean }>;
  /** Current user, or null when not signed in. */
  getMe(): Promise<User | null>;
  /** Active session, or null when not signed in. */
  getSession(): Promise<Session | null>;
};

export function createAuth(base: string, f: typeof fetch): Auth {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    // BetterAuth is strict on two fronts: state-changing requests must declare
    // Content-Type: application/json (else 415), AND if Content-Type is JSON
    // the body has to actually parse as JSON (empty body throws). For POSTs
    // like sign-out that semantically have nothing to send, we default the
    // body to "{}" so both checks pass.
    const method = (init.method ?? 'GET').toUpperCase();
    const bodyBearing = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    let body = init.body;
    if (bodyBearing) {
      if (body === undefined || body === null) body = '{}';
      if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
    }
    const res = await f(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers,
      body,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        code?: string;
      };
      throw new AuthError(
        data.message ?? data.error ?? res.statusText,
        res.status,
        data.code,
      );
    }
    return (await res.json()) as T;
  }

  const fetchMe = async (): Promise<{ user: User; session: Session } | null> => {
    try {
      return await call<{ user: User; session: Session }>('/api/me');
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) return null;
      throw err;
    }
  };

  // Default a missing browser-side callbackURL to the current page so the
  // auto-send-on-signup verification email lands the user back where they
  // started. Without this, BetterAuth defaults to `/` which resolves against
  // the auth Worker's hostname → 404. Non-browser callers (SSR, tests) pass
  // explicit values or accept the Worker's first-trusted-origin fallback.
  const browserDefault = (): string | undefined =>
    typeof location !== 'undefined' ? location.href : undefined;

  return {
    signUp: (input) =>
      call<{ user: User }>('/api/auth/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({
          ...input,
          callbackURL: input.callbackURL ?? browserDefault(),
        }),
      }),
    signIn: (input) =>
      call<{ user: User }>('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    signInWithSocial: async (provider, opts = {}) => {
      const callbackURL = opts.callbackURL ?? browserDefault();
      const r = await call<{ url: string }>('/api/auth/sign-in/social', {
        method: 'POST',
        body: JSON.stringify({ provider, callbackURL }),
      });
      if (!opts.noRedirect && typeof location !== 'undefined') {
        location.href = r.url;
      }
      return r;
    },
    signInWithMagicLink: (email, opts = {}) => {
      const callbackURL = opts.callbackURL ?? browserDefault();
      return call<{ status: boolean }>('/api/auth/sign-in/magic-link', {
        method: 'POST',
        body: JSON.stringify({ email, callbackURL }),
      });
    },
    signOut: async () => {
      await call<{ success: true }>('/api/auth/sign-out', { method: 'POST' });
    },
    requestPasswordReset: (input) =>
      call<{ status: boolean }>('/api/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    resetPassword: (input) =>
      call<{ status: boolean }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    sendVerificationEmail: (input) =>
      call<{ status: boolean }>('/api/auth/send-verification-email', {
        method: 'POST',
        body: JSON.stringify({
          ...input,
          callbackURL: input.callbackURL ?? browserDefault(),
        }),
      }),
    getMe: async () => (await fetchMe())?.user ?? null,
    getSession: async () => (await fetchMe())?.session ?? null,
  };
}
