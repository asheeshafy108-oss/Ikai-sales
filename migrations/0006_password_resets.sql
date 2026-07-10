-- Password reset tokens. Single-use, time-limited, tenant-scoped (a token maps
-- to exactly one user, and every query hangs off that user's tenant_id). The
-- raw token is emailed; only its sha-256 hex is stored (mirrors sessions/invites).

CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,         -- sha-256 hex of raw 32-byte token
  user_id     TEXT NOT NULL REFERENCES users(id),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  expires_at  TEXT NOT NULL,            -- ISO8601, ~1h from issue
  used_at     TEXT,                     -- set when redeemed; single-use
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at);
