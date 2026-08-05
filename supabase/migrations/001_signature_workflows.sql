-- PDF Maniac signature/review workflow storage.
-- Run this once in Supabase SQL Editor before enabling invitation flows.

create extension if not exists pgcrypto;

create table if not exists public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_path text not null,
  document_name text not null default 'document.pdf',
  workflow_type text not null default 'signature' check (workflow_type in ('signature', 'review')),
  recipient_email text not null,
  recipient_name text,
  message text,
  status text not null default 'pending' check (status in ('pending', 'viewed', 'signed', 'declined', 'expired', 'cancelled')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  signature_text text,
  signature_image_path text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists signature_requests_owner_created_idx
  on public.signature_requests(owner_id, created_at desc);

create index if not exists signature_requests_token_idx
  on public.signature_requests(token_hash);

create table if not exists public.pdf_audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users(id) on delete set null,
  request_id uuid references public.signature_requests(id) on delete cascade,
  event_type text not null,
  actor_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists pdf_audit_events_request_created_idx
  on public.pdf_audit_events(request_id, created_at desc);

alter table public.signature_requests enable row level security;
alter table public.pdf_audit_events enable row level security;

drop policy if exists "owners can read signature requests" on public.signature_requests;
create policy "owners can read signature requests"
  on public.signature_requests for select
  using (auth.uid() = owner_id);

drop policy if exists "owners can create signature requests" on public.signature_requests;
create policy "owners can create signature requests"
  on public.signature_requests for insert
  with check (auth.uid() = owner_id);

drop policy if exists "owners can update signature requests" on public.signature_requests;
create policy "owners can update signature requests"
  on public.signature_requests for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "owners can delete signature requests" on public.signature_requests;
create policy "owners can delete signature requests"
  on public.signature_requests for delete
  using (auth.uid() = owner_id);

drop policy if exists "owners can read audit events" on public.pdf_audit_events;
create policy "owners can read audit events"
  on public.pdf_audit_events for select
  using (auth.uid() = owner_id);
