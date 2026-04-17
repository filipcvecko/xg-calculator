-- Spusti tento SQL v Supabase > SQL Editor
-- Migrácia: home_goals / away_goals
ALTER TABLE bets ADD COLUMN IF NOT EXISTS home_goals integer;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS away_goals integer;



create table bets (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  match_name text,
  market text not null,
  lambda_h numeric,
  lambda_a numeric,
  p_over numeric,
  p_under numeric,
  sel_prob numeric,
  fer_odds numeric,
  odds_open numeric,
  odds_close numeric,
  stake numeric default 10,
  ev numeric,
  ev_pct numeric,
  clv numeric,
  result integer,
  pnl numeric,
  brier numeric,
  log_loss numeric
);

-- Povoliť čítanie/zápis bez prihlásenia (jednoduchý prístup)
alter table bets enable row level security;

create policy "Allow all" on bets
  for all
  using (true)
  with check (true);
