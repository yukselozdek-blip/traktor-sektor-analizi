-- AI kota sayacı: atomik rezervasyon (INSERT .. ON CONFLICT .. WHERE count < limit) için
-- sayaç sütunları NULL olmamalı. Idempotent.
UPDATE usage_meters SET ai_queries_count = 0 WHERE ai_queries_count IS NULL;
UPDATE usage_meters SET ai_tokens_used = 0 WHERE ai_tokens_used IS NULL;
ALTER TABLE usage_meters ALTER COLUMN ai_queries_count SET DEFAULT 0;
ALTER TABLE usage_meters ALTER COLUMN ai_queries_count SET NOT NULL;
ALTER TABLE usage_meters ALTER COLUMN ai_tokens_used SET DEFAULT 0;
ALTER TABLE usage_meters ALTER COLUMN ai_tokens_used SET NOT NULL;
