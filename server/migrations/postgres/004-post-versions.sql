-- Explicit additive upgrade. No legacy row is deleted or republished.
CREATE TABLE _club_post_versions (
  post_id TEXT COLLATE "C" NOT NULL REFERENCES posts(id),
  revision BIGINT NOT NULL CHECK(revision > 0),
  user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','published','rejected')),
  reason TEXT, created_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
  idempotency_key TEXT NOT NULL, request_hash TEXT,
  PRIMARY KEY(post_id,revision), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE _club_post_revision_heads (
  post_id TEXT COLLATE "C" PRIMARY KEY REFERENCES posts(id),
  latest_revision BIGINT NOT NULL CHECK(latest_revision > 0),
  published_revision BIGINT CHECK(published_revision > 0 AND published_revision <= latest_revision),
  updated_at TEXT NOT NULL, removal_reason TEXT, removed_by TEXT REFERENCES users(id), removed_at TEXT,
  FOREIGN KEY(post_id,latest_revision) REFERENCES _club_post_versions(post_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(post_id,published_revision) REFERENCES _club_post_versions(post_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE _club_post_review_receipts (
  actor_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, post_id TEXT NOT NULL REFERENCES posts(id), result_json JSONB NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
INSERT INTO _club_post_versions(post_id,revision,user_id,title,body,status,reason,created_at,reviewed_by,reviewed_at,idempotency_key)
  SELECT id,1,user_id,title,body,status,reason,created_at,reviewed_by,reviewed_at,idempotency_key FROM posts;
INSERT INTO _club_post_revision_heads(post_id,latest_revision,published_revision,updated_at)
  SELECT id,1,CASE WHEN status='published' THEN 1 ELSE NULL END,COALESCE(reviewed_at,created_at) FROM posts;

CREATE FUNCTION _club_post_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'post version content and ownership are immutable';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
    RAISE EXCEPTION 'completed post review is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER _club_post_version_immutable BEFORE UPDATE ON _club_post_versions FOR EACH ROW EXECUTE FUNCTION _club_post_version_immutable();
INSERT INTO settings(key,value) VALUES('_club_post_versions_migration','004-post-versions-v1');
