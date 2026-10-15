-- Migration 0008: sign in with Spotify, to mint device tokens.
--
-- The warehouse belongs to whichever Spotify account authorized ingestion.
-- Its user id is recorded then, and a sign-in mints a token only for a
-- Spotify account with that same id.
ALTER TABLE oauth_token ADD COLUMN spotify_user_id TEXT;

-- Sign-ins between /auth/login and Spotify's redirect to /auth/callback. Keyed
-- by state, unlike the oauth_state singleton, so two devices can sign in at
-- once. `return_to` and `code_challenge` are NULL when the token is shown on a
-- page instead of handed to an app.
CREATE TABLE login_state (
  state          TEXT    PRIMARY KEY,
  created_ms     INTEGER NOT NULL,
  device_name    TEXT    NOT NULL,
  return_to      TEXT,
  code_challenge TEXT
);

-- One-time codes /auth/callback hands back to an app, exchanged at
-- /auth/token for a device token. Stored hashed, like the tokens themselves.
-- `origin` is the only origin allowed to exchange it; `code_challenge` binds
-- it to the PKCE verifier only the app that started the sign-in holds.
CREATE TABLE login_codes (
  code_hash      TEXT    PRIMARY KEY,
  created_ms     INTEGER NOT NULL,
  device_name    TEXT    NOT NULL,
  origin         TEXT    NOT NULL,
  code_challenge TEXT    NOT NULL
);
