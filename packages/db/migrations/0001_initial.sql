-- The Stuga node's Postgres schema.
--
-- @EMBEDDING_DIMS@ is substituted by the runner with the configured embedding
-- width, validated as an integer first: a type modifier cannot be a bind
-- parameter. The width is fixed at creation; the node reads it back at boot and
-- refuses to start when the configuration disagrees.

-- btree_gin lets a scalar workspace_id prefix a GIN index, so the ACL
-- intersection stays index-selective within a tenant.
CREATE EXTENSION vector;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION btree_gin;

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

-- Groups are workspace-scoped: group:eng in two tenants is two rows.
CREATE TABLE groups (
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    group_id     TEXT NOT NULL,
    members      TEXT[] NOT NULL DEFAULT '{}',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, group_id)
);
CREATE INDEX groups_members_gin ON groups USING GIN (members);

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
    -- How AI edits to everything beneath it are reviewed, unless an item sets its own: 'auto'
    -- (they apply at once), 'review' (whoever asked the AI approves) or 'colleague' (someone else
    -- who can edit the item approves). NULL follows the folder above, else 'review'. An item may be
    -- stricter than its folder; only the folder's owner or a workspace admin sets one looser.
    agent_mode      TEXT CHECK (agent_mode IN ('auto', 'review', 'colleague')),
    -- At 'colleague', only members of this group approve, beneath it unless a nearer folder names
    -- another. NULL: anyone else who can edit the item.
    approver_group  TEXT,
    -- The person whose "My notes" this is: where Save to Stuga files what their AI saves for them,
    -- made on first use, owned by them and shared with nobody else until they share it. NULL for any
    -- other folder.
    home_of         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, approver_group) REFERENCES groups (workspace_id, group_id)
        ON DELETE SET NULL (approver_group)
);
-- One "My notes" per person per workspace, found by it.
CREATE UNIQUE INDEX folders_home_idx ON folders (workspace_id, home_of) WHERE home_of IS NOT NULL;
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
    -- The body as Markdown, which excerpts are cut from.
    search_text     TEXT NOT NULL DEFAULT '',
    -- The keyword index of the title and of the body, and how many terms each
    -- holds (BM25's length), written by the node (search-vectors.ts) in the
    -- format named here; a row in another is written again in the background.
    title_tsv       TSVECTOR NOT NULL DEFAULT '',
    title_dl        INTEGER NOT NULL DEFAULT 0,
    search_tsv      TSVECTOR NOT NULL DEFAULT '',
    search_dl       INTEGER NOT NULL DEFAULT 0,
    search_format   TEXT,
    -- sha-256 of the last embedded text, so an unchanged flush skips the model call.
    embedding_hash  TEXT,
    -- Oldest snapshot seq still in the version ring. Only ever rises, so a
    -- retried job cannot reopen a pruned version. NULL = no ring published.
    version_floor   BIGINT,
    -- Its own review level for AI edits, as folders.agent_mode; NULL follows its folder.
    agent_mode      TEXT CHECK (agent_mode IN ('auto', 'review', 'colleague')),
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
-- Title filters and the typo leg of search; pg_trgm folds case itself.
CREATE INDEX docs_title_trgm     ON docs USING GIN (title gin_trgm_ops);
-- Written as each row is, so a search never reads a pending list.
CREATE INDEX docs_title_tsv_gin  ON docs USING GIN (title_tsv) WITH (fastupdate = off);
CREATE INDEX docs_search_tsv_gin ON docs USING GIN (search_tsv) WITH (fastupdate = off);
CREATE INDEX docs_parent_idx     ON docs (parent_id);
CREATE INDEX docs_owner_idx      ON docs (owner);
CREATE INDEX docs_ws_acl_gin     ON docs USING GIN (workspace_id, acl_principals);
CREATE INDEX docs_ws_writers_gin ON docs USING GIN (workspace_id, acl_writers);
CREATE INDEX docs_trashed_idx    ON docs (trashed_at) WHERE trashed = TRUE;
CREATE INDEX docs_page_of_idx    ON docs (workspace_id, page_of) WHERE page_of IS NOT NULL;

-- The review level a folder gives what is in it: its own, else the nearest folder's above it that
-- sets one; NULL when none does (then 'review'). Walked at most 32 deep, as every folder chain is.
CREATE FUNCTION folder_agent_mode(start_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    WITH RECURSIVE up(parent_id, agent_mode, depth) AS (
        SELECT parent_id, agent_mode, 0 FROM folders WHERE folder_id = start_id
        UNION ALL
        SELECT f.parent_id, f.agent_mode, u.depth + 1
        FROM folders f JOIN up u ON f.folder_id = u.parent_id
        WHERE u.agent_mode IS NULL AND u.depth < 32
    )
    SELECT agent_mode FROM up WHERE agent_mode IS NOT NULL ORDER BY depth LIMIT 1
$$;

-- The approver group a folder gives what is in it, the same way.
CREATE FUNCTION folder_approver_group(start_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    WITH RECURSIVE up(parent_id, approver_group, depth) AS (
        SELECT parent_id, approver_group, 0 FROM folders WHERE folder_id = start_id
        UNION ALL
        SELECT f.parent_id, f.approver_group, u.depth + 1
        FROM folders f JOIN up u ON f.folder_id = u.parent_id
        WHERE u.approver_group IS NULL AND u.depth < 32
    )
    SELECT approver_group FROM up WHERE approver_group IS NOT NULL ORDER BY depth LIMIT 1
$$;

-- Per-chunk index rows, replaced wholesale on each real index of a document.
CREATE TABLE doc_chunks (
    doc_id         TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
    workspace_id   TEXT NOT NULL,
    chunk_index    INTEGER NOT NULL,
    content        TEXT NOT NULL,
    -- "Overview > Geophysics"; NULL for a preamble or headingless text.
    heading_path   TEXT,
    -- The keyword index of the heading and the passage, chunk 0's with the
    -- document title, kept so by indexDoc and rename (both holding the docs row
    -- lock), and the terms it holds.
    tsv            TSVECTOR NOT NULL DEFAULT '',
    dl             INTEGER NOT NULL DEFAULT 0,
    embedding      vector(@EMBEDDING_DIMS@),
    -- sha-256 of the exact embed input, so an unchanged chunk reuses its vector.
    embed_hash     TEXT,
    -- Failed embed attempts; the reconcile sweep gives up on a chunk past its cap.
    embed_attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, chunk_index)
);
CREATE INDEX doc_chunks_doc_idx  ON doc_chunks (doc_id);
CREATE INDEX doc_chunks_ws_idx   ON doc_chunks (workspace_id);
CREATE INDEX doc_chunks_tsv_gin  ON doc_chunks USING GIN (tsv) WITH (fastupdate = off);
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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Whether it also went out through the node's sink: the channel is set when the row is written,
    -- 'none' when it is shown in Stuga only, and each attempt sets `delivered_at` or `delivery_error`.
    delivery_channel TEXT CHECK (delivery_channel IN ('none', 'slack', 'teams', 'discord', 'email', 'webhook')),
    delivered_at     TIMESTAMPTZ,
    delivery_error   TEXT CHECK (length(delivery_error) <= 300)
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
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- "Sign in faster next time" is offered once, after a password sign-in at the remote address;
    -- this is when the person said Not now.
    passkey_offer_dismissed_at TIMESTAMPTZ,
    -- The interface language a person chose; NULL follows their browser. The node checks the value
    -- against the languages it has catalogs for, so a new language needs no migration.
    ui_language          TEXT CHECK (ui_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
    -- What their browser asked for at their last sign-in: the language for what the node sends
    -- them outside the app while they follow their browser.
    ui_language_detected TEXT CHECK (ui_language_detected ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
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

-- Passkeys, only at the remote address: a credential's public key, for the host (`rp_id`) it was
-- made at, never its private key. `backup_eligible` is set once, as the authenticator reported it at
-- registration; `synced` follows what it reports at each sign-in.
CREATE TABLE passkeys (
    credential_id   TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 1400),
    alias           TEXT NOT NULL REFERENCES users(alias) ON DELETE CASCADE,
    rp_id           TEXT NOT NULL,
    public_key      BYTEA NOT NULL,
    algorithm       INTEGER NOT NULL CHECK (algorithm IN (-8, -7, -257)),
    sign_count      BIGINT NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
    transports      TEXT[] NOT NULL DEFAULT '{}',
    backup_eligible BOOLEAN NOT NULL,
    synced          BOOLEAN NOT NULL,
    -- Named by the node from the authenticator and the browser ("iCloud Keychain"); the person may rename it.
    name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    CONSTRAINT passkeys_synced_check CHECK (backup_eligible OR NOT synced)
);
CREATE INDEX passkeys_alias_idx ON passkeys (alias, rp_id);

-- A row is one refresh token; `session_id` is the sign-in its rotations continue, which every access
-- token names (`sid`) and every request looks up. Renewal, and a sibling issued for a duplicate
-- renewal, copy every column from `session_id` on and change none: the absolute limit is fixed at
-- sign-in. A credential is good only at the listener that issued it, the node's own on its network
-- ('local') or its remote address ('remote'). A sign-in made with a passkey ends when the passkey is
-- removed.
CREATE TABLE refresh_sessions (
    id          TEXT PRIMARY KEY,
    alias       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    -- The successor's token_hash, set only by rotation: it tells a rotated session
    -- from a revoked one, so a duplicate rotation inside the grace window is forgiven.
    replaced_by TEXT,
    session_id          TEXT NOT NULL,
    arrival             TEXT NOT NULL CHECK (arrival IN ('local', 'remote')),
    signed_in_with      TEXT NOT NULL
        CHECK (signed_in_with IN ('password', 'provider', 'passkey', 'reset', 'invite', 'setup')),
    passkey_id          TEXT REFERENCES passkeys(credential_id) ON DELETE CASCADE,
    signed_in_at        TIMESTAMPTZ NOT NULL,
    -- When the person last proved who they are in this session: set at sign-in, and by re-confirming.
    confirmed_at        TIMESTAMPTZ NOT NULL,
    -- Only at the remote address, where a session ends this long after it began.
    absolute_expires_at TIMESTAMPTZ,
    CONSTRAINT refresh_sessions_remote_ends CHECK ((arrival = 'remote') = (absolute_expires_at IS NOT NULL)),
    CONSTRAINT refresh_sessions_passkey_check CHECK ((signed_in_with = 'passkey') = (passkey_id IS NOT NULL)),
    CONSTRAINT refresh_sessions_passkey_remote CHECK (arrival = 'remote' OR signed_in_with <> 'passkey')
);
CREATE INDEX refresh_sessions_alias_idx  ON refresh_sessions (alias);
CREATE INDEX refresh_sessions_expiry_idx ON refresh_sessions (expires_at);
CREATE INDEX refresh_sessions_session_idx ON refresh_sessions (session_id);
CREATE INDEX refresh_sessions_passkey_idx ON refresh_sessions (passkey_id) WHERE passkey_id IS NOT NULL;

-- Browsers that have signed in to an account, by a cookie each holds (only its sha-256 is kept), per
-- listener. A sign-in at the remote address from a browser not listed here is reported.
CREATE TABLE known_devices (
    alias        TEXT NOT NULL REFERENCES users(alias) ON DELETE CASCADE,
    arrival      TEXT NOT NULL CHECK (arrival IN ('local', 'remote')),
    token_hash   TEXT NOT NULL,
    -- From the User-Agent, such as "Safari on iPhone".
    label        TEXT NOT NULL CHECK (length(label) <= 64),
    -- The address of the first sign-in from it.
    first_from   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (alias, arrival, token_hash)
);
CREATE INDEX known_devices_seen_idx ON known_devices (last_seen_at);

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
    -- 'none' for a silent sign-in, 'select_account' to ask which account after a sign-out, 'login'
    -- when a signed-in person confirms who they are again through the provider.
    prompt        TEXT CHECK (prompt IN ('none', 'select_account', 'login')),
    -- Set when a signed-in person links the provider to their account.
    link_alias    TEXT REFERENCES users(alias) ON DELETE CASCADE,
    return_to     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The sign-in (`refresh_sessions.session_id`) a confirmation is for: the callback moves only its
    -- `confirmed_at`, never when it ends. It links nothing.
    confirm_session TEXT,
    CONSTRAINT oidc_flows_confirm_check
        CHECK (confirm_session IS NULL OR (link_alias IS NOT NULL AND prompt = 'login'))
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
    expires_at      TIMESTAMPTZ NOT NULL,
    -- A code is exchanged, and its tokens renewed, only at the listener where the person consented.
    arrival         TEXT NOT NULL CHECK (arrival IN ('local', 'remote'))
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

-- The person whose "My notes" holds the folder `start_id`, at it or above it; NULL outside every
-- My notes. Walked at most 32 deep, as every folder chain is.
CREATE FUNCTION folder_home_of(start_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    WITH RECURSIVE up(parent_id, home_of, depth) AS (
        SELECT parent_id, home_of, 0 FROM folders WHERE folder_id = start_id
        UNION ALL
        SELECT f.parent_id, f.home_of, u.depth + 1
        FROM folders f JOIN up u ON f.folder_id = u.parent_id
        WHERE u.home_of IS NULL AND u.depth < 32
    )
    SELECT home_of FROM up WHERE home_of IS NOT NULL ORDER BY depth LIMIT 1
$$;

-- Whether an item in the My notes of `home` is shared beyond that person: its readers name someone
-- else, a group, the workspace, or another person's agent. An agent is among the readers only as
-- the one that made the item, so the agents acting for the person, and any the node holds no key
-- or sign-in for, share nothing. Every agent's edits to such an item wait for review at least.
-- FALSE when `home` is NULL.
CREATE FUNCTION notes_shared(home TEXT, readers TEXT[]) RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT home IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest(readers) AS r(principal)
        WHERE r.principal <> 'user:' || home
          AND (r.principal NOT LIKE 'agent:%'
               OR EXISTS (SELECT 1 FROM api_keys k WHERE k.agent_id = substr(r.principal, 7) AND k.owner <> home)
               OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.agent_id = substr(r.principal, 7) AND g.owner <> home))
    )
$$;

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    arrival    TEXT NOT NULL CHECK (arrival IN ('local', 'remote'))
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
    -- Each part runs once configured: chat when a provider offers a model, semantic
    -- search when an embedding model is set. FALSE switches that part off, keeping it.
    chat_enabled           BOOLEAN,
    embed_enabled          BOOLEAN,
    chat_default_model     TEXT,
    -- [{id, provider, baseUrl, models, apiKeyFp}]; apiKeyFp is a fingerprint.
    chat_endpoints         JSONB NOT NULL DEFAULT '[]',
    embed_provider         TEXT CHECK (embed_provider IN ('anthropic', 'openai', 'ollama')),
    embed_base_url         TEXT,
    embed_model            TEXT,
    embed_api_key_fp       TEXT,
    -- A System One reranker (TypeSafe's Jev), set up when a model is set; FALSE switches it off,
    -- keeping it. Without one, the chat model reranks while chat is on.
    rerank_enabled         BOOLEAN,
    rerank_base_url        TEXT,
    rerank_model           TEXT,
    rerank_api_key_fp      TEXT,
    updated_by             TEXT,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The search box's cutoff by meaning, a level at distances the node measures for the embedding
    -- model in force (embed_calibrations); NULL takes the default level. Ask and agents take the
    -- nearest passages and leave relevance to the reranker.
    search_strictness      TEXT CHECK (search_strictness IN ('strict', 'balanced', 'loose', 'off'))
);

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
    -- The scheduled backup: whether it runs (NULL runs), the hour it starts in time_zone (NULL is 3),
    -- the weekday of a weekly one (0 is Sunday; NULL backs up every day), and how many are kept (NULL is 3).
    backup_auto               BOOLEAN,
    backup_hour               SMALLINT CHECK (backup_hour IS NULL OR backup_hour BETWEEN 0 AND 23),
    backup_weekday            SMALLINT CHECK (backup_weekday IS NULL OR backup_weekday BETWEEN 0 AND 6),
    backup_keep               SMALLINT CHECK (backup_keep IS NULL OR backup_keep BETWEEN 1 AND 100),
    -- The node's time zone for scheduled work, an IANA name; NULL is UTC. Setup sends the browser's.
    time_zone                 TEXT CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64),
    -- The languages keyword search stems words in beside English, codes (de, ar) checked by
    -- the node rather than a CHECK, so a new language needs no migration. NULL: nobody has chosen, which is none.
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

-- Remote access: the binding to the remote-access service, and where the certificate, the relay
-- credential and the connector stand. No secret lives here: the keys are files under DATA_DIR
-- (docs/remote-access.md). Kept out of node_settings, whose row a settings reset deletes.
CREATE TABLE node_remote_access (
    id                          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    enabled                     BOOLEAN     NOT NULL DEFAULT FALSE,
    enabled_by                  TEXT,
    enabled_at                  TIMESTAMPTZ,
    -- The binding, from the service's answer to enroll or rebind.
    remote_id                   TEXT CHECK (remote_id ~ '^[0-9bcdfghjkmnpqrstvwxz]{6,12}$'),
    hostname                    TEXT CHECK (hostname ~ '^[0-9bcdfghjkmnpqrstvwxz]{6,12}(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
    api_url                     TEXT CHECK (api_url ~ '^(https://[a-z0-9.-]+(:[0-9]{1,5})?|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)$'),
    binding_thumbprint          TEXT CHECK (binding_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
    bound_at                    TIMESTAMPTZ,
    -- Set at the first 401 from the service and cleared by any success; 24 hours on, the admin is told.
    binding_failing_since       TIMESTAMPTZ,
    -- From the last check-in: [{name, addr, port, server_name, ca_pem}].
    relays                      JSONB       NOT NULL DEFAULT '[]',
    acme_directory              TEXT,
    acme_profile                TEXT,
    acme_reissue_before         TIMESTAMPTZ,
    acme_account_directory      TEXT,
    acme_account_url            TEXT,
    -- Who accepted the certificate authority's subscriber agreement, and which version the account took.
    ca_terms_accepted_by        TEXT,
    ca_terms_accepted_at        TIMESTAMPTZ,
    ca_terms_url                TEXT,
    cert_serial                 TEXT,
    cert_directory              TEXT,
    cert_not_before             TIMESTAMPTZ,
    cert_not_after              TIMESTAMPTZ,
    cert_renew_at               TIMESTAMPTZ,
    -- The acme_reissue_before in hand when it was issued, which it answers however the CA dates it.
    cert_reissue_before         TIMESTAMPTZ,
    cert_failures               INTEGER     NOT NULL DEFAULT 0,
    cert_retry_at               TIMESTAMPTZ,
    -- The account that ordered it: a renewal names it as replaced only from the same account.
    cert_account_url            TEXT,
    -- The CA's renewal window for it (RFC 9773), and when to ask again.
    cert_ari_next_at            TIMESTAMPTZ,
    cert_ari_window_start       TIMESTAMPTZ,
    cert_ari_window_end         TIMESTAMPTZ,
    -- The certificate the administrators were last warned about; cleared once a new one is in use.
    cert_alerted_serial         TEXT,
    checkin_at                  TIMESTAMPTZ,
    checkin_next_at             TIMESTAMPTZ,
    credential_ttl              INTEGER,
    credential_not_before       TIMESTAMPTZ,
    credential_issued_at        TIMESTAMPTZ,
    credential_expires_at       TIMESTAMPTZ,
    credential_refresh_at       TIMESTAMPTZ,
    credential_failures         INTEGER     NOT NULL DEFAULT 0,
    credential_retry_at         TIMESTAMPTZ,
    probe_at                    TIMESTAMPTZ,
    probe_ok_at                 TIMESTAMPTZ,
    probe_failures              INTEGER     NOT NULL DEFAULT 0,
    -- sha-256 over the connector's files (toml and CA), and when that last changed.
    connector_config_sha256     TEXT,
    connector_config_changed_at TIMESTAMPTZ,
    -- {code, message, at, retry_at?, service_code?, reason?}; NULL when nothing is wrong.
    last_error                  JSONB,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The oldest release the remote-access service last named as fit to serve a remote address
    -- (check-in's min_version, docs/remote-access.md): an older release keeps its remote address closed
    -- until it is updated. Kept once met too, so going back to an older release stays closed. NULL
    -- while the service names none.
    min_version                 TEXT CHECK (min_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
    CHECK (NOT enabled OR (remote_id IS NOT NULL AND hostname IS NOT NULL AND api_url IS NOT NULL
                           AND ca_terms_accepted_at IS NOT NULL))
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
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Who the link is for, in its maker's words ("Sofia", "Kitchen team"), so the list of links and
    -- the audit log can say which is which. NULL for a link made without one.
    note         TEXT CHECK (char_length(note) BETWEEN 1 AND 80)
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
    -- The strictest level a proposal in the run carried; a decision takes the stricter of it and the item's now.
    review_mode  TEXT NOT NULL DEFAULT 'review' CHECK (review_mode IN ('auto', 'review', 'colleague')),
    -- The approver group it was proposed under, if any.
    approver_group TEXT,
    -- Who accepted its changes at 'colleague'. Never the person who asked the AI, an administrator
    -- included: the actor refuses it, and so does this row.
    approved_by  TEXT[] NOT NULL DEFAULT '{}'
                 CONSTRAINT agent_runs_approved_by_check CHECK (NOT (reviewer = ANY (approved_by))),
    auto_applied BOOLEAN NOT NULL DEFAULT FALSE,
    reverted     BOOLEAN NOT NULL DEFAULT FALSE,
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    pending      INTEGER NOT NULL DEFAULT 0,
    accepted     INTEGER NOT NULL DEFAULT 0,
    rejected     INTEGER NOT NULL DEFAULT 0,
    conflicts    INTEGER NOT NULL DEFAULT 0,
    applied      INTEGER NOT NULL DEFAULT 0,
    -- The run of the same agent on the same item it waits behind: proposed on top of that run's
    -- undecided changes, it is approved only once that one is decided.
    queued_behind TEXT,
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
    -- generic: the event feed as JSON. slack: a review channel, one link-only post per run that
    -- waits for a colleague, to a Slack incoming webhook.
    kind             TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('generic', 'slack')),
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

-- What a review channel has posted: one post per hook and run, or per hook and change for the runs of a
-- change, however often it grows. subject_id is the run's id or the change's.
CREATE TABLE review_posts (
    webhook_id TEXT NOT NULL REFERENCES webhooks(webhook_id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (webhook_id, subject_id)
);
CREATE INDEX review_posts_created_idx ON review_posts (created_at);

-- A change: the runs one agent makes across several pages for one piece of work (an ingest of a
-- meeting, a Save to Stuga of several points), reviewed as one. Each run stays its page's own, decided
-- at that page's level. The agent opens it with a title; the summary is its own words for approvers.
CREATE TABLE wiki_changes (
    change_id    TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    -- The agent's label, its alias (the run identity) and the person it acts for, who asked.
    agent        TEXT NOT NULL,
    agent_alias  TEXT NOT NULL,
    on_behalf_of TEXT NOT NULL,
    client       TEXT,
    model        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wiki_changes_ws_updated_idx ON wiki_changes (workspace_id, updated_at DESC);

-- The runs of a change, on documents and databases alike; a run belongs to one change.
CREATE TABLE wiki_change_runs (
    change_id  TEXT NOT NULL REFERENCES wiki_changes(change_id) ON DELETE CASCADE,
    doc_id     TEXT NOT NULL,
    run_id     TEXT NOT NULL UNIQUE,
    doc_kind   TEXT NOT NULL CHECK (doc_kind IN ('prose', 'database')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (change_id, run_id)
);
CREATE INDEX wiki_change_runs_doc_idx ON wiki_change_runs (doc_id);

-- A page an agent made in a change where AI edits wait for a colleague. While held, only the person who
-- asked and those who may approve it can open it (held_grants, its folder's access not inherited), and no
-- event, webhook or export names it. Approved, it takes release_grants and its folder's access; declined
-- or withdrawn, it goes to the trash with the note. reviewer and approver_group are how it was judged
-- when made, for approving a page that holds no change yet.
CREATE TABLE wiki_change_pages (
    doc_id         TEXT PRIMARY KEY REFERENCES docs(doc_id) ON DELETE CASCADE,
    change_id      TEXT NOT NULL REFERENCES wiki_changes(change_id) ON DELETE CASCADE,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    state          TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'released', 'removed')),
    held_grants    TEXT[] NOT NULL DEFAULT '{}',
    release_grants JSONB NOT NULL DEFAULT '{"p":[],"w":[],"c":[]}',
    reviewer       TEXT NOT NULL,
    approver_group TEXT,
    note           TEXT,
    decided_by     TEXT,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wiki_change_pages_change_idx ON wiki_change_pages (change_id);
CREATE INDEX wiki_change_pages_held_idx   ON wiki_change_pages (doc_id) WHERE state = 'held';
