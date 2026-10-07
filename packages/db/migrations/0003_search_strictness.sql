-- The search box's cutoff by meaning is a level, Strict to Off, at distances the node measures for
-- the embedding model in force (embed_calibrations). Fixed distances are gone: one number does not
-- fit every model, and Ask and agents take the nearest passages, leaving relevance to the reranker.
ALTER TABLE node_ai_settings
    DROP COLUMN search_max_distance,
    DROP COLUMN retrieval_max_distance,
    -- NULL takes the default level.
    ADD COLUMN search_strictness TEXT CHECK (search_strictness IN ('strict', 'balanced', 'loose', 'off'));

-- One measurement per embedding configuration: the key hashes everything that changes distances.
-- The five most recent are kept, so going back to an earlier model needs no new measurement.
CREATE TABLE embed_calibrations (
    config_key      TEXT PRIMARY KEY CHECK (config_key ~ '^[0-9a-f]{64}$'),
    model           TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('running', 'ready', 'failed')),
    -- The last successful measurement: it stays in force while the same key is measured again.
    result          JSONB,
    error           TEXT,
    error_kind      TEXT CHECK (error_kind IN ('endpoint', 'inseparable')),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ,
    -- Whom the measurement's tokens are attributed to in ai_usage.
    triggered_by    TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    CONSTRAINT embed_calibrations_ready_check CHECK (state <> 'ready' OR result IS NOT NULL),
    CONSTRAINT embed_calibrations_failed_check CHECK ((state = 'failed') = (error IS NOT NULL AND error_kind IS NOT NULL))
);
