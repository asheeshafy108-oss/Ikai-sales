-- ikai-sales Stage 1 schema. Standalone DB (ikai-sales-db). Multi-tenant.

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,          -- uuid
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL              -- ISO8601
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,        -- uuid
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','member')),
  password_hash TEXT NOT NULL,           -- iterations:salt:hash (all base64/hex)
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE invites (
  token_hash   TEXT PRIMARY KEY,         -- sha-256 hex of raw 32-byte token
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  role         TEXT NOT NULL CHECK (role IN ('owner','member')),
  created_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,            -- 7 days
  used_at      TEXT
);
CREATE INDEX idx_invites_tenant ON invites(tenant_id);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,          -- sha-256 hex of raw 32-byte token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL              -- 30 days
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE stages (
  id         TEXT PRIMARY KEY,           -- uuid
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL
);
CREATE INDEX idx_stages_tenant ON stages(tenant_id, position);

CREATE TABLE leads (
  id          TEXT PRIMARY KEY,          -- uuid
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  stage_id    TEXT NOT NULL REFERENCES stages(id),
  name        TEXT NOT NULL,
  company     TEXT,
  email       TEXT,
  phone       TEXT,
  source      TEXT NOT NULL CHECK (source IN ('manual','csv','demo','booking','call')),
  value_cents INTEGER,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_leads_tenant ON leads(tenant_id, stage_id);

CREATE TABLE lead_events (
  id             TEXT PRIMARY KEY,       -- uuid
  lead_id        TEXT NOT NULL REFERENCES leads(id),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  type           TEXT NOT NULL CHECK (type IN ('created','stage_change','note')),
  from_stage     TEXT,                   -- stage_id
  to_stage       TEXT,                   -- stage_id
  note           TEXT,
  actor_user_id  TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_lead_events_lead ON lead_events(lead_id, created_at);
CREATE INDEX idx_lead_events_tenant ON lead_events(tenant_id);

-- Rate limiting for login (5 / 15min per email).
CREATE TABLE login_attempts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  email  TEXT NOT NULL,
  ts     TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_email ON login_attempts(email, ts);

-- Future-proofing stubs (empty in Stage 1).
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  lead_id      TEXT REFERENCES leads(id),
  direction    TEXT,                     -- 'in' | 'out'
  from_addr    TEXT,
  to_addr      TEXT,
  subject      TEXT,
  snippet      TEXT,
  provider_id  TEXT,
  ts           TEXT
);
CREATE INDEX idx_messages_tenant ON messages(tenant_id);

CREATE TABLE calls (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  lead_id      TEXT REFERENCES leads(id),
  direction    TEXT,                     -- 'in' | 'out'
  from_number  TEXT,
  to_number    TEXT,
  duration_s   INTEGER,
  summary      TEXT,
  provider_id  TEXT,
  ts           TEXT
);
CREATE INDEX idx_calls_tenant ON calls(tenant_id);
