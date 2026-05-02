#!/usr/bin/env bash
# Sets the two vault secrets that pg_cron needs to call enforce-timeout-sweep.
# Run after `supabase start`. Idempotent: re-running updates the secrets.

set -euo pipefail

# Local Docker network: postgres reaches the kong gateway at this address.
URL="${URL:-http://kong:8000}"
KEY="${KEY:-$(/c/Users/Admin/AppData/Local/Programs/supabase/supabase.exe status --output json 2>/dev/null | grep -oE '"SERVICE_ROLE_KEY"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')}"

if [[ -z "${KEY}" ]]; then
  # Fallback: well-known local default.
  KEY="super-secret-jwt-token-with-at-least-32-characters-long"
fi

docker exec supabase_db_CardGames psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<EOF
-- Upsert pattern: vault.create_secret throws if name exists, so update if so.
do \$\$
declare
  url_id uuid;
  key_id uuid;
begin
  select id into url_id from vault.secrets where name = 'supabase_functions_url';
  if url_id is null then
    perform vault.create_secret('${URL}', 'supabase_functions_url');
  else
    update vault.secrets set secret = '${URL}' where id = url_id;
  end if;

  select id into key_id from vault.secrets where name = 'supabase_service_role_key';
  if key_id is null then
    perform vault.create_secret('${KEY}', 'supabase_service_role_key');
  else
    update vault.secrets set secret = '${KEY}' where id = key_id;
  end if;
end
\$\$;

select name, created_at from vault.secrets order by name;
EOF

echo "✓ Cron secrets configured."
