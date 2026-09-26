-- ============================================================================
-- Workspace imports: a workspace an archive is still being imported into is
-- marked, so it is listed nowhere, and a node stopped partway deletes it when
-- it starts again rather than leave it half-built.
-- ============================================================================

-- Set in the transaction that makes the workspace and cleared once the import is done;
-- NULL for every other workspace.
ALTER TABLE workspaces ADD COLUMN import_started_at TIMESTAMPTZ;
