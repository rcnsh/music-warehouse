-- Migration 0014: play counts per local day, and per local month and track.
--
-- /api/daily reads one row per play in its range (15k for a year) and
-- /api/top-tracks and /api/top-artists count every play (about 30k rows of
-- their 40k for a year). These tables hold those counts, so a long range
-- reads one row per day, or per month and track, plus the plays in any
-- partial month at its ends.
--
-- They are kept by triggers, so every way a play is stored or removed (a
-- poll, an import of older plays, a manual DELETE) keeps them right. "Local"
-- is one timezone, rollup_state.time_zone; src/rollup.ts rebuilds for the
-- configured zone. rollup_offsets holds that zone's UTC offset from each of
-- its transitions on, to the second, so SQL can find a play's local day
-- exactly as Intl does. Requests in any other zone use the plays themselves.
CREATE TABLE rollup_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  time_zone  TEXT    NOT NULL,
  -- 0 for a zone whose local dates ever run backwards; the rollup is unused.
  usable     INTEGER NOT NULL,
  -- rollup_offsets is complete up to here. Plays after it may have the wrong
  -- day, so reads stop trusting the rollup once it has passed.
  horizon_ms INTEGER NOT NULL
);

CREATE TABLE rollup_offsets (
  from_ms   INTEGER PRIMARY KEY,
  offset_ms INTEGER NOT NULL
);

CREATE TABLE rollup_days (
  day   TEXT    PRIMARY KEY,
  plays INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE rollup_month_tracks (
  month    TEXT    NOT NULL,
  track_id TEXT    NOT NULL,
  plays    INTEGER NOT NULL,
  PRIMARY KEY (month, track_id)
) WITHOUT ROWID;

-- The local day of a play, in the triggers below and in src/rollup.ts.
-- (played_at_ms + offset) is positive, so integer division floors it.
CREATE TRIGGER plays_rollup_ai AFTER INSERT ON plays BEGIN
  INSERT INTO rollup_days (day, plays)
  VALUES (date((NEW.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= NEW.played_at_ms
                                     ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1)
  ON CONFLICT(day) DO UPDATE SET plays = plays + 1;
  INSERT INTO rollup_month_tracks (month, track_id, plays)
  VALUES (substr(date((NEW.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= NEW.played_at_ms
                                            ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7), NEW.track_id, 1)
  ON CONFLICT(month, track_id) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_rollup_ad AFTER DELETE ON plays BEGIN
  UPDATE rollup_days SET plays = plays - 1
   WHERE day = date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch');
  UPDATE rollup_month_tracks SET plays = plays - 1
   WHERE track_id = OLD.track_id
     AND month = substr(date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                                  ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7);
  DELETE FROM rollup_days WHERE plays <= 0
   AND day = date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch');
  DELETE FROM rollup_month_tracks WHERE plays <= 0 AND track_id = OLD.track_id
   AND month = substr(date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7);
END;

-- Nothing updates a play's key today; this keeps the counts right if
-- something ever does.
CREATE TRIGGER plays_rollup_au AFTER UPDATE OF played_at_ms, track_id ON plays BEGIN
  UPDATE rollup_days SET plays = plays - 1
   WHERE day = date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch');
  UPDATE rollup_month_tracks SET plays = plays - 1
   WHERE track_id = OLD.track_id
     AND month = substr(date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                                  ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7);
  DELETE FROM rollup_days WHERE plays <= 0
   AND day = date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch');
  DELETE FROM rollup_month_tracks WHERE plays <= 0 AND track_id = OLD.track_id
   AND month = substr(date((OLD.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= OLD.played_at_ms
                                         ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7);
  INSERT INTO rollup_days (day, plays)
  VALUES (date((NEW.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= NEW.played_at_ms
                                     ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1)
  ON CONFLICT(day) DO UPDATE SET plays = plays + 1;
  INSERT INTO rollup_month_tracks (month, track_id, plays)
  VALUES (substr(date((NEW.played_at_ms + (SELECT offset_ms FROM rollup_offsets WHERE from_ms <= NEW.played_at_ms
                                            ORDER BY from_ms DESC LIMIT 1)) / 1000, 'unixepoch'), 1, 7), NEW.track_id, 1)
  ON CONFLICT(month, track_id) DO UPDATE SET plays = plays + 1;
END;

-- Built in UTC, which has one offset forever. A deployment configured for
-- another zone is rebuilt by the daily cron, or at once by POST /admin/rollup.
INSERT INTO rollup_state (id, time_zone, usable, horizon_ms) VALUES (1, 'UTC', 1, 8640000000000000);
INSERT INTO rollup_offsets (from_ms, offset_ms) VALUES (-8640000000000000, 0);
INSERT INTO rollup_days (day, plays)
SELECT date(played_at_ms / 1000, 'unixepoch'), COUNT(*) FROM plays GROUP BY 1;
INSERT INTO rollup_month_tracks (month, track_id, plays)
SELECT substr(date(played_at_ms / 1000, 'unixepoch'), 1, 7), track_id, COUNT(*) FROM plays GROUP BY 1, 2;
