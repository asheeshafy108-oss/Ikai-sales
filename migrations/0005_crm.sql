-- Sales/CRM layer. New tables + a last_contacted column, and the existing single
-- leads.notes field migrates in as each lead's first note. lead_events' CHECK is
-- widened (SQLite can't ALTER a CHECK, so rebuild) to allow reminder/file/call/
-- email/contact activity types. Existing data is preserved throughout.

CREATE TABLE lead_notes (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'note',      -- note | call | email | system
  author_email TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lead_notes_lead ON lead_notes(lead_id, created_at);

CREATE TABLE reminders (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  remind_at    TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'open',       -- open | done
  sent_at      TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_reminders_due ON reminders(status, remind_at);
CREATE INDEX idx_reminders_lead ON reminders(lead_id, remind_at);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT,
  r2_key       TEXT NOT NULL,
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_lead ON attachments(lead_id, created_at);

-- Tracks which demo users have been imported, so deleted leads are never re-imported.
CREATE TABLE demo_sync (
  demo_user_id TEXT PRIMARY KEY,
  email        TEXT,
  lead_id      TEXT,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE leads ADD COLUMN last_contacted TEXT;

-- Migrate the existing single notes field into lead_notes as the first note.
INSERT INTO lead_notes (id, lead_id, tenant_id, body, kind, author_email, created_at)
SELECT lower(hex(randomblob(16))), id, tenant_id, notes, 'note', NULL, created_at
FROM leads
WHERE notes IS NOT NULL AND trim(notes) != '';

-- Widen lead_events activity types (rebuild — CHECK can't be altered in place).
CREATE TABLE lead_events_new (
  id             TEXT PRIMARY KEY,
  lead_id        TEXT NOT NULL REFERENCES leads(id),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  type           TEXT NOT NULL CHECK (type IN ('created','stage_change','note','reminder','file','call','email','contact')),
  from_stage     TEXT,
  to_stage       TEXT,
  note           TEXT,
  actor_user_id  TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
INSERT INTO lead_events_new SELECT * FROM lead_events;
DROP TABLE lead_events;
ALTER TABLE lead_events_new RENAME TO lead_events;
CREATE INDEX idx_lead_events_lead ON lead_events(lead_id, created_at);
