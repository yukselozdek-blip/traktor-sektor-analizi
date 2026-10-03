-- 003: Eksik indeksler (FK ve sık sorgu kalıpları). Hepsi IF NOT EXISTS; transaction içinde
-- çalıştığı için CONCURRENTLY kullanılmaz. Zaten var olanlar (sales brand/year, province/year,
-- subscriptions(user_id), media_watch_items(brand_id, published_at), ai_usage_log(user_id, created_at))
-- tekrar eklenmedi.
CREATE INDEX IF NOT EXISTS idx_sales_model ON sales_data(model_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_payment ON payments(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_run ON media_watch_items(run_id);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_source ON media_watch_items(source_id);
CREATE INDEX IF NOT EXISTS idx_forecast_outputs_scope ON forecast_outputs(province_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_phones_user ON whatsapp_phones(user_id);
