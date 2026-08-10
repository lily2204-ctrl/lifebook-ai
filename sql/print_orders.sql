-- ─────────────────────────────────────────────────────────────────────────────
-- print_orders — printed / bundle order tracking + admin approval station
-- Run once in the Supabase SQL editor (project → SQL → New query → Run).
--
-- Populated by the Shopify orders/paid webhook (registerPrintOrder) for any
-- order whose variant is PRINTED or BUNDLE. Rows start at
-- status='awaiting_admin_approval'; the owner reviews the two PDFs in
-- print-orders.html and clicks "אשר ושלח לדפוס", which sends the order to
-- Bookpod and flips status to 'sent_to_bookpod'.
--
-- Dedup: UNIQUE(shopify_order_id) is the hard net against duplicate webhooks
-- (a repeat delivery raises Postgres 23505, which the server swallows).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.print_orders (
  id                bigint generated always as identity primary key,
  book_id           text        not null,
  shopify_order_id  text        not null unique,
  format            text        not null,               -- 'printed' | 'bundle'
  status            text        not null default 'awaiting_admin_approval',
                                 -- 'awaiting_admin_approval' | 'sent_to_bookpod'
  shipping          jsonb       not null default '{}'::jsonb,
                                 -- { name, phone, email, address, city, zip, country }
  content_pdf_url   text,
  cover_pdf_url     text,
  bookpod_book_id   text,
  bookpod_order_id  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Fast lookup for the admin "pending" list (ordered oldest-first).
create index if not exists print_orders_status_created_idx
  on public.print_orders (status, created_at);

-- Lookup by book for cross-referencing.
create index if not exists print_orders_book_id_idx
  on public.print_orders (book_id);
