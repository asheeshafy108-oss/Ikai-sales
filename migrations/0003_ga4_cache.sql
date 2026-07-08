-- Cache for GA4 Data API responses (1-hour TTL enforced in the Worker).
-- GA4 quota is tight, so dashboard loads read this instead of hitting the API.
-- Not tenant-scoped: one shared GA4 property (542595696) for the ikai workspace.

CREATE TABLE ga4_cache (
  k          TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
