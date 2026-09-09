-- Migration 0002: alert de-duplication.
-- One row per alert condition, holding when it was last sent. The row is
-- deleted once the condition clears, so a recurrence alerts immediately
-- rather than waiting out the resend window.

CREATE TABLE alerts (
  key          TEXT    PRIMARY KEY,
  last_sent_ms INTEGER NOT NULL
);
