// Shared HTTP / auth helpers for Edge Functions.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

export function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthenticatedUser {
  id: string;
  isAnonymous: boolean;
}

export async function authenticate(req: Request): Promise<AuthenticatedUser | Response> {
  const auth = req.headers.get('Authorization');
  if (!auth) return fail(401, 'no_auth', 'Authorization header required');
  const jwt = auth.replace(/^Bearer\s+/i, '');
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return fail(401, 'bad_jwt', 'Invalid or expired token');
  return {
    id: data.user.id,
    isAnonymous: data.user.is_anonymous === true,
  };
}

export async function readJson<T = unknown>(req: Request): Promise<T | Response> {
  try {
    return (await req.json()) as T;
  } catch {
    return fail(400, 'bad_body', 'Body must be valid JSON');
  }
}

export function generateInviteCode(): string {
  // Crockford-style alphabet, no ambiguous I/L/O/U.
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += alphabet[b % alphabet.length];
  return out;
}
