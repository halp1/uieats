-- Personal access tokens, for the MCP endpoint at /mcp.
--
-- A session cookie cannot leave the browser, and an MCP client is not a
-- browser. So a user mints a long-lived bearer token on /settings/tokens and
-- pastes it into their client's config. The endpoint is read only, which is
-- what makes a non-expiring credential acceptable: the worst a leaked token
-- can do is read one person's allergen list. Revoking it is the control.
--
-- Same rule as user_session: only sha256 of the token reaches disk. A leaked
-- row cannot be replayed because the token it authenticates is not in it.
-- `hint` is the last four characters, so the list can tell two tokens apart
-- without showing either.

CREATE TABLE api_token (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,   -- hex(sha256(raw token))
  hint         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;
CREATE INDEX idx_api_token_user ON api_token(user_id);
