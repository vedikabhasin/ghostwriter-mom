-- ---------------------------------------------------------------------------
-- Schema for ghostwriter.mom
-- Every table has a company_id anchor so RLS can be uniform.
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- Companies (one per client / slug)
create table companies (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text unique not null,
  name                   text not null,
  contact_first_name     text,
  email_known            boolean not null default false,
  direction_shape        jsonb  not null,
  offer_text             text,
  subscription_status    text not null default 'none'
                          check (subscription_status in ('none','active','canceled')),
  subscription_ends_at   timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,
  hub_unlocked           boolean not null default false,
  created_at             timestamptz not null default now()
);
create index companies_slug_idx on companies (slug);
create unique index companies_stripe_customer_idx on companies (stripe_customer_id) where stripe_customer_id is not null;
create unique index companies_stripe_subscription_idx on companies (stripe_subscription_id) where stripe_subscription_id is not null;

-- Members: users bound to a company; owner is the payer, up to 3 total.
create table members (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner','member')),
  display_name  text,
  avatar_shape  text,
  onboarding    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (company_id, user_id)
);
create index members_company_id_idx on members (company_id);
create index members_user_id_idx    on members (user_id);

-- Enforce the 3-member cap at the database level.
create or replace function enforce_max_members() returns trigger
language plpgsql as $$
begin
  if (select count(*) from members where company_id = new.company_id) >= 3 then
    raise exception 'company % already has 3 members', new.company_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger members_max_3
  before insert on members
  for each row execute function enforce_max_members();

-- Cards (one company's swipe deck)
create table cards (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  card_key     text not null,
  format       text not null check (format in ('pillar','insight','post')),
  title        text not null,
  angle        text not null,
  evidence     text not null,
  tags         text[] not null default '{}',
  sources      jsonb  not null default '[]'::jsonb,
  drop_date    date,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  unique (company_id, card_key)
);
create index cards_company_id_idx on cards (company_id);

-- Append-only swipe history. member_id is null for pre-login (sales page) swipes.
create table swipe_events (
  id          bigserial primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  card_id     uuid not null references cards(id) on delete cascade,
  member_id   uuid references members(id) on delete set null,
  action      text not null check (action in ('like','pass','save','fasttrack')),
  source      text not null check (source in ('sales','portal')),
  created_at  timestamptz not null default now()
);
create index swipe_events_company_id_idx on swipe_events (company_id);
create index swipe_events_card_id_idx    on swipe_events (card_id);
create index swipe_events_member_id_idx  on swipe_events (member_id);

-- Current-state decisions. One row per (card, member). Anonymous sales-page
-- swipes collapse into one row per card because member_id is null.
-- Uses NULLS NOT DISTINCT so nulls collide with each other on the unique index.
create table decisions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  card_id     uuid not null references cards(id) on delete cascade,
  member_id   uuid references members(id) on delete cascade,
  action      text not null check (action in ('like','pass','save','fasttrack')),
  updated_at  timestamptz not null default now()
);
create unique index decisions_uk on decisions (company_id, card_id, member_id) nulls not distinct;

-- Approvals: one row per Approve Direction click.
create table approvals (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies(id) on delete cascade,
  free_article_card_id  uuid not null references cards(id),
  direction_card_ids    uuid[] not null,
  email                 text,
  approved_at           timestamptz not null default now(),
  deliver_by            timestamptz not null
);
create index approvals_company_id_idx on approvals (company_id);

-- Articles: what the client has been promised or delivered.
create table articles (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  card_id        uuid references cards(id) on delete set null,
  format         text not null check (format in ('pillar','insight','post')),
  title          text not null,
  status         text not null default 'approved_unwritten'
                   check (status in ('approved_unwritten','delivered','live')),
  body_html      text,
  google_doc_url text,
  delivered_at   timestamptz,
  live_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index articles_company_id_idx on articles (company_id);
create unique index articles_company_card_uk on articles (company_id, card_id) where card_id is not null;

-- Signals: the "what changed" alert on the client's portal.
create table signals (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  text        text not null,
  source      text not null,
  signal_date date not null,
  created_at  timestamptz not null default now()
);
create index signals_company_id_idx on signals (company_id);

-- Notes: internal comments. Become Hub items when Session B ships.
create table notes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  card_id     uuid references cards(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index notes_company_id_idx on notes (company_id);
create index notes_member_id_idx  on notes (member_id);

-- Stripe idempotency ledger. The edge function inserts the event id first;
-- a duplicate insert (unique_violation) means it has already been handled.
create table stripe_events (
  id           text primary key,
  processed_at timestamptz not null default now()
);
