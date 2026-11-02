-- OAuth 2.1 for the MCP endpoint.
--
-- Some MCP clients (Gemini, Claude.ai connectors) cannot send a header the
-- user pastes in. They only know how to run an authorization-code flow: send
-- the user to a consent page here, get a code back, trade it for tokens. So
-- uieats is its own small authorization server, and the consent page signs
-- people in with the same email code or passkey as the rest of the site.
--
-- The rules from api_token carry over. Only sha256 of any secret reaches disk.
-- Everything is read only, which is the single scope `mcp`.

-- Registered either by the client itself (RFC 7591 dynamic registration, which
-- Gemini relies on) or by an operator with scripts/oauth-client.ts for clients
-- that want a pre-shared id and secret.
CREATE TABLE oauth_client (
  id            TEXT    PRIMARY KEY,            -- the public client_id
  secret_hash   TEXT,                           -- NULL for public (PKCE-only) clients
  name          TEXT    NOT NULL,
  -- JSON array. An entry ending in '*' is a prefix, for operator-registered
  -- clients whose callback path varies (Google's is /r/<project-id>). Dynamic
  -- registrations are always exact.
  redirect_uris TEXT    NOT NULL,
  source        TEXT    NOT NULL CHECK (source IN ('dynamic', 'manual')),
  created_at    INTEGER NOT NULL
) STRICT;

-- Single use, short lived, PKCE bound. Consumed rather than deleted so a
-- replayed code is recognisable as a replay.
CREATE TABLE oauth_code (
  code_hash      TEXT    PRIMARY KEY,
  client_id      TEXT    NOT NULL REFERENCES oauth_client(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  redirect_uri   TEXT    NOT NULL,
  code_challenge TEXT    NOT NULL,
  scope          TEXT    NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_at    INTEGER,
  -- Set on exchange. A second exchange of the same code revokes this grant:
  -- a replayed code means someone else has seen it.
  grant_id       INTEGER REFERENCES oauth_grant(id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;

-- One row per connected app per person: what the settings page lists and what
-- "revoke" deletes. The refresh token is persistent rather than rotated,
-- because Google's account linking asks for exactly that and a rotated token
-- lost in transit would silently disconnect the user.
CREATE TABLE oauth_grant (
  id           INTEGER PRIMARY KEY,
  client_id    TEXT    NOT NULL REFERENCES oauth_client(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  refresh_hash TEXT    NOT NULL UNIQUE,
  scope        TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;
CREATE INDEX idx_oauth_grant_user ON oauth_grant(user_id);

CREATE TABLE oauth_access_token (
  token_hash TEXT    PRIMARY KEY,
  grant_id   INTEGER NOT NULL REFERENCES oauth_grant(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_oauth_access_grant   ON oauth_access_token(grant_id);
CREATE INDEX idx_oauth_access_expires ON oauth_access_token(expires_at);
