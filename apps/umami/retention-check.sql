BEGIN READ ONLY;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('umami-retention', 0)) THEN
    RAISE EXCEPTION 'retention advisory lock is already held';
  END IF;
END
$$;

WITH null_counts AS (
  SELECT 1 AS sort_order, 'event_data' AS table_name, count(*) AS null_count
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
  WHERE session.created_at IS NULL
)
SELECT format(
  'RETENTION|mode=check|table=%s|null_created_at=%s',
  table_name,
  null_count
)
FROM null_counts
ORDER BY sort_order;

DO $$
DECLARE
  null_total bigint;
BEGIN
  SELECT COALESCE(sum(null_count), 0)
  INTO null_total
  FROM (
    SELECT count(*) AS null_count FROM event_data WHERE event_data.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM website_event WHERE website_event.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM session_data WHERE session_data.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM revenue WHERE revenue.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM session_replay WHERE session_replay.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM session_replay_saved WHERE session_replay_saved.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM heatmap_event WHERE heatmap_event.created_at IS NULL
    UNION ALL
    SELECT count(*) FROM session WHERE session.created_at IS NULL
  ) AS null_counts;

  IF null_total <> 0 THEN
    RAISE EXCEPTION 'retention blocked: null created_at timestamps: % rows', null_total;
  END IF;
END
$$;

WITH retention_context AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '13 months' AS cutoff
)
SELECT format(
  'RETENTION|mode=check|cutoff=%s',
  to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
FROM retention_context;

WITH retention_context AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '13 months' AS cutoff
), table_counts AS (
  SELECT 1 AS sort_order, 'event_data' AS table_name, count(*) AS before_count, 0::bigint AS protected_count
  FROM event_data, retention_context
  WHERE event_data.created_at < retention_context.cutoff
  UNION ALL
  SELECT
    2,
    'website_event',
    count(*),
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM event_data
        WHERE event_data.website_event_id = website_event.event_id
          AND event_data.created_at >= retention_context.cutoff
      )
    )
  FROM website_event, retention_context
  WHERE website_event.created_at < retention_context.cutoff
  UNION ALL
  SELECT 3, 'session_data', count(*), 0::bigint
  FROM session_data, retention_context
  WHERE session_data.created_at < retention_context.cutoff
  UNION ALL
  SELECT 4, 'revenue', count(*), 0::bigint
  FROM revenue, retention_context
  WHERE revenue.created_at < retention_context.cutoff
  UNION ALL
  SELECT 5, 'session_replay', count(*), 0::bigint
  FROM session_replay, retention_context
  WHERE session_replay.created_at < retention_context.cutoff
  UNION ALL
  SELECT 6, 'session_replay_saved', count(*), 0::bigint
  FROM session_replay_saved, retention_context
  WHERE session_replay_saved.created_at < retention_context.cutoff
  UNION ALL
  SELECT 7, 'heatmap_event', count(*), 0::bigint
  FROM heatmap_event, retention_context
  WHERE heatmap_event.created_at < retention_context.cutoff
  UNION ALL
  SELECT
    8,
    'session',
    count(*),
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM website_event
        WHERE website_event.session_id = session.session_id
          AND (
            website_event.created_at >= retention_context.cutoff
            OR EXISTS (
              SELECT 1
              FROM event_data
              WHERE event_data.website_event_id = website_event.event_id
                AND event_data.created_at >= retention_context.cutoff
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM session_data
        WHERE session_data.session_id = session.session_id
          AND session_data.created_at >= retention_context.cutoff
      )
      OR EXISTS (
        SELECT 1
        FROM revenue
        WHERE revenue.session_id = session.session_id
          AND revenue.created_at >= retention_context.cutoff
      )
      OR EXISTS (
        SELECT 1
        FROM session_replay
        WHERE session_replay.session_id = session.session_id
          AND session_replay.created_at >= retention_context.cutoff
      )
      OR EXISTS (
        SELECT 1
        FROM heatmap_event
        WHERE heatmap_event.session_id = session.session_id
          AND heatmap_event.created_at >= retention_context.cutoff
      )
    )
  FROM session, retention_context
  WHERE session.created_at < retention_context.cutoff
)
SELECT format(
  'RETENTION|mode=check|table=%s|before=%s|deleted=0|protected=%s|remaining=%s',
  table_name,
  before_count,
  protected_count,
  before_count - protected_count
)
FROM table_counts
ORDER BY sort_order;

WITH orphan_counts AS (
  SELECT 1 AS sort_order, 'event_data' AS table_name, count(*) AS orphan_count
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
    AND session.session_id IS NULL
)
SELECT format(
  'RETENTION|mode=check|orphan_table=%s|before=%s|after=%s|delta=0',
  table_name,
  orphan_count,
  orphan_count
)
FROM orphan_counts
ORDER BY sort_order;

COMMIT;
