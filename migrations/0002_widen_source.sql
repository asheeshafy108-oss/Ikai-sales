-- Widen leads.source to include marketing channels.
-- SQLite can't ALTER a CHECK constraint, so rebuild the table (create new, copy
-- rows, drop old, rename) preserving every column, foreign key, and row. The
-- child tables (lead_events, messages, calls) reference leads(id) by name, so
-- they re-bind to the rebuilt table after the RENAME. Safe here because those
-- child tables are empty; column order is kept identical for INSERT ... SELECT *.

CREATE TABLE leads_new (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  stage_id    TEXT NOT NULL REFERENCES stages(id),
  name        TEXT NOT NULL,
  company     TEXT,
  email       TEXT,
  phone       TEXT,
  source      TEXT NOT NULL CHECK (source IN (
                'manual','csv','demo','booking','call',
                'google','linkedin','meta','email','sms','web'
              )),
  value_cents INTEGER,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO leads_new SELECT * FROM leads;
DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;
CREATE INDEX idx_leads_tenant ON leads(tenant_id, stage_id);
