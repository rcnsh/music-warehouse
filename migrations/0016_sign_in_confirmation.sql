-- Migration 0016: a sign-in is confirmed on a warehouse page, in the browser
-- that started it, and is capped per client.
--
-- `client_hash` is a keyed hash of the client's IP address (its /64 for IPv6),
-- never the address itself, so the pending sign-ins one client may hold can be
-- capped. `browser_hash` is the hash of a cookie set on the confirmation page:
-- Spotify's redirect back must arrive in that same browser. `confirmed_ms` is
-- set when the owner presses Allow; until then the sign-in cannot complete.
ALTER TABLE login_state ADD COLUMN client_hash TEXT;
ALTER TABLE login_state ADD COLUMN browser_hash TEXT;
ALTER TABLE login_state ADD COLUMN confirmed_ms INTEGER;

CREATE INDEX login_state_client ON login_state (client_hash);
