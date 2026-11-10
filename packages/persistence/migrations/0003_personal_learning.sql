-- Session-scoped personal learning; no economic world is fabricated for standalone study.
CREATE TABLE personal_learning (
  owner_session_hash text PRIMARY KEY CHECK (length(owner_session_hash) = 64),
  version integer NOT NULL CHECK (version >= 1),
  records jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(records) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
