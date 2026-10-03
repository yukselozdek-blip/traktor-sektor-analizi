-- 002: initDB'de her boot'ta inline çalışan yapısal (DDL) ifadeler.
-- Tamamı idempotent (IF NOT EXISTS / OR REPLACE). Sıra, eski initDB sırasıyla aynıdır.

ALTER TABLE sales_data ADD COLUMN IF NOT EXISTS model_year INTEGER;

ALTER TABLE model_image_gallery
    ADD COLUMN IF NOT EXISTS model_match_level VARCHAR(40) DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS verification_status VARCHAR(40) DEFAULT 'candidate',
    ADD COLUMN IF NOT EXISTS review_status VARCHAR(40) DEFAULT 'candidate',
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;

-- Model yılı filtreli view: model_year NULL ise (eski veri) dahil, set ise son 2 model yılı kuralı
CREATE OR REPLACE VIEW sales_view AS
SELECT * FROM sales_data
WHERE model_year IS NULL OR year = model_year OR year = model_year + 1;

-- Billing: subscription_plans
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tier_rank INT DEFAULT 1;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS feature_keys JSONB DEFAULT '[]'::jsonb;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_limits JSONB DEFAULT '{}'::jsonb;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TRY';

-- Billing: subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT true;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS first_month_promo_price DECIMAL(10,2);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rivals_selection JSONB DEFAULT '[]'::jsonb;

-- Billing: payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Aylık kullanım sayaçları (AI sorgu, export, API, WA)
CREATE TABLE IF NOT EXISTS usage_meters (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    period_start DATE NOT NULL,
    ai_queries_count INTEGER DEFAULT 0,
    ai_tokens_used BIGINT DEFAULT 0,
    export_rows_count INTEGER DEFAULT 0,
    api_request_count INTEGER DEFAULT 0,
    whatsapp_query_count INTEGER DEFAULT 0,
    anomaly_flags INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, period_start)
);

-- AI çağrı log'u (audit + maliyet)
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    feature VARCHAR(100),
    model VARCHAR(50),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_tl DECIMAL(8,4) DEFAULT 0,
    request_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage_log(user_id, created_at DESC);

-- WhatsApp telefon yönetimi (Enterprise: 3 hat)
CREATE TABLE IF NOT EXISTS whatsapp_phones (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    subscription_id INTEGER REFERENCES subscriptions(id),
    phone_e164 VARCHAR(20) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    role_label VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    is_primary BOOLEAN DEFAULT false,
    activated_at TIMESTAMP DEFAULT NOW(),
    last_query_at TIMESTAMP,
    monthly_query_count INTEGER DEFAULT 0,
    admin_approved BOOLEAN DEFAULT false,
    admin_approved_at TIMESTAMP,
    admin_approved_by INTEGER REFERENCES users(id)
);

-- Makbuz/e-fatura tablosu
CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    payment_id INTEGER REFERENCES payments(id),
    invoice_number VARCHAR(50) UNIQUE,
    invoice_type VARCHAR(20) DEFAULT 'receipt',
    is_legal_invoice BOOLEAN DEFAULT false,
    legal_invoice_pending BOOLEAN DEFAULT true,
    billing_company_name VARCHAR(200),
    billing_tax_office VARCHAR(100),
    billing_tax_number VARCHAR(20),
    billing_address TEXT,
    billing_city VARCHAR(100),
    billing_country VARCHAR(50) DEFAULT 'TR',
    subtotal DECIMAL(12,2),
    vat_rate DECIMAL(4,2) DEFAULT 20.00,
    vat_amount DECIMAL(12,2),
    total DECIMAL(12,2),
    einvoice_status VARCHAR(20),
    einvoice_uuid VARCHAR(100),
    einvoice_pdf_url VARCHAR(500),
    issued_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_pending ON invoices(legal_invoice_pending) WHERE legal_invoice_pending = true;

-- Kullanım anomali izleme
CREATE TABLE IF NOT EXISTS usage_anomalies (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    anomaly_type VARCHAR(50),
    score DECIMAL(4,2),
    details JSONB DEFAULT '{}',
    flagged_at TIMESTAMP DEFAULT NOW(),
    reviewed BOOLEAN DEFAULT false,
    reviewed_by INTEGER REFERENCES users(id)
);

-- Auth genişletme: Google OAuth, email verify, lock, superuser, firma alanları
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(100) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'password';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tax_office VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tax_number VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dealer_or_distributor VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superuser BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preview_plan_slug VARCHAR(50);

CREATE TABLE IF NOT EXISTS auth_audit (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    event VARCHAR(50),
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit(user_id, created_at DESC);

-- Media Watch genişletme: dil + ülke + çeviri kolonları
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'tr';
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS country_code VARCHAR(5) DEFAULT 'TR';
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS original_title TEXT;
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_title TEXT;
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_summary TEXT;
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translation_model VARCHAR(50);
ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_media_watch_items_language ON media_watch_items(language);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_country ON media_watch_items(country_code);

-- teknik_veri -> tractor_models sync için
ALTER TABLE tractor_models ADD COLUMN IF NOT EXISTS price_usd DECIMAL(12,2);
