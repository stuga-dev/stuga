-- Credentials remember the listener that issued them, the node's own on its network ('local') or
-- its remote address ('remote'), and are good only there. A person's session also records how and
-- when it began, and at the remote address when it ends however often it renews.

-- Issued before the node recorded where: nobody can say which listener they belong to, so they end.
-- People sign in again; apps connect again.
UPDATE refresh_sessions SET revoked_at = now() WHERE revoked_at IS NULL;
DELETE FROM oauth_codes;
DELETE FROM oauth_tokens;

-- A row is one refresh token; `session_id` is the sign-in its rotations continue, which every access
-- token names (`sid`) and every request looks up. Renewal, and a sibling issued for a duplicate
-- renewal, copy every column below and change none: the absolute limit is fixed at sign-in.
ALTER TABLE refresh_sessions
    ADD COLUMN session_id          TEXT,
    ADD COLUMN arrival             TEXT NOT NULL DEFAULT 'local' CHECK (arrival IN ('local', 'remote')),
    ADD COLUMN signed_in_with      TEXT NOT NULL DEFAULT 'password'
        CHECK (signed_in_with IN ('password', 'provider', 'reset', 'invite', 'setup')),
    ADD COLUMN signed_in_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When the person last proved who they are in this session: set at sign-in, and by re-confirming.
    ADD COLUMN confirmed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Only at the remote address, where a session ends this long after it began.
    ADD COLUMN absolute_expires_at TIMESTAMPTZ,
    ADD CONSTRAINT refresh_sessions_remote_ends CHECK ((arrival = 'remote') = (absolute_expires_at IS NOT NULL));
UPDATE refresh_sessions SET session_id = id;
-- The defaults only let this run on a database that has rows: a write that leaves a column out fails.
ALTER TABLE refresh_sessions
    ALTER COLUMN session_id SET NOT NULL,
    ALTER COLUMN arrival DROP DEFAULT,
    ALTER COLUMN signed_in_with DROP DEFAULT,
    ALTER COLUMN signed_in_at DROP DEFAULT,
    ALTER COLUMN confirmed_at DROP DEFAULT;
CREATE INDEX refresh_sessions_session_idx ON refresh_sessions (session_id);

-- A code is exchanged, and its tokens renewed, only at the listener where the person consented.
ALTER TABLE oauth_codes ADD COLUMN arrival TEXT NOT NULL DEFAULT 'local' CHECK (arrival IN ('local', 'remote'));
ALTER TABLE oauth_codes ALTER COLUMN arrival DROP DEFAULT;
ALTER TABLE oauth_tokens ADD COLUMN arrival TEXT NOT NULL DEFAULT 'local' CHECK (arrival IN ('local', 'remote'));
ALTER TABLE oauth_tokens ALTER COLUMN arrival DROP DEFAULT;

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

-- A signed-in person can confirm who they are again through the identity provider: the provider is
-- asked to have them sign in there once more (prompt=login), and the callback moves only the
-- confirmed sign-in's `confirmed_at`, never when it ends.
ALTER TABLE oidc_flows
    DROP CONSTRAINT oidc_flows_prompt_check,
    ADD CONSTRAINT oidc_flows_prompt_check CHECK (prompt IN ('none', 'select_account', 'login')),
    -- The sign-in (`refresh_sessions.session_id`) a confirmation is for; it links nothing.
    ADD COLUMN confirm_session TEXT,
    ADD CONSTRAINT oidc_flows_confirm_check
        CHECK (confirm_session IS NULL OR (link_alias IS NOT NULL AND prompt = 'login'));
