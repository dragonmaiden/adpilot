create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists scan_runs (
  scan_id text primary key,
  started_at timestamptz,
  finished_at timestamptz,
  status text not null,
  manual boolean not null default false,
  source_status jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists imweb_orders (
  order_no text primary key,
  ordered_at timestamptz,
  order_date date,
  approved_amount numeric(14, 0) not null default 0,
  refunded_amount numeric(14, 0) not null default 0,
  raw jsonb not null,
  last_seen_scan_id text references scan_runs(scan_id) on delete set null,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists imweb_orders_order_date_idx
  on imweb_orders (order_date);

create table if not exists daily_source_snapshots (
  source text not null,
  date date not null,
  scan_id text not null references scan_runs(scan_id) on delete cascade,
  totals jsonb not null,
  created_at timestamptz not null default now(),
  primary key (source, date, scan_id)
);

create index if not exists daily_source_snapshots_date_idx
  on daily_source_snapshots (date);

create table if not exists telegram_report_deliveries (
  report_date date primary key,
  status text not null,
  payload text,
  sent_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
