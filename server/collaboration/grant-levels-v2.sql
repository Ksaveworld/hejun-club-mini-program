-- Incremental proposal: preserve all rows and previous migration hashes.
-- grant-migration.mjs verifies the exact original constraint before applying.
ALTER TABLE collab_grants DROP CONSTRAINT collab_grants_level_check;
ALTER TABLE collab_grants ADD CONSTRAINT collab_grants_level_check CHECK(level IN ('basic','star'));
