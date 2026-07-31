CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  settings JSONB,
  auth_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  genre TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  word_count BIGINT NOT NULL DEFAULT 0,
  updated_label TEXT NOT NULL DEFAULT '',
  chapter_count INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT 'cover-new',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects (user_id);

CREATE TABLE IF NOT EXISTS chapters (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  outline TEXT NOT NULL DEFAULT '',
  word_count BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, chapter_id)
);

CREATE INDEX IF NOT EXISTS chapters_project_position_idx ON chapters (project_id, position);

CREATE TABLE IF NOT EXISTS drafts (
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, chapter_id),
  FOREIGN KEY (project_id, chapter_id) REFERENCES chapters(project_id, chapter_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'coral',
  folder TEXT NOT NULL DEFAULT '未分类',
  tags TEXT[] NOT NULL DEFAULT '{}',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ideas_user_id_idx ON ideas (user_id);
CREATE INDEX IF NOT EXISTS ideas_project_id_idx ON ideas (project_id);
