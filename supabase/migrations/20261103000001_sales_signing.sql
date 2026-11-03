-- Supvoices online signing of order forms.
-- Lives in its own "sales" schema so it never mixes with the Supvoices app tables,
-- and demo resets of the app don't touch it. Only the edge functions (service role /
-- direct database connection) can read or write it.

create schema if not exists sales;
revoke all on schema sales from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema sales from anon, authenticated';
  end if;
end $$;

create table if not exists sales.sign_requests (
  id               uuid primary key default gen_random_uuid(),
  token_hash       text not null unique,          -- sha-256 of the link token; the token itself is never stored
  quote_no         text not null,
  company          text not null default '',
  signer_email     text not null,
  signer_name      text not null default '',
  signer_title     text not null default '',
  summary          jsonb not null default '{}'::jsonb,  -- what the signing page shows (fees, term, start date)
  sign_box         jsonb,                         -- where the customer's signature, name, title and date go in the PDF
  unsigned_path    text not null,
  unsigned_sha256  text not null,
  signed_path      text,
  signed_sha256    text,
  status           text not null default 'sent' check (status in ('sent','opened','signed','cancelled')),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  opened_at        timestamptz,
  signed_at        timestamptz,
  signed_name      text,
  signed_title     text,
  signed_ip        text,
  signed_user_agent text,
  cancelled_at     timestamptz
);
create index if not exists sign_requests_quote_no_idx on sales.sign_requests (quote_no);

create table if not exists sales.sign_codes (
  request_id   uuid primary key references sales.sign_requests(id) on delete cascade,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  sent_count   int not null default 0,
  verified_at  timestamptz
);

-- Audit trail. Append-only: rows can't be changed or deleted.
create table if not exists sales.sign_events (
  id          bigserial primary key,
  request_id  uuid not null references sales.sign_requests(id) on delete restrict,
  type        text not null,
  at          timestamptz not null default now(),
  ip          text,
  user_agent  text,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists sign_events_request_idx on sales.sign_events (request_id, at);

create or replace function sales.sign_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'sign_events is append-only';
end $$;
drop trigger if exists sign_events_append_only on sales.sign_events;
create trigger sign_events_append_only before update or delete on sales.sign_events
  for each row execute function sales.sign_events_append_only();

-- Once signed, the signature details can't be changed.
create or replace function sales.sign_requests_lock_signed() returns trigger
language plpgsql as $$
begin
  if old.status = 'signed' and (
       new.status is distinct from old.status or new.signed_at is distinct from old.signed_at
    or new.signed_name is distinct from old.signed_name or new.signed_path is distinct from old.signed_path
    or new.signed_sha256 is distinct from old.signed_sha256 or new.unsigned_sha256 is distinct from old.unsigned_sha256) then
    raise exception 'a signed order form can''t be changed';
  end if;
  return new;
end $$;
drop trigger if exists sign_requests_lock_signed on sales.sign_requests;
create trigger sign_requests_lock_signed before update on sales.sign_requests
  for each row execute function sales.sign_requests_lock_signed();
create or replace function sales.sign_requests_no_delete() returns trigger
language plpgsql as $$
begin
  if old.status = 'signed' then raise exception 'a signed order form can''t be deleted'; end if;
  return old;
end $$;
drop trigger if exists sign_requests_no_delete on sales.sign_requests;
create trigger sign_requests_no_delete before delete on sales.sign_requests
  for each row execute function sales.sign_requests_no_delete();

-- Private storage bucket for the PDFs (Supabase only).
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('sales-docs', 'sales-docs', false, 10485760, array['application/pdf'])
    on conflict (id) do nothing;
  end if;
end $$;
