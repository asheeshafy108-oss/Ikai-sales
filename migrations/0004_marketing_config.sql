-- Tenant-level marketing config. Currently just the Google Ads daily budget
-- (AUD), editable in Settings; drives the budget cards on the Google tab.
CREATE TABLE marketing_config (
  tenant_id        TEXT PRIMARY KEY REFERENCES tenants(id),
  daily_budget_aud REAL NOT NULL DEFAULT 12.00,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
