/**
 * Browser landing page for magic-link emails.
 *
 * Webmail (Gmail and others) will not make a `nomadvnc://` link clickable,
 * so the email button points here over https. This page then asks the
 * browser to open the app. The token is not consumed here; the app still
 * redeems it with `POST /api/v1/auth/consume`.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function isSignInToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** https URL placed in the email. `publicBase` has no trailing slash. */
export function signInOpenUrl(publicBase: string, token: string): string {
  const base = publicBase.replace(/\/+$/, "");
  return `${base}/auth/open?token=${encodeURIComponent(token)}`;
}

/** HTML for a valid token. `deepLink` is the `nomadvnc://` URL. */
export function renderSignInOpenPage(deepLink: string): string {
  const href = escapeAttr(deepLink);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to NomadVNC</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.4rem; }
  a.button { display: inline-block; padding: .65rem 1.2rem; border-radius: .6rem; background: #1f6feb; color: #fff; text-decoration: none; }
  p.muted { color: GrayText; font-size: .92rem; }
  p.link { font-size: .92rem; word-break: break-all; }
</style>
</head>
<body>
<h1>Sign in to NomadVNC</h1>
<p>Tap the button to finish signing in. iPhone and iPad open NomadVNC from that tap.</p>
<p><a class="button" href="${href}">Open NomadVNC</a></p>
<p class="muted">If the app still doesn't open, copy this link and paste it into the sign-in box in NomadVNC:</p>
<p class="link">${href}</p>
</body>
</html>`;
}

export function renderSignInOpenError(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign-in link not valid · NomadVNC</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.4rem; }
  p.muted { color: GrayText; font-size: .92rem; }
</style>
</head>
<body>
<h1>This sign-in link is not valid</h1>
<p class="muted">Request a new link from NomadVNC. Links expire after a few minutes and can only be used once.</p>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
