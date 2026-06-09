// Public types — what callers see in their IDE when they hover a method
// signature. Kept in one file so the rest of the package stays terse.

export type FlarelinkConfig = {
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

export type User = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SocialProvider = 'google' | 'github';

export type SignUpInput = {
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

export type SignInInput = { email: string; password: string };

export type SignInWithSocialOptions = {
  /** Where to send the user after the OAuth dance finishes. Default: current URL. */
  callbackURL?: string;
  /** If true, return the provider URL instead of navigating. Useful for SSR. */
  noRedirect?: boolean;
};

export type SignInWithMagicLinkOptions = {
  /** URL the user lands on after the magic-link sign-in succeeds. Default: current URL. */
  callbackURL?: string;
};

export type RequestPasswordResetInput = {
  email: string;
  /**
   * Page on your app the user lands on after clicking the link in the email.
   * BetterAuth appends `?token=...` to it; your page reads the token and
   * calls `resetPassword({ newPassword, token })`.
   */
  redirectTo: string;
};

export type ResetPasswordInput = { newPassword: string; token: string };

export type SendVerificationEmailInput = {
  email: string;
  /** URL the user lands on after the email is verified. Default: current URL. */
  callbackURL?: string;
};
