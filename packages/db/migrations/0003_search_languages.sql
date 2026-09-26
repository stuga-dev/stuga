-- ============================================================================
-- Search languages: the extra keyword tokenizers become a node setting, chosen
-- at setup and in Settings, where they were an environment variable.
-- ============================================================================

-- Language codes (ko, ar), checked by the node rather than a CHECK, so a new
-- language needs no migration. NULL: nobody has chosen, which is none.
ALTER TABLE node_settings ADD COLUMN search_languages TEXT[];
