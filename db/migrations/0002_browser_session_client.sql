INSERT OR IGNORE INTO oauth_clients (
  id,
  type,
  name,
  secret_hash,
  disabled_at,
  created_at
) VALUES (
  'aittadb-browser-session-v1',
  'public',
  'AittaDB current browser session',
  NULL,
  NULL,
  0
);

INSERT OR IGNORE INTO client_scopes (client_id, scope)
VALUES ('aittadb-browser-session-v1', 'email');

INSERT OR IGNORE INTO client_scopes (client_id, scope)
VALUES ('aittadb-browser-session-v1', 'profile');

INSERT OR IGNORE INTO client_scopes (client_id, scope)
VALUES ('aittadb-browser-session-v1', 'storage.read');

INSERT OR IGNORE INTO client_scopes (client_id, scope)
VALUES ('aittadb-browser-session-v1', 'storage.write');

INSERT OR IGNORE INTO client_scopes (client_id, scope)
VALUES ('aittadb-browser-session-v1', 'storage.delete');
