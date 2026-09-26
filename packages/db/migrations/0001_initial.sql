-- The Stuga node's Postgres schema.
--
-- @EMBEDDING_DIMS@ is substituted by the runner with the configured embedding
-- width, validated as an integer first: a type modifier cannot be a bind
-- parameter. The width is fixed at creation; the node reads it back at boot and
-- refuses to start when the configuration disagrees.

-- btree_gin lets a scalar workspace_id prefix a GIN index, so the ACL
-- intersection stays index-selective within a tenant. pg_search needs vector.
CREATE EXTENSION vector;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION btree_gin;
CREATE EXTENSION pg_search;

-- ============================================================================
-- Tenancy. A workspace is a hard isolation unit: the "everyone" principal is
-- org:<workspaceId>, and every ACL-filtered query also ANDs workspace_id, so a
-- mis-scoped grant still cannot cross tenants. Deleting a workspace cascades to
-- every tenant table; only its documents need deleting first, for their blobs.
-- ============================================================================
CREATE TABLE workspaces (
    workspace_id              TEXT PRIMARY KEY,
    name                      TEXT NOT NULL,
    -- Visibility floor for NEW docs: 'workspace_edit' | 'workspace_view' | 'private'.
    default_doc_access        TEXT NOT NULL DEFAULT 'workspace_edit',
    -- Armed when the corpus needs vectors it lacks; cleared once every document has them.
    embedding_backfill_at     TIMESTAMPTZ,
    -- Last doc_id enqueued by that pass: documents leave the "needs vectors" set
    -- only after their job runs, so the pass must move forward on its own cursor.
    embedding_backfill_cursor TEXT,
    agent_instructions        TEXT NOT NULL DEFAULT '',
    -- Set while an archive is being imported into the workspace, which is then listed
    -- nowhere, and cleared once the import is done; a node stopped partway deletes
    -- it when it starts again rather than leave it half-built.
    import_started_at         TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_embedding_backfill_idx
    ON workspaces (embedding_backfill_at) WHERE embedding_backfill_at IS NOT NULL;

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    alias        TEXT NOT NULL,
    -- A guest never holds org:<wid>; it sees only what is shared with it directly.
    role         TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, alias)
);
CREATE INDEX workspace_members_alias_idx ON workspace_members (alias, joined_at);
CREATE INDEX workspace_members_ws_role_idx ON workspace_members (workspace_id, role);

-- ============================================================================
-- Folders and documents.
--
-- `owner` is a full principal ('user:<alias>' or 'agent:<id>'). The acl_* arrays
-- are the materialized EFFECTIVE sets: flatten(own_grants ∪ the parent folder's
-- effective sets, when inherits_perms). own_grants holds the grants set directly
-- on the resource, {"p":[readers],"w":[writers],"c":[commenters]}, un-expanded.
-- ============================================================================
CREATE TABLE folders (
    folder_id       TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    parent_id       TEXT REFERENCES folders(folder_id) ON DELETE SET NULL,
    owner           TEXT NOT NULL CHECK (owner ~ '^(user|agent):.'),
    title           TEXT NOT NULL,
    acl_principals  TEXT[] NOT NULL DEFAULT '{}',
    acl_writers     TEXT[] NOT NULL DEFAULT '{}',
    inherits_perms  BOOLEAN NOT NULL DEFAULT TRUE,
    own_grants      JSONB NOT NULL DEFAULT '{"p":[],"w":[],"c":[]}',
    -- Instructions for agents working on anything beneath this folder; '' when none.
    -- Stacked under the workspace's and every ancestor folder's, never instead of them.
    agent_instructions TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX folders_acl_gin     ON folders USING GIN (acl_principals);
CREATE INDEX folders_writers_gin ON folders USING GIN (acl_writers);
CREATE INDEX folders_parent_idx  ON folders (parent_id);
CREATE INDEX folders_ws_acl_gin  ON folders USING GIN (workspace_id, acl_principals);

CREATE TABLE docs (
    doc_id          TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    owner           TEXT NOT NULL CHECK (owner ~ '^(user|agent):.'),
    title           TEXT NOT NULL DEFAULT '',
    -- 'heading': derived from the first heading on each flush; 'user': set by a
    -- rename, which indexing must not overwrite.
    title_source    TEXT NOT NULL DEFAULT 'heading',
    doc_type        TEXT NOT NULL DEFAULT 'prose',
    parent_id       TEXT REFERENCES folders(folder_id) ON DELETE SET NULL,
    -- The principal that created the row. Provenance only: an agent creates
    -- documents its human owns.
    created_by      TEXT,
    -- The latest indexed snapshot; its blob key is derived from (doc_id, seq).
    snapshot_seq    BIGINT NOT NULL DEFAULT 0,
    -- trashed_at is NULL whenever trashed is FALSE.
    trashed         BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- acl_principals may see; acl_writers may edit; acl_commenters holds only the
    -- comment-only grants (a writer can always comment).
    acl_principals  TEXT[] NOT NULL DEFAULT '{}',
    acl_writers     TEXT[] NOT NULL DEFAULT '{}',
    acl_commenters  TEXT[] NOT NULL DEFAULT '{}',
    inherits_perms  BOOLEAN NOT NULL DEFAULT TRUE,
    own_grants      JSONB NOT NULL DEFAULT '{"p":[],"w":[],"c":[]}',
    locked          BOOLEAN NOT NULL DEFAULT FALSE,
    locked_by       TEXT,
    locked_at       TIMESTAMPTZ,
    -- Excluded from every search and retrieval surface; its chunks are deleted.
    search_hidden   BOOLEAN NOT NULL DEFAULT FALSE,
    -- Plain text of the body; the BM25 indexes read it.
    search_text     TEXT NOT NULL DEFAULT '',
    -- sha-256 of the last embedded text, so an unchanged flush skips the model call.
    embedding_hash  TEXT,
    -- Oldest snapshot seq still in the version ring. Only ever rises, so a
    -- retried job cannot reopen a pruned version. NULL = no ring published.
    version_floor   BIGINT,
    -- 'review' (agent changes wait for a person) or 'auto' (apply at once).
    agent_mode      TEXT NOT NULL DEFAULT 'review' CHECK (agent_mode IN ('review', 'auto')),
    -- Instructions for agents working on this document (for a database, on it and
    -- its row pages), stacked under its folders' and the workspace's; '' when none.
    agent_instructions TEXT NOT NULL DEFAULT '',
    -- The database this document is a row page of, and `<table_id>.<row_id>`.
    -- page_row means something only beside a non-null page_of: SET NULL clears
    -- one column, so a released page keeps a stale row reference.
    page_of         TEXT REFERENCES docs(doc_id) ON DELETE SET NULL,
    page_row        TEXT
);
CREATE INDEX docs_acl_gin        ON docs USING GIN (acl_principals);
CREATE INDEX docs_writers_gin    ON docs USING GIN (acl_writers);
CREATE INDEX docs_commenters_gin ON docs USING GIN (acl_commenters);
CREATE INDEX docs_title_trgm     ON docs USING GIN (title gin_trgm_ops);
CREATE INDEX docs_parent_idx     ON docs (parent_id);
CREATE INDEX docs_owner_idx      ON docs (owner);
CREATE INDEX docs_ws_acl_gin     ON docs USING GIN (workspace_id, acl_principals);
CREATE INDEX docs_ws_writers_gin ON docs USING GIN (workspace_id, acl_writers);
CREATE INDEX docs_trashed_idx    ON docs (trashed_at) WHERE trashed = TRUE;
CREATE INDEX docs_page_of_idx    ON docs (workspace_id, page_of) WHERE page_of IS NOT NULL;

-- Per-chunk index rows, replaced wholesale on each real index of a document.
CREATE TABLE doc_chunks (
    doc_id         TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    workspace_id   TEXT NOT NULL,
    chunk_index    INTEGER NOT NULL,
    content        TEXT NOT NULL,
    -- "Overview > Geophysics"; NULL for a preamble or headingless text.
    heading_path   TEXT,
    -- The document title, on chunk 0 only, kept equal to docs.title by indexDoc
    -- and rename (both holding the docs row lock).
    doc_title      TEXT,
    embedding      vector(@EMBEDDING_DIMS@),
    -- sha-256 of the exact embed input, so an unchanged chunk reuses its vector.
    embed_hash     TEXT,
    -- Failed embed attempts; the reconcile sweep gives up on a chunk past its cap.
    embed_attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, chunk_index)
);
CREATE INDEX doc_chunks_doc_idx  ON doc_chunks (doc_id);
CREATE INDEX doc_chunks_ws_idx   ON doc_chunks (workspace_id);
CREATE INDEX doc_chunks_vec_hnsw ON doc_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE TABLE versions (
    doc_id        TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    seq           BIGINT NOT NULL,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    authors       TEXT[] NOT NULL DEFAULT '{}',
    blob_key      TEXT NOT NULL,
    -- NULL when the previous snapshot could not be read: no number beats a wrong one.
    chars         INTEGER,
    chars_added   INTEGER,
    chars_removed INTEGER,
    PRIMARY KEY (doc_id, seq)
);

-- A root comment has parent_num NULL and carries the anchor (Yjs relative
-- positions plus the quoted text); a reply points at its root and has none.
-- mentions: the [{alias, username}] its @usernames resolved to when it was saved.
CREATE TABLE comments (
    doc_id       TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    num          BIGINT NOT NULL,
    parent_num   BIGINT,
    author       TEXT NOT NULL,
    body         TEXT NOT NULL,
    anchor_start TEXT,
    anchor_end   TEXT,
    anchor_quote TEXT,
    resolved     BOOLEAN NOT NULL DEFAULT FALSE,
    reactions    JSONB NOT NULL DEFAULT '{}',
    mentions     JSONB NOT NULL DEFAULT '[]',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, num),
    FOREIGN KEY (doc_id, parent_num) REFERENCES comments(doc_id, num) ON DELETE CASCADE
);
CREATE INDEX comments_parent_idx ON comments (doc_id, parent_num);

-- The people a document's body mentions as of its last indexed snapshot, so
-- only someone newly mentioned is notified. No FK on alias: a mention of a
-- person who later leaves the directory is still text in the document.
CREATE TABLE doc_mentions (
    doc_id     TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    alias      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, alias)
);

-- Groups are workspace-scoped: group:eng in two tenants is two rows.
CREATE TABLE groups (
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    group_id     TEXT NOT NULL,
    members      TEXT[] NOT NULL DEFAULT '{}',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, group_id)
);
CREATE INDEX groups_members_gin ON groups USING GIN (members);

CREATE TABLE favorites (
    user_alias TEXT NOT NULL,
    doc_id     TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_alias, doc_id)
);

-- workspace_id is NULL for a notification about the node itself, which only its administrators read.
CREATE TABLE notifications (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    recipient_alias TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    resource_id     TEXT,
    resource_title  TEXT,
    resource_url    TEXT,
    actor_alias     TEXT,
    payload         JSONB NOT NULL DEFAULT '{}',
    read            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_alias, created_at DESC);
CREATE INDEX notifications_recipient_unread_idx ON notifications (recipient_alias) WHERE read = FALSE;
CREATE INDEX notifications_workspace_idx ON notifications (workspace_id);

-- Durable background jobs; buried (dead_at set) once retries are exhausted.
CREATE TABLE jobs (
    id            BIGSERIAL PRIMARY KEY,
    body          JSONB NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    dead_at       TIMESTAMPTZ,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (available_at, id) WHERE dead_at IS NULL;

-- ============================================================================
-- People and accounts. An alias is a principal id without the "user:" prefix.
-- ============================================================================
-- One row per account: the account exists iff its row does. username is the
-- handle every account signs in and is @mentioned with; email is optional,
-- unverified contact detail, so nothing resolves a person by it unless it is the only match.
CREATE TABLE users (
    alias        TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
    display_name TEXT NOT NULL DEFAULT '',
    email        TEXT,
    -- The identity provider's subject for this account, when linked. One provider per node, so no issuer column.
    oidc_sub     TEXT UNIQUE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The local password, when the account has one. An account made through the
-- identity provider has none until its owner sets one.
CREATE TABLE local_accounts (
    alias         TEXT PRIMARY KEY REFERENCES users(alias) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- granted_by IS NULL marks the bootstrap grant. No FK on it: a granter's
-- deletion must neither cascade the grant away nor make it look like a bootstrap.
CREATE TABLE node_admins (
    alias      TEXT PRIMARY KEY REFERENCES users(alias) ON DELETE CASCADE,
    granted_by TEXT,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    alias      TEXT NOT NULL REFERENCES users(alias) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_alias_idx  ON password_resets (alias);
CREATE INDEX password_resets_expiry_idx ON password_resets (expires_at);

CREATE TABLE refresh_sessions (
    id          TEXT PRIMARY KEY,
    alias       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    -- The successor's token_hash, set only by rotation: it tells a rotated session
    -- from a revoked one, so a duplicate rotation inside the grace window is forgiven.
    replaced_by TEXT
);
CREATE INDEX refresh_sessions_alias_idx  ON refresh_sessions (alias);
CREATE INDEX refresh_sessions_expiry_idx ON refresh_sessions (expires_at);

-- A sign-in through the identity provider, from /auth/oidc/start until its callback.
-- binding_hash is the sha-256 of the cookie start set, so only the browser that
-- began a sign-in can finish it.
CREATE TABLE oidc_flows (
    state         TEXT PRIMARY KEY,
    binding_hash  TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    -- Repeated exactly in the token request.
    redirect_uri  TEXT NOT NULL,
    -- 'none' for a silent sign-in, 'select_account' to ask which account after a sign-out.
    prompt        TEXT CHECK (prompt IN ('none', 'select_account')),
    -- Set when a signed-in person links the provider to their account.
    link_alias    TEXT REFERENCES users(alias) ON DELETE CASCADE,
    return_to     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oidc_flows_expiry_idx ON oidc_flows (expires_at);

-- What a callback hands the SPA: a one-time session handoff, or a first-visit
-- ticket for a subject no account is linked to yet. Only a sha-256 of each is stored.
CREATE TABLE oidc_tickets (
    ticket_hash        TEXT PRIMARY KEY,
    kind               TEXT NOT NULL CHECK (kind IN ('session', 'first_visit')),
    binding_hash       TEXT NOT NULL,
    alias              TEXT REFERENCES users(alias) ON DELETE CASCADE,
    sub                TEXT,
    -- The issuer that vouched for sub: the subject is linked only while it is still the node's.
    issuer             TEXT,
    preferred_username TEXT,
    name               TEXT,
    email              TEXT,
    return_to          TEXT NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'session' AND alias IS NOT NULL AND sub IS NULL AND issuer IS NULL)
        OR (kind = 'first_visit' AND alias IS NULL AND sub IS NOT NULL AND issuer IS NOT NULL))
);
CREATE INDEX oidc_tickets_expiry_idx ON oidc_tickets (expires_at);

-- Each person's bookmarks to other Stuga nodes, for the workspace switcher.
-- Nothing here is verified or shared: opening one is a plain navigation to its origin.
CREATE TABLE user_nodes (
    id         TEXT PRIMARY KEY,
    alias      TEXT NOT NULL REFERENCES users(alias) ON DELETE CASCADE,
    label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    -- Scheme, host and port only: the switcher navigates to it, so nothing else may get in.
    origin     TEXT NOT NULL CHECK (origin ~ '^https?://[^/\s]+$'),
    position   INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (alias, origin)
);
CREATE INDEX user_nodes_alias_idx ON user_nodes (alias, position);

-- ============================================================================
-- Collections and ask threads: owner-private, gated by (workspace_id, owner).
-- ============================================================================

-- A retrieval scope layered on top of the ACL gate; it can only narrow.
CREATE TABLE collections (
    collection_id TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    owner         TEXT NOT NULL,
    name          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collections_owner_idx ON collections (owner);
CREATE INDEX collections_ws_owner_idx ON collections (workspace_id, owner);

-- A folder member is expanded at query time, so the collection tracks its contents.
CREATE TABLE collection_items (
    collection_id TEXT NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
    doc_id        TEXT REFERENCES docs(doc_id)       ON DELETE CASCADE,
    folder_id     TEXT REFERENCES folders(folder_id) ON DELETE CASCADE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((doc_id IS NOT NULL) <> (folder_id IS NOT NULL))
);
CREATE UNIQUE INDEX collection_items_doc_uniq
    ON collection_items (collection_id, doc_id)    WHERE doc_id    IS NOT NULL;
CREATE UNIQUE INDEX collection_items_folder_uniq
    ON collection_items (collection_id, folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX collection_items_collection_idx ON collection_items (collection_id);

-- Never shareable: an answer quotes passages the reader may not be allowed to see.
CREATE TABLE ask_threads (
    thread_id     TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    owner         TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    -- SET NULL: deleting a collection must not delete the research done in it.
    collection_id TEXT REFERENCES collections(collection_id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ask_threads_ws_owner_idx ON ask_threads (workspace_id, owner, updated_at DESC);

-- The answer is the model's Markdown with its citations, so a reopened thread
-- re-renders through the live renderer.
CREATE TABLE ask_turns (
    thread_id     TEXT NOT NULL REFERENCES ask_threads(thread_id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    question      TEXT NOT NULL,
    answer        TEXT NOT NULL DEFAULT '',
    citations     JSONB NOT NULL DEFAULT '[]',
    steps         JSONB NOT NULL DEFAULT '[]',
    model         TEXT NOT NULL DEFAULT '',
    rounds        INTEGER NOT NULL DEFAULT 0,
    stop_reason   TEXT NOT NULL DEFAULT 'complete',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, seq)
);

-- ============================================================================
-- Agents: API keys, OAuth, AI usage.
-- ============================================================================

-- An agent acts as agent:<agent_id> plus its owner's live principals in the
-- key's workspace. Only the sha-256 of the secret is stored.
CREATE TABLE api_keys (
    key_id        TEXT PRIMARY KEY,
    secret_hash   TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    owner         TEXT NOT NULL,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    revoked_by    TEXT,
    -- Narrowings below the owner's reach. scope_folders NULL = the whole reach.
    scope_folders TEXT[],
    access        TEXT NOT NULL DEFAULT 'propose' CHECK (access IN ('read', 'propose')),
    expires_at    TIMESTAMPTZ,
    rotated_at    TIMESTAMPTZ
);
CREATE INDEX api_keys_owner_idx ON api_keys (owner);
CREATE UNIQUE INDEX api_keys_agent_uniq ON api_keys (agent_id);
CREATE INDEX api_keys_ws_idx ON api_keys (workspace_id);

-- A client is registered dynamically, or identified by the URL of its metadata
-- document. last_used_at NULL = never used past registration.
CREATE TABLE oauth_clients (
    client_id           TEXT PRIMARY KEY,
    client_secret_hash  TEXT,
    redirect_uris       TEXT[] NOT NULL DEFAULT '{}',
    client_name         TEXT NOT NULL DEFAULT '',
    kind                TEXT NOT NULL DEFAULT 'dcr' CHECK (kind IN ('dcr', 'cimd')),
    metadata_fetched_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ
);
CREATE INDEX oauth_clients_last_used_idx ON oauth_clients (last_used_at);

-- A code carries what the person consented to, not the workspace they had open.
CREATE TABLE oauth_codes (
    code_hash       TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL,
    user_alias      TEXT NOT NULL,
    -- NULL = every workspace, now and later.
    workspace_scope TEXT[],
    access          TEXT NOT NULL CHECK (access IN ('read', 'propose')),
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX oauth_codes_expiry_idx ON oauth_codes (expires_at);

-- One person's authorization of one client: it belongs to its person and the
-- workspaces they chose, and its tokens expire and refresh. Revoked, never
-- deleted: runs and audit rows name its agent for as long as they are kept.
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

-- One row per model call. A ledger: it outlives the workspace it names.
CREATE TABLE ai_usage (
    id                 BIGSERIAL PRIMARY KEY,
    alias              TEXT NOT NULL,
    workspace_id       TEXT,
    doc_id             TEXT,
    kind               TEXT NOT NULL,
    model              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'ok',
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_alias_idx ON ai_usage (alias, created_at DESC);
CREATE INDEX ai_usage_ws_month_idx ON ai_usage (workspace_id, created_at);

-- ============================================================================
-- Node singletons: `id` is a boolean key CHECKed to TRUE, so there is one row.
-- NULL means "not set here". No secret lives in these tables — keys, webhook
-- and SMTP URLs are files under the data directory — so a dump carries none.
-- ============================================================================
CREATE TABLE node_ai_settings (
    id                     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- Each half runs once configured: chat when a provider offers a model, semantic
    -- search when an embedding model is set. FALSE switches that half off, keeping it.
    chat_enabled           BOOLEAN,
    embed_enabled          BOOLEAN,
    chat_default_model     TEXT,
    -- [{id, provider, baseUrl, models, apiKeyFp}]; apiKeyFp is a fingerprint.
    chat_endpoints         JSONB NOT NULL DEFAULT '[]',
    embed_provider         TEXT CHECK (embed_provider IN ('anthropic', 'openai', 'ollama')),
    embed_base_url         TEXT,
    embed_model            TEXT,
    embed_api_key_fp       TEXT,
    -- Maximum cosine distance for the semantic leg of search and of retrieval; NULL takes the default.
    search_max_distance    DOUBLE PRECISION CHECK (search_max_distance > 0 AND search_max_distance <= 2),
    retrieval_max_distance DOUBLE PRECISION CHECK (retrieval_max_distance > 0 AND retrieval_max_distance <= 2),
    updated_by             TEXT,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which build last booted against this database, and the node's id.
CREATE TABLE node_state (
    id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- Random, chosen by the first boot and never changed, a rename included: for whatever needs a stable name.
    node_id        TEXT        NOT NULL CHECK (node_id ~ '^[a-z2-7]{16}$'),
    app_version    TEXT        NOT NULL,
    first_boot_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_boot_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The last look for a newer version: when, the releases it listed (kept through a failed look,
    -- NULL until one succeeds), and why it failed (NULL when it did not).
    update_checked_at  TIMESTAMPTZ,
    update_feed        JSONB,
    update_check_error TEXT,
    -- The last scheduled backup: when it was tried, and why it failed (NULL when it did not).
    backup_attempted_at TIMESTAMPTZ,
    backup_error        TEXT
);

CREATE TABLE node_settings (
    id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- The node's name in the app and to agents; NULL shows PUBLIC_ORIGIN's host.
    node_name                 TEXT CHECK (node_name IS NULL OR (btrim(node_name) <> '' AND length(node_name) <= 80)),
    max_upload_bytes          BIGINT,
    audit_retention_days      INTEGER,
    -- Retention counts and days below: 0 keeps every row.
    database_ops_keep         INTEGER,
    ai_usage_retention_days   INTEGER,
    ask_thread_retention_days INTEGER,
    notify_sink               TEXT CHECK (notify_sink IN ('slack', 'teams', 'discord', 'email', 'webhook', 'none')),
    -- Redacted labels, never the values themselves.
    notify_webhook_label      TEXT,
    smtp_label                TEXT,
    email_from                TEXT,
    brand_accent_color        TEXT CHECK (brand_accent_color IS NULL OR brand_accent_color ~ '^#[0-9a-fA-F]{6}$'),
    -- Whether the node looks for a newer version once a day; NULL looks.
    update_check              BOOLEAN,
    -- The daily backup: whether it runs (NULL runs) and the hour it starts, in time_zone (NULL is 3).
    backup_auto               BOOLEAN,
    backup_hour               SMALLINT CHECK (backup_hour IS NULL OR backup_hour BETWEEN 0 AND 23),
    -- The node's time zone for scheduled work, an IANA name; NULL is UTC. Setup sends the browser's.
    time_zone                 TEXT CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64),
    -- The extra keyword tokenizers, language codes (ko, ar) checked by the node rather
    -- than a CHECK, so a new language needs no migration. NULL: nobody has chosen, which is none.
    search_languages          TEXT[],
    -- The identity provider, at most one. The client secret is a file; this is its fingerprint.
    idp_issuer                TEXT,
    idp_client_id             TEXT,
    idp_client_secret_label   TEXT,
    -- The sign-in button's text; NULL shows the issuer's host.
    idp_label                 TEXT,
    -- NULL asks for 'openid profile email'.
    idp_scopes                TEXT,
    updated_by                TEXT,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((idp_issuer IS NULL) = (idp_client_id IS NULL))
);

-- ============================================================================
-- Sharing links. Only a sha-256 of each token is stored.
-- ============================================================================
CREATE TABLE workspace_invites (
    token_hash   TEXT PRIMARY KEY,
    -- The token's last few characters, shown so a link can be told apart; too few to guess the rest.
    token_hint   TEXT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('admin', 'member', 'guest')),
    created_by   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ,
    max_uses     INTEGER,
    use_count    INTEGER NOT NULL DEFAULT 0,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invites_ws_idx ON workspace_invites (workspace_id);

CREATE TABLE share_links (
    token_hash   TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('viewer', 'commenter', 'editor')),
    created_by   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX share_links_doc_idx ON share_links (doc_id);

-- ============================================================================
-- Audit: an append-only ledger, written in batches by the job worker. It
-- outlives the workspace it names.
-- ============================================================================
CREATE TABLE audit_events (
    id           BIGSERIAL PRIMARY KEY,
    request_id   TEXT,
    -- Millisecond precision, held by the CHECK: the (at, id) paging cursor is a JS
    -- Date, and a microsecond tail would hide rows sharing its millisecond.
    at           TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now())
                 CONSTRAINT audit_events_at_ms_check CHECK (at = date_trunc('milliseconds', at)),
    workspace_id TEXT,
    actor        TEXT NOT NULL,
    actor_kind   TEXT NOT NULL,
    on_behalf_of TEXT,
    source       TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_kind  TEXT,
    target_id    TEXT,
    -- The target's name as it read when the row was written, never resolved later.
    target_label TEXT,
    status       TEXT NOT NULL DEFAULT 'ok',
    detail       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_ws_at_idx        ON audit_events (workspace_id, at DESC);
CREATE INDEX audit_events_actor_at_idx     ON audit_events (actor, at DESC);
CREATE INDEX audit_events_target_at_idx    ON audit_events (target_kind, target_id, at DESC);
CREATE INDEX audit_events_at_idx           ON audit_events (at);
CREATE INDEX audit_events_ws_status_at_idx ON audit_events (workspace_id, status, at DESC);
CREATE INDEX audit_events_ws_behalf_at_idx ON audit_events (workspace_id, on_behalf_of, at DESC)
    WHERE on_behalf_of IS NOT NULL;

-- ============================================================================
-- Agent governance.
-- ============================================================================

-- The workspace review inbox: a mirror of the actors' run ledgers, upserted by
-- the run_index job and guarded on updated_at so a late job never regresses it.
CREATE TABLE agent_runs (
    run_id       TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    doc_id       TEXT NOT NULL,
    doc_kind     TEXT NOT NULL CHECK (doc_kind IN ('prose', 'database')),
    doc_title    TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL,
    agent        TEXT NOT NULL,
    agent_alias  TEXT NOT NULL,
    -- Labels the agent sent about itself; never authority.
    client       TEXT,
    model        TEXT,
    reviewer     TEXT NOT NULL,
    status       TEXT NOT NULL,
    review_mode  TEXT NOT NULL DEFAULT 'review',
    auto_applied BOOLEAN NOT NULL DEFAULT FALSE,
    reverted     BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    pending      INTEGER NOT NULL DEFAULT 0,
    accepted     INTEGER NOT NULL DEFAULT 0,
    rejected     INTEGER NOT NULL DEFAULT 0,
    conflicts    INTEGER NOT NULL DEFAULT 0,
    applied      INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX agent_runs_ws_updated_idx ON agent_runs (workspace_id, updated_at DESC);
CREATE INDEX agent_runs_ws_agent_idx   ON agent_runs (workspace_id, agent_alias, updated_at DESC);
CREATE INDEX agent_runs_doc_idx        ON agent_runs (doc_id);

-- Append-only feed agents poll and webhooks fan out from; the id is the cursor.
CREATE TABLE workspace_events (
    id           BIGSERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    type         TEXT NOT NULL,
    doc_id       TEXT,
    actor        TEXT NOT NULL,
    actor_kind   TEXT NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX workspace_events_ws_id_idx ON workspace_events (workspace_id, id);
CREATE INDEX workspace_events_at_idx    ON workspace_events (at);

-- Deliveries are signed with the per-hook secret (HMAC-SHA256, X-Stuga-Signature).
CREATE TABLE webhooks (
    webhook_id       TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    url              TEXT NOT NULL,
    secret           TEXT NOT NULL,
    -- Event types; empty = all. folder_id NULL = the whole workspace.
    events           TEXT[] NOT NULL DEFAULT '{}',
    folder_id        TEXT REFERENCES folders(folder_id) ON DELETE CASCADE,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_delivery_at TIMESTAMPTZ,
    last_status      INTEGER,
    failures         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX webhooks_ws_idx ON webhooks (workspace_id);
