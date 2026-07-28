import { createClient } from "@supabase/supabase-js";

// Public (browser-safe) Supabase client. Uses the anon/publishable key.
// Do NOT use this for server-only operations that need the service role.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
