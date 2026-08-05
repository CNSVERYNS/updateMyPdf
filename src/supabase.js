import { createClient } from '@supabase/supabase-js'

const runtimeConfig = typeof window !== 'undefined' ? window.__PDF_MANIAC_CONFIG__ || {} : {}
const runtimeSupabaseUrl = runtimeConfig.supabaseUrl && !runtimeConfig.supabaseUrl.startsWith('__PDF_MANIAC_') ? runtimeConfig.supabaseUrl : ''
const runtimeSupabaseAnonKey = runtimeConfig.supabaseAnonKey && !runtimeConfig.supabaseAnonKey.startsWith('__PDF_MANIAC_') ? runtimeConfig.supabaseAnonKey : ''
const supabaseUrl = runtimeSupabaseUrl || import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = runtimeSupabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : null
