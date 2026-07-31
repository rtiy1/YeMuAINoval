-- Transitional PostgreSQL store. Domain tables will be extracted from this
-- JSONB state row in later migrations without changing the HTTP API.
CREATE TABLE IF NOT EXISTS story_state (
  state_key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS story_state_updated_at_idx ON story_state (updated_at);
