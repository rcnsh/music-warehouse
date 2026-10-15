-- Migration 0007: per-device API tokens.
--
-- One row per device or client, so losing one costs a revocation rather than
-- rotating a secret every other device shares. Only a SHA-256 of each token is
-- stored; the token itself is shown once, when minted. Tokens are 32 random
-- bytes, so a fast hash is enough: there is nothing to brute-force.
-- Revoked rows are kept, as a record of what existed and when it was cut off.
CREATE TABLE api_tokens (
  id           TEXT    PRIMARY KEY,           -- public handle, for listing and revoking
  token_hash   TEXT    NOT NULL UNIQUE,       -- hex SHA-256 of the full token
  name         TEXT    NOT NULL,              -- "iPhone Wrapped", "laptop curl"
  access       TEXT    NOT NULL CHECK (access IN ('admin', 'read')),
  created_ms   INTEGER NOT NULL,
  expires_ms   INTEGER,                       -- NULL = never
  last_used_ms INTEGER,
  revoked_ms   INTEGER,
  created_via  TEXT    NOT NULL               -- how it was minted, e.g. 'admin'
);
