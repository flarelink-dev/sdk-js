# Security Policy

## Reporting a vulnerability

Email **hello@flarelink.dev** with `[SECURITY]` in the subject. Please include a description of the issue and its impact, steps to reproduce (or a proof of concept), and the affected version of `@flarelink/client`.

We'll acknowledge your report, keep you updated as we investigate, and credit you if you'd like. Please give us a reasonable window to ship a fix before public disclosure.

## Scope

This repo is the **`@flarelink/client` SDK** (MIT) — the typed client your app imports for auth, storage, and database access. The service key it uses on the server is the trust boundary; never ship it to the browser.

More on Flarelink's security model at <https://flarelink.dev/trust>.
