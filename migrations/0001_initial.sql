CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  user_api_key TEXT,
  status TEXT DEFAULT 'demo',
  expires_at INTEGER,
  stripe_subscription_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_servers_status ON servers(status);
CREATE INDEX idx_sessions_server ON sessions(server_id);
