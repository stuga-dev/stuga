-- ============================================================================
-- OAuth grants: a connector's authorization belongs to its person and the
-- workspaces they chose, not to the workspace their browser had open, and its
-- tokens expire and refresh. Keys minted by hand are unchanged.
-- ============================================================================

-- Until now the token exchange minted an API key; those connector keys are retired.
UPDATE api_keys SET revoked_at = now(), revoked_by = 'system'
WHERE agent_id LIKE 'agent-conn-%' AND revoked_at IS NULL;

-- One person's authorization of one client. Revoked, never deleted: runs and
-- audit rows name its agent for as long as they are kept.
CREATE TABLE oauth_grants (
    grant_id        TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL,
    -- What runs are attributed to: the name the client registered, or one its person gave it.
    name            TEXT NOT NULL DEFAULT '',
    -- The host that served the client's metadata document; NULL = registered dynamically, so unverified.
    client_host     TEXT,
    owner           TEXT NOT NULL REFERENCES users(alias) ON DELETE CASCADE,
    -- The agent acts as agent:<agent_id>.
    agent_id        TEXT NOT NULL UNIQUE,
    -- The workspaces it may act in; NULL = every workspace its owner belongs to, now and later.
    workspace_scope TEXT[],
    access          TEXT NOT NULL DEFAULT 'propose' CHECK (access IN ('read', 'propose')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    revoked_by      TEXT
);
-- Signing in again from the same client renews its grant, so its agent keeps one identity.
CREATE UNIQUE INDEX oauth_grants_live_uniq ON oauth_grants (owner, client_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_owner_idx ON oauth_grants (owner, created_at DESC);

-- Only the sha-256 of a token is stored.
CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id   TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    -- One sign-in's chain of tokens; a spent refresh token presented again ends the chain.
    family_id  TEXT NOT NULL,
    -- When that sign-in happened: however often it refreshes, the chain ends a year on.
    family_started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    -- A refresh token is spent once exchanged.
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX oauth_tokens_expiry_idx ON oauth_tokens (expires_at);

-- A client is registered dynamically, or identified by the URL of its metadata document.
ALTER TABLE oauth_clients
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'dcr' CHECK (kind IN ('dcr', 'cimd')),
    ADD COLUMN metadata_fetched_at TIMESTAMPTZ;

-- A code now carries what the person consented to rather than the workspace they had open.
DELETE FROM oauth_codes;
ALTER TABLE oauth_codes
    DROP COLUMN workspace_id,
    -- NULL = every workspace, now and later.
    ADD COLUMN workspace_scope TEXT[],
    ADD COLUMN access TEXT NOT NULL CHECK (access IN ('read', 'propose'));
