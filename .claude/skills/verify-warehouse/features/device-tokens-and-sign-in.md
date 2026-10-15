# Device tokens and sign-in

The owner gives each device its own token: minted with the admin token (`POST /admin/tokens`), listed with last use, and revoked at once. A device can also get a read token by signing in: the warehouse shows its own confirmation page naming the device and where the token goes, and only Allow continues to Spotify. Cancel ends the sign-in without a token. Only the warehouse side is in scope here; the Spotify leg is never driven.

## Sub-features

- `token-mint` returns `mw_` + 43 characters once, `201`, default `read`, 90 days.
- `token-read-scope` lets a read token reach `/api/*` and nothing else (`401` on `/admin/*`).
- `token-list` lists every token with `access`, `created_via`, `last_used_ms`, `active`, never the token.
- `token-revoke` stops a token on its next request; revoked tokens stay listed.
- `token-errors` rejects a bad `access` (`400`) and an unknown id (`404`).
- `signin-page` serves the confirmation page with the device name, Allow and Cancel, a per-sign-in cookie and a strict CSP.
- `signin-cancel` ends a page sign-in with "Sign-in cancelled", or redirects an app's `return_to` with `error=access_denied`.
- `signin-stale` refuses a replayed state or a missing browser cookie (`400`).
- `signin-return-to` refuses a `return_to` that is not loopback, a `CORS_ORIGINS` origin or a `SIGN_IN_SCHEMES` scheme (`localhost` included).
- `signin-allow-boundary` answers Allow with `303` to `https://accounts.spotify.com/authorize` (`show_dialog=true`, redirect `/auth/callback`), recorded and not followed.
- `signin-denied` turns Spotify's `error=access_denied` redirect back into `return_to?error=access_denied`.
- `signin-exchange-invalid` answers any bad `POST /auth/token` with `400 {"error":"invalid_grant"}`.

## How to get to it (user POV)

- Owner in a shell: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" … /admin/tokens` (README "Device tokens").
- A browser: open `/auth/login?name=laptop`, press Allow or Cancel.
- A desktop app, CLI or the MCP server: `/auth/login?name=…&return_to=http://127.0.0.1:<port>/…&code_challenge=…`, then `POST /auth/token`.
- Android app: the same with a `SIGN_IN_SCHEMES` scheme (not configured on this run).

## Driving it with api.sh

Preconditions:

- `doctor.sh` healthy. `S=.claude/skills/verify-warehouse/scripts`; `. "$VERIFY_RUN/run.env"` for `EVIDENCE_DIR` and `BASE_URL`.
- `mkdir -p "$EVIDENCE_DIR/tokens-signin"`; cookie jars go there.
- PKCE values for the app path: `V=verifyverifierverifierverifierverifierverifier01` and `C=$(printf %s "$V" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')` (gives `Lw4VPeSjbks9lHUxxcAIlka81oW-1xZ4h9jrLnaEChw`).

- **Mint.** Run `$S/api.sh admin tokens-signin/mint POST /admin/tokens -H 'Content-Type: application/json' -d '{"name":"Verify phone"}'`. `HTTP 201`; `token` matches `^mw_[A-Za-z0-9_-]{43}$`, `access` `read`, `expires_ms` about 90 days ahead, `note` says it cannot be shown again. Keep `T=$(jq -r .token "$EVIDENCE_DIR/tokens-signin/mint.body")` and `ID=$(jq -r .id …)`.
- **Scope.** `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE_URL/api/plays?limit=1"` gives `200`; the same on `$BASE_URL/admin/tokens` gives `401`.
- **List.** Run `$S/api.sh admin tokens-signin/list GET /admin/tokens`. Contains `Verify phone` (`created_via` `admin`, `active` true, `last_used_ms` set) and the launch's `verify-warehouse` token. No `token` or hash field.
- **Revoke.** Run `$S/api.sh admin tokens-signin/revoke DELETE "/admin/tokens?id=$ID"` (`200`, `revoked: true`). The scope curl now gives `401`, and a second list shows it with `revoked_ms` set and `active` false.
- **Token errors.** `$S/api.sh admin tokens-signin/bad-access POST /admin/tokens -H 'Content-Type: application/json' -d '{"name":"x","access":"owner"}'` is `400`; `$S/api.sh admin tokens-signin/revoke-missing DELETE '/admin/tokens?id=tok_nope'` is `404 No such token.`
- **Confirmation page.** Run `$S/api.sh none tokens-signin/page GET '/auth/login?name=Verify%20laptop' -c "$EVIDENCE_DIR/tokens-signin/jar-page.txt"`. `HTTP 200`, title `Allow sign-in?`, body names `Verify laptop`, "It will be shown on a page in this browser, once.", buttons `decision=allow` and `decision=cancel`. Headers: `Set-Cookie: mw_signin_<16 chars>=…; HttpOnly; SameSite=Lax`, CSP `form-action 'self' https://accounts.spotify.com`. Take `ST` from `name="state" value="…"`. `$S/db.sh tokens-signin/pending "SELECT device_name, confirmed_ms FROM login_state"` shows one row, `Verify laptop`, `confirmed_ms` null.
- **Cancel.** Run `$S/api.sh none tokens-signin/cancel POST /auth/login -b "$EVIDENCE_DIR/tokens-signin/jar-page.txt" --data-urlencode "state=$ST" --data-urlencode decision=cancel`. `HTTP 200`, title `Sign-in cancelled`, "No token was made". `db.sh tokens-signin/after-cancel "SELECT COUNT(*) AS n FROM login_state"` gives 0, and the token list has no new entry.
- **Stale.** Replay the same POST with `decision=allow` as `tokens-signin/replay`: `400`, title `Sign-in failed`. A fresh page's state posted without `-b` (`tokens-signin/no-cookie`) is also `400`.
- **return_to rules.** `/auth/login?name=x&return_to=https://evil.example/cb` and `…return_to=http://localhost:5555/cb&code_challenge=$C` both `400`, error naming CORS_ORIGINS, 127.0.0.1 and SIGN_IN_SCHEMES.
- **App Cancel.** Run `$S/api.sh none tokens-signin/app-page GET "/auth/login?name=Verify%20CLI&return_to=http%3A%2F%2F127.0.0.1%3A5599%2Fcb&code_challenge=$C" -c "$EVIDENCE_DIR/tokens-signin/jar-app.txt"`. The page shows `<code>http://127.0.0.1:5599/cb</code>`. Posting its state with `decision=cancel` (`tokens-signin/app-cancel`) gives `302` with `Location: http://127.0.0.1:5599/cb?error=access_denied`. Nothing listens on 5599; the Location header is the proof.
- **Allow, up to Spotify.** Start another app page (`tokens-signin/app-page-2`, same jar) and post `decision=allow` as `tokens-signin/app-allow`. `HTTP 303`; `Location` starts `https://accounts.spotify.com/authorize?client_id=verify-dummy-client-id&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A<PORT>%2Fauth%2Fcallback` and ends `&show_dialog=true`. Stop there.
- **Spotify said no.** Simulate Spotify's redirect back with the same state and jar: `$S/api.sh none tokens-signin/denied GET "/auth/callback?state=$ST&error=access_denied" -b "$EVIDENCE_DIR/tokens-signin/jar-app.txt"`. `302` to `http://127.0.0.1:5599/cb?error=access_denied`. No code means no exchange with Spotify.
- **Exchange refusal.** `$S/api.sh none tokens-signin/exchange-bad POST /auth/token -H 'Content-Type: application/json' -d "{\"code\":\"nope\",\"code_verifier\":\"$V\"}"` is `400 {"error":"invalid_grant"}`.
- **Proof.** The mint, list, revoke and post-revoke `401`; the page, the `login_state` rows before and after Cancel, the `Location` headers.

## Gotchas

- Never follow the Allow `303` (no `-L`, no browser): it is a real Spotify authorize URL, and the owner's Spotify quota is exhausted. A successful sign-in (code exchange, `/v1/me`) cannot be proved locally; report `signin-success` as out of scope.
- Calling `/auth/callback` with a `code` would make the Worker exchange it with Spotify. Only ever pass `error=…` there.
- The cookie is per sign-in (`mw_signin_` + the first 16 characters of the state); a jar from another page will not match. Over plain HTTP it has no `Secure` or `__Host-` prefix, unlike production.
- `wrangler dev` sets `CF-Connecting-IP` (the `login_state.client_hash` is not null), so the whole run is one client: `AUTH_RATE_LIMITER` allows 20 `/auth/*` requests a minute and at most 10 sign-ins may be pending. Past either, `/auth/*` answers `429`. The recipe above stays under both; when repeating it, cancel pages you open and pause a minute between passes.
- `POST /admin/tokens` bodies hold the raw token in evidence. It dies with the run, but leave it out of reports.
- `last_used_ms` updates at most hourly, so it will not change between two calls in one run.
