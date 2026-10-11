-- Who an invite link is for, in its maker's words ("Sofia", "Kitchen team"), so the list of links
-- and the audit log can say which is which. NULL for a link made without one.
ALTER TABLE workspace_invites
    ADD COLUMN note TEXT CHECK (char_length(note) BETWEEN 1 AND 80);
