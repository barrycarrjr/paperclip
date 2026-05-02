-- External MCP servers — operator-registered Model Context Protocol servers
-- whose tools become callable by Paperclip agents. The connector is the
-- inbound counterpart to packages/mcp-server (outbound). One row per server.
--
-- env_bindings / header_bindings each carry a list of {name, secretRef|value}
-- objects; the secretRef shape matches the existing company-secret UUID
-- referenced by plugin configs, so the same secret-resolution path is reused.
--
-- allowed_companies is a fail-safe-deny allow-list (empty = unusable).
-- allow_mutations is a master switch; write_allow_list is a precise per-tool
-- override for write-class operations the operator wants enabled.
-- tool_allow_list / tool_deny_list further restrict the visible tool surface.

CREATE TABLE IF NOT EXISTS external_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  display_name text NOT NULL,
  description text,
  transport text NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  command text,
  args jsonb,
  url text,
  env_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  header_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_companies jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_mutations boolean NOT NULL DEFAULT false,
  write_allow_list jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_allow_list jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_deny_list jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS external_mcp_servers_key_idx
  ON external_mcp_servers (key);
