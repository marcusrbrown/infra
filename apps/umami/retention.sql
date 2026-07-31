BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('umami-retention', 0)) THEN
    RAISE EXCEPTION 'retention advisory lock is already held';
  END IF;
END
$$;

CREATE TEMP TABLE retention_context AS
SELECT CURRENT_TIMESTAMP - INTERVAL '13 months' AS cutoff;

CREATE TEMP TABLE retention_null_timestamps (
  sort_order integer PRIMARY KEY,
  table_name text NOT NULL,
  null_count bigint NOT NULL
);

INSERT INTO retention_null_timestamps (sort_order, table_name, null_count)
SELECT 1, 'event_data', count(*)
FROM event_data
WHERE event_data.created_at IS NULL
UNION ALL
SELECT 2, 'website_event', count(*)
FROM website_event
WHERE website_event.created_at IS NULL
UNION ALL
SELECT 3, 'session_data', count(*)
FROM session_data
WHERE session_data.created_at IS NULL
UNION ALL
SELECT 4, 'revenue', count(*)
FROM revenue
WHERE revenue.created_at IS NULL
UNION ALL
SELECT 5, 'session_replay', count(*)
FROM session_replay
WHERE session_replay.created_at IS NULL
UNION ALL
SELECT 6, 'session_replay_saved', count(*)
FROM session_replay_saved
WHERE session_replay_saved.created_at IS NULL
UNION ALL
SELECT 7, 'heatmap_event', count(*)
FROM heatmap_event
WHERE heatmap_event.created_at IS NULL
UNION ALL
SELECT 8, 'session', count(*)
FROM session
WHERE session.created_at IS NULL;

SELECT format(
  'RETENTION|mode=apply|table=%s|null_created_at=%s',
  table_name,
  null_count
)
FROM retention_null_timestamps
ORDER BY sort_order;

DO $$
DECLARE
  null_total bigint;
BEGIN
  SELECT COALESCE(sum(null_count), 0)
  INTO null_total
  FROM retention_null_timestamps;

  IF null_total <> 0 THEN
    RAISE EXCEPTION 'retention blocked: null created_at timestamps: % rows', null_total;
  END IF;
END
$$;

CREATE TEMP TABLE retention_expired_replay_keys (
  website_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  PRIMARY KEY (website_id, visit_id)
) ON COMMIT DROP;

INSERT INTO retention_expired_replay_keys (website_id, visit_id)
SELECT DISTINCT session_replay.website_id, session_replay.visit_id
FROM session_replay, retention_context
WHERE session_replay.created_at < retention_context.cutoff;

CREATE TEMP TABLE retention_counts (
  sort_order integer PRIMARY KEY,
  table_name text NOT NULL,
  before_count bigint NOT NULL,
  deleted_count bigint NOT NULL DEFAULT 0,
  protected_count bigint NOT NULL DEFAULT 0,
  remaining_count bigint
);

INSERT INTO retention_counts (sort_order, table_name, before_count)
SELECT 1, 'event_data', count(*)
FROM event_data, retention_context
WHERE event_data.created_at < retention_context.cutoff
UNION ALL
SELECT 2, 'website_event', count(*)
FROM website_event, retention_context
WHERE website_event.created_at < retention_context.cutoff
UNION ALL
SELECT 3, 'session_data', count(*)
FROM session_data, retention_context
WHERE session_data.created_at < retention_context.cutoff
UNION ALL
SELECT 4, 'revenue', count(*)
FROM revenue, retention_context
WHERE revenue.created_at < retention_context.cutoff
UNION ALL
SELECT 5, 'session_replay', count(*)
FROM session_replay, retention_context
WHERE session_replay.created_at < retention_context.cutoff
UNION ALL
SELECT 6, 'session_replay_saved', count(*)
FROM session_replay_saved, retention_context
WHERE session_replay_saved.created_at < retention_context.cutoff
  OR EXISTS (
    SELECT 1
    FROM retention_expired_replay_keys
    WHERE retention_expired_replay_keys.website_id = session_replay_saved.website_id
      AND retention_expired_replay_keys.visit_id = session_replay_saved.visit_id
  )
UNION ALL
SELECT 7, 'heatmap_event', count(*)
FROM heatmap_event, retention_context
WHERE heatmap_event.created_at < retention_context.cutoff
UNION ALL
SELECT 8, 'session', count(*)
FROM session, retention_context
WHERE session.created_at < retention_context.cutoff;

SELECT format(
  'RETENTION|mode=apply|cutoff=%s',
  to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
FROM retention_context;

CREATE TEMP TABLE retention_orphans (
  sort_order integer PRIMARY KEY,
  table_name text NOT NULL,
  before_count bigint NOT NULL,
  after_count bigint,
  delta bigint
);

INSERT INTO retention_orphans (sort_order, table_name, before_count)
SELECT 1, 'event_data', count(*)
FROM event_data
LEFT JOIN website_event ON website_event.event_id = event_data.website_event_id
WHERE event_data.website_event_id IS NOT NULL
  AND website_event.event_id IS NULL
UNION ALL
SELECT 2, 'website_event', count(*)
FROM website_event
LEFT JOIN session ON session.session_id = website_event.session_id
WHERE website_event.session_id IS NOT NULL
  AND session.session_id IS NULL
UNION ALL
SELECT 3, 'session_data', count(*)
FROM session_data
LEFT JOIN session ON session.session_id = session_data.session_id
WHERE session_data.session_id IS NOT NULL
  AND session.session_id IS NULL
UNION ALL
SELECT 4, 'revenue', count(*)
FROM revenue
LEFT JOIN session ON session.session_id = revenue.session_id
WHERE revenue.session_id IS NOT NULL
  AND session.session_id IS NULL
UNION ALL
SELECT 5, 'session_replay', count(*)
FROM session_replay
LEFT JOIN session ON session.session_id = session_replay.session_id
WHERE session_replay.session_id IS NOT NULL
  AND session.session_id IS NULL
UNION ALL
SELECT 6, 'heatmap_event', count(*)
FROM heatmap_event
LEFT JOIN session ON session.session_id = heatmap_event.session_id
WHERE heatmap_event.session_id IS NOT NULL
  AND session.session_id IS NULL;

WITH deleted AS (
  DELETE FROM event_data
  WHERE event_data.created_at < (SELECT cutoff FROM retention_context)
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'event_data';

WITH deleted AS (
  DELETE FROM website_event
  WHERE website_event.created_at < (SELECT cutoff FROM retention_context)
    AND NOT EXISTS (
      SELECT 1
      FROM event_data
      WHERE event_data.website_event_id = website_event.event_id
    )
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'website_event';

WITH deleted AS (
  DELETE FROM session_data
  WHERE session_data.created_at < (SELECT cutoff FROM retention_context)
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'session_data';

WITH deleted AS (
  DELETE FROM revenue
  WHERE revenue.created_at < (SELECT cutoff FROM retention_context)
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'revenue';

-- first saved-marker sweep
WITH deleted AS (
  DELETE FROM session_replay_saved
  WHERE session_replay_saved.created_at < (SELECT cutoff FROM retention_context)
    OR EXISTS (
      SELECT 1
      FROM retention_expired_replay_keys
      WHERE retention_expired_replay_keys.website_id = session_replay_saved.website_id
        AND retention_expired_replay_keys.visit_id = session_replay_saved.visit_id
    )
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'session_replay_saved';

WITH deleted AS (
  DELETE FROM session_replay
  WHERE session_replay.created_at < (SELECT cutoff FROM retention_context)
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'session_replay';

-- second saved-marker sweep
WITH deleted AS (
  DELETE FROM session_replay_saved
  WHERE session_replay_saved.created_at < (SELECT cutoff FROM retention_context)
    OR EXISTS (
      SELECT 1
      FROM retention_expired_replay_keys
      WHERE retention_expired_replay_keys.website_id = session_replay_saved.website_id
        AND retention_expired_replay_keys.visit_id = session_replay_saved.visit_id
    )
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = retention_counts.deleted_count + (SELECT count(*) FROM deleted)
WHERE table_name = 'session_replay_saved';

WITH deleted AS (
  DELETE FROM heatmap_event
  WHERE heatmap_event.created_at < (SELECT cutoff FROM retention_context)
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'heatmap_event';

WITH deleted AS (
  DELETE FROM session
  WHERE session.created_at < (SELECT cutoff FROM retention_context)
    AND NOT EXISTS (
      SELECT 1
      FROM website_event
      WHERE website_event.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM session_data
      WHERE session_data.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM revenue
      WHERE revenue.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM session_replay
      WHERE session_replay.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM heatmap_event
      WHERE heatmap_event.session_id = session.session_id
    )
  RETURNING 1
)
UPDATE retention_counts
SET deleted_count = (SELECT count(*) FROM deleted)
WHERE table_name = 'session';

UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM event_data
  WHERE event_data.created_at < (SELECT cutoff FROM retention_context)
)
WHERE table_name = 'event_data';

UPDATE retention_counts
SET protected_count = (
  SELECT count(*)
  FROM website_event
  WHERE website_event.created_at < (SELECT cutoff FROM retention_context)
    AND EXISTS (
      SELECT 1
      FROM event_data
      WHERE event_data.website_event_id = website_event.event_id
    )
),
remaining_count = (
  SELECT count(*)
  FROM website_event
  WHERE website_event.created_at < (SELECT cutoff FROM retention_context)
    AND NOT EXISTS (
      SELECT 1
      FROM event_data
      WHERE event_data.website_event_id = website_event.event_id
    )
)
WHERE table_name = 'website_event';

UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM session_data
  WHERE session_data.created_at < (SELECT cutoff FROM retention_context)
)
WHERE table_name = 'session_data';

UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM revenue
  WHERE revenue.created_at < (SELECT cutoff FROM retention_context)
)
WHERE table_name = 'revenue';

UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM session_replay
  WHERE session_replay.created_at < (SELECT cutoff FROM retention_context)
)
WHERE table_name = 'session_replay';

-- final saved-marker remaining count
UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM session_replay_saved
  WHERE session_replay_saved.created_at < (SELECT cutoff FROM retention_context)
    OR EXISTS (
      SELECT 1
      FROM retention_expired_replay_keys
      WHERE retention_expired_replay_keys.website_id = session_replay_saved.website_id
        AND retention_expired_replay_keys.visit_id = session_replay_saved.visit_id
    )
)
WHERE table_name = 'session_replay_saved';

UPDATE retention_counts
SET remaining_count = (
  SELECT count(*)
  FROM heatmap_event
  WHERE heatmap_event.created_at < (SELECT cutoff FROM retention_context)
)
WHERE table_name = 'heatmap_event';

UPDATE retention_counts
SET protected_count = (
  SELECT count(*)
  FROM session
  WHERE session.created_at < (SELECT cutoff FROM retention_context)
    AND (
      EXISTS (
        SELECT 1
        FROM website_event
        WHERE website_event.session_id = session.session_id
      )
      OR EXISTS (
        SELECT 1
        FROM session_data
        WHERE session_data.session_id = session.session_id
      )
      OR EXISTS (
        SELECT 1
        FROM revenue
        WHERE revenue.session_id = session.session_id
      )
      OR EXISTS (
        SELECT 1
        FROM session_replay
        WHERE session_replay.session_id = session.session_id
      )
      OR EXISTS (
        SELECT 1
        FROM heatmap_event
        WHERE heatmap_event.session_id = session.session_id
      )
    )
),
remaining_count = (
  SELECT count(*)
  FROM session
  WHERE session.created_at < (SELECT cutoff FROM retention_context)
    AND NOT EXISTS (
      SELECT 1
      FROM website_event
      WHERE website_event.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM session_data
      WHERE session_data.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM revenue
      WHERE revenue.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM session_replay
      WHERE session_replay.session_id = session.session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM heatmap_event
      WHERE heatmap_event.session_id = session.session_id
    )
)
WHERE table_name = 'session';

WITH after_counts AS (
  SELECT 1 AS sort_order, count(*) AS after_count
  FROM event_data
  LEFT JOIN website_event ON website_event.event_id = event_data.website_event_id
  WHERE event_data.website_event_id IS NOT NULL
    AND website_event.event_id IS NULL
  UNION ALL
  SELECT 2, count(*)
  FROM website_event
  LEFT JOIN session ON session.session_id = website_event.session_id
  WHERE website_event.session_id IS NOT NULL
    AND session.session_id IS NULL
  UNION ALL
  SELECT 3, count(*)
  FROM session_data
  LEFT JOIN session ON session.session_id = session_data.session_id
  WHERE session_data.session_id IS NOT NULL
    AND session.session_id IS NULL
  UNION ALL
  SELECT 4, count(*)
  FROM revenue
  LEFT JOIN session ON session.session_id = revenue.session_id
  WHERE revenue.session_id IS NOT NULL
    AND session.session_id IS NULL
  UNION ALL
  SELECT 5, count(*)
  FROM session_replay
  LEFT JOIN session ON session.session_id = session_replay.session_id
  WHERE session_replay.session_id IS NOT NULL
    AND session.session_id IS NULL
  UNION ALL
  SELECT 6, count(*)
  FROM heatmap_event
  LEFT JOIN session ON session.session_id = heatmap_event.session_id
  WHERE heatmap_event.session_id IS NOT NULL
    AND session.session_id IS NULL
)
UPDATE retention_orphans AS orphan
SET after_count = after_counts.after_count,
    delta = after_counts.after_count - orphan.before_count
FROM after_counts
WHERE orphan.sort_order = after_counts.sort_order;

SELECT format(
  'RETENTION|mode=apply|orphan_table=%s|before=%s|after=%s|delta=%s',
  table_name,
  before_count,
  after_count,
  delta
)
FROM retention_orphans
ORDER BY sort_order;

SELECT format(
  'RETENTION|mode=apply|table=%s|before=%s|deleted=%s|protected=%s|remaining=%s',
  table_name,
  before_count,
  deleted_count,
  protected_count,
  remaining_count
)
FROM retention_counts
ORDER BY sort_order;

DO $$
DECLARE
  remaining_total bigint;
BEGIN
  SELECT COALESCE(sum(remaining_count), 0)
  INTO remaining_total
  FROM retention_counts;

  IF remaining_total <> 0 OR EXISTS (
    SELECT 1
    FROM retention_counts
    WHERE remaining_count <> 0
  ) THEN
    RAISE EXCEPTION 'retention incomplete: expired rows remain: % rows', remaining_total;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM retention_orphans
    WHERE after_count > before_count
  ) THEN
    RAISE EXCEPTION 'retention orphan delta increased';
  END IF;
END
$$;

COMMIT;
