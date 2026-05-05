import { SUP_URL, SUP_ANON_KEY } from "./supabaseConfig.js";

let _client = null;
let _loading = null;

export function isSupabaseConfigured() {
  return Boolean(SUP_URL && SUP_ANON_KEY);
}

export async function getSupabaseClient() {
  if (_client) return _client;
  if (!isSupabaseConfigured()) return null;

  if (_loading) return _loading;

  _loading = (async () => {
    const mod = await import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    );
    const { createClient } = mod;

    _client = createClient(SUP_URL, SUP_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    return _client;
  })();

  try {
    return await _loading;
  } finally {
    _loading = null;
  }
}
