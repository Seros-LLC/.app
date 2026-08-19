-- migrations/0008_embeddings.sql
-- Embeddings table for storing dense vectors (as base64-encoded Float32Array)
-- for semantic search over drafts, tasks, and source messages.

CREATE TABLE IF NOT EXISTS embeddings (
  workspace_id   TEXT   NOT NULL REFERENCES workspaces(id),
  object_id      TEXT   NOT NULL,
  object_type    TEXT   NOT NULL CHECK(object_type IN ('draft', 'task', 'source_message')),
  vector         TEXT   NOT NULL,  -- base64-encoded Float32Array
  PRIMARY KEY (workspace_id, object_id)
);

-- Index for fetching all embeddings of a given type within a workspace (useful for batch ops)
CREATE INDEX IF NOT EXISTS embeddings_ws_type ON embeddings(workspace_id, object_type);