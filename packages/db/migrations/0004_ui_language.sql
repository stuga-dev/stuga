-- The interface language a person chose; NULL follows their browser. The node checks the value
-- against the languages it has catalogs for, so a new language needs no migration.
ALTER TABLE users
    ADD COLUMN ui_language TEXT CHECK (ui_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
    -- What their browser asked for at their last sign-in: the language for what the node sends
    -- them outside the app while they follow their browser.
    ADD COLUMN ui_language_detected TEXT CHECK (ui_language_detected ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
