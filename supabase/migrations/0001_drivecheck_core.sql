-- ============================================================================
-- DriveCheck — סכימת בסיס
--
-- ⚠️ זו שחזור מתוך קוד ה־Edge Functions, לא ייצוא מהפרויקט החי.
-- היא מספיקה כדי להרים פרויקט Supabase חדש מאפס. אם קיים פרויקט פעיל,
-- יש להשוות מולו לפני שמסתמכים על הקובץ הזה.
--
-- עיקרון: אין ל-anon שום גישה ישירה לטבלאות. כל קריאה וכתיבה עוברות
-- דרך Edge Functions שרצות עם service_role. RLS מופעל בכל מקום, בלי מדיניות
-- מתירה ל-anon — ולכן ברירת המחדל היא חסימה מלאה.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- כספת קונפיגורציה פרטית: מסוף Cardcom, סוד ה-HMAC, PIN המנהל
-- ---------------------------------------------------------------------------
create table if not exists public.buytest_private_config (
  name        text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);
alter table public.buytest_private_config enable row level security;
revoke all on public.buytest_private_config from anon, authenticated;

create or replace function public.buytest_get_private_config(p_name text)
returns text
language sql
security definer
set search_path = public
as $$
  select value from public.buytest_private_config where name = p_name;
$$;

create or replace function public.buytest_set_private_config(p_name text, p_value text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.buytest_private_config (name, value, updated_at)
  values (p_name, p_value, now())
  on conflict (name) do update set value = excluded.value, updated_at = now();
$$;

revoke all on function public.buytest_get_private_config(text) from public, anon, authenticated;
revoke all on function public.buytest_set_private_config(text, text) from public, anon, authenticated;
grant execute on function public.buytest_get_private_config(text) to service_role;
grant execute on function public.buytest_set_private_config(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- הזמנות ותשלומים
-- ---------------------------------------------------------------------------
create table if not exists public.buytest_orders (
  id                       text primary key,
  plate                    text not null,
  plan                     text not null check (plan in ('premium','report','bundle')),
  amount_agorot            integer not null check (amount_agorot > 0),
  amount                   numeric,
  status                   text not null default 'pending'
                             check (status in ('pending','payment_ready','paid','failed','expired')),
  provider                 text not null default 'cardcom',
  provider_transaction_id  text,
  provider_payload         jsonb not null default '{}'::jsonb,
  payment_url              text,
  -- סודות נשמרים כ-hash בלבד; הערך הגולמי קיים רק אצל הלקוח
  client_secret_hash       text,
  redemption_code_hash     text,
  redeemed_at              timestamptz,
  expires_at               timestamptz,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now()
);
alter table public.buytest_orders enable row level security;
revoke all on public.buytest_orders from anon, authenticated;

create index if not exists buytest_orders_plate_idx  on public.buytest_orders (plate);
create index if not exists buytest_orders_status_idx on public.buytest_orders (status);
create unique index if not exists buytest_orders_redemption_idx
  on public.buytest_orders (redemption_code_hash) where redemption_code_hash is not null;

-- מימוש קוד גישה חד־פעמי: קושר הזמנה משולמת למכשיר חדש.
create or replace function public.buytest_redeem_order_access(
  p_code_hash text, p_plate text, p_client_hash text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare rec public.buytest_orders%rowtype;
begin
  update public.buytest_orders
     set client_secret_hash = p_client_hash,
         redeemed_at        = now()
   where redemption_code_hash = p_code_hash
     and plate  = p_plate
     and status = 'paid'
     and redeemed_at is null
     and (expires_at is null or expires_at > now())
  returning * into rec;

  if not found then
    return json_build_object('ok', false);
  end if;

  return json_build_object(
    'ok', true, 'orderId', rec.id, 'plate', rec.plate,
    'plan', rec.plan, 'expiresAt', rec.expires_at
  );
end;
$$;
revoke all on function public.buytest_redeem_order_access(text, text, text) from public, anon, authenticated;
grant execute on function public.buytest_redeem_order_access(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- מאגר נוסחי הבדיקות שמנהל עורך ידנית
-- ---------------------------------------------------------------------------
create table if not exists public.buytest_formula_overrides (
  id                   uuid primary key default gen_random_uuid(),
  source_kind          text not null,
  source_id            text not null,
  source_text          text,
  category             text,
  classification_type  text,
  report_severity      text,
  decision             text,
  meaning              text,
  question             text,
  active               boolean not null default true,
  updated_at           timestamptz not null default now(),
  unique (source_kind, source_id)
);
alter table public.buytest_formula_overrides enable row level security;
revoke all on public.buytest_formula_overrides from anon, authenticated;
create index if not exists buytest_formula_overrides_active_idx
  on public.buytest_formula_overrides (active) where active;
