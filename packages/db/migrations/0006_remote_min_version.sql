-- The oldest release the remote-access service last named as fit to serve a remote address
-- (check-in's min_version, docs/remote-access.md): an older release keeps its remote address closed
-- until it is updated. Kept once met too, so going back to an older release stays closed. NULL
-- while the service names none.
ALTER TABLE node_remote_access
    ADD COLUMN min_version TEXT CHECK (min_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$');
