-- 010: Yönetim (admin) konsolu ve kurumsal sözleşme şeması (ADMIN_PANEL_PLAN.md §4).
-- Hepsi IF NOT EXISTS / ON CONFLICT DO NOTHING ile idempotent; transaction'ı migrate.js sarar.

-- Ekip rolleri: yetki listesi taşıyan şablonlar. Sistem rolleri (is_system) silinemez.
CREATE TABLE IF NOT EXISTS staff_roles (
    key VARCHAR(50) PRIMARY KEY,            -- ^[a-z][a-z0-9_]{1,49}$
    name VARCHAR(100) NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["orgs.read", ...] veya ["*"]
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO staff_roles (key, name, description, permissions, is_system) VALUES
    ('super_admin', 'Süper Yönetici', 'Tüm yetkiler. Yalnızca superuser atayabilir.', '["*"]'::jsonb, true),
    ('account_manager', 'Müşteri Yöneticisi', 'Kurum ve üye yönetimi, müşteri takibi.',
        '["dashboard.view","orgs.read","orgs.write","members.write","users.read","audit.read"]'::jsonb, true),
    ('support', 'Destek', 'Kullanıcı ve üye desteği; kullanıcı aktif/pasif ve elle abonelik.',
        '["dashboard.view","orgs.read","users.read","users.write","members.write","audit.read"]'::jsonb, true),
    ('finance', 'Finans', 'Salt okunur kurum ve kullanıcı görünümü, denetim kaydı.',
        '["dashboard.view","orgs.read","users.read","audit.read"]'::jsonb, true),
    ('viewer', 'Salt Okunur', 'Salt okunur genel görünüm.',
        '["dashboard.view","orgs.read","users.read","audit.read"]'::jsonb, true)
ON CONFLICT (key) DO NOTHING;

-- Ekip üyesi rolü. NULL = ekip rolü yok (role='brand_user' veya staff_role ayarlanmamış admin).
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role VARCHAR(50) REFERENCES staff_roles(key) ON DELETE SET NULL;

-- Geriye uyumluluk: staff_role'u olmayan mevcut yöneticiler (role='admin') bu migration'dan sonra
-- açıkça super_admin olur. Karar: önceki tüm yöneticiler tam yetkiliydi; yetki kaybı yaşatılmaz.
-- Idempotent: staff_role NULL olanlara yazar, ikinci çalıştırmada 0 satır etkiler.
UPDATE users SET staff_role = 'super_admin' WHERE role = 'admin' AND staff_role IS NULL;

-- Kurumlar (sözleşmeli B2B müşteriler).
CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
    seat_limit INTEGER NOT NULL DEFAULT 5 CHECK (seat_limit >= 0 AND seat_limit <= 100000),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended','expired')),
    contract_start DATE,
    contract_end DATE,                      -- NULL = süresiz; bu tarih dahil geçerlidir
    billing_type VARCHAR(20) NOT NULL DEFAULT 'contract' CHECK (billing_type IN ('contract','invoice','card','free')),
    contract_ref VARCHAR(100),
    contact_name VARCHAR(200),
    contact_email VARCHAR(254),
    notes TEXT,
    auto_join BOOLEAN NOT NULL DEFAULT true,  -- alan adı eşleşen e-postalar davet kodsuz katılabilir
    feature_overrides JSONB NOT NULL DEFAULT '{"add":[],"remove":[]}'::jsonb,
    limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"ai_queries_monthly": 500, ...}
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Kurum alan adları. Bir alan adı yalnızca tek kuruma bağlanır.
CREATE TABLE IF NOT EXISTS organization_domains (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain VARCHAR(253) NOT NULL UNIQUE,    -- küçük harf, '@' yok
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Kurum üyelikleri. Bir kullanıcı en fazla bir kuruma üye olur (user_id UNIQUE); her satır bir koltuk kullanır.
CREATE TABLE IF NOT EXISTS organization_members (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    member_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','org_admin')),
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    joined_via VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (joined_via IN ('admin','domain','invitation','org_admin')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);

-- Kurum davetleri: alan adı dışındaki kişiler (ör. danışman) için e-posta izin listesi.
CREATE TABLE IF NOT EXISTS organization_invitations (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(254) NOT NULL,            -- küçük harf
    member_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','org_admin')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    UNIQUE (organization_id, email)
);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email) WHERE status = 'pending';

-- Küresel özellik bayrakları (acil kapatma / kademeli devreye alma).
CREATE TABLE IF NOT EXISTS feature_flags (
    key VARCHAR(100) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- PLAN_FEATURE_CATALOG'daki tüm anahtarlar (starter + growth + enterprise, tekrarsız). Hepsi açık başlar.
-- Sonradan eklenen bir anahtarın mevcut kapatma kararını ezmemesi için ON CONFLICT DO NOTHING.
INSERT INTO feature_flags (key, name, is_enabled) VALUES
    ('dashboard_basic', 'Temel Panel', true),
    ('map_basic', 'Temel Harita', true),
    ('historical_basic', 'Geçmiş Veri (Temel)', true),
    ('province_basic', 'İl Bazlı Görünüm (Temel)', true),
    ('model_catalog', 'Model Kataloğu', true),
    ('hp_segment_basic', 'Beygir Gücü Segmenti (Temel)', true),
    ('brand_summary', 'Marka Özeti', true),
    ('export_limited', 'Sınırlı Dışa Aktarma', true),
    ('competitor_analysis', 'Rakip Analizi', true),
    ('brand_compare', 'Marka Karşılaştırma', true),
    ('model_compare', 'Model Karşılaştırma', true),
    ('province_top_brand', 'İl Bazında En Çok Satan Marka', true),
    ('model_region_analysis', 'Model-Bölge Analizi', true),
    ('media_watch', 'Medya İzleme', true),
    ('export_basic', 'Dışa Aktarma', true),
    ('weather_data', 'Hava Durumu Verisi', true),
    ('tarmakbir_view', 'TarmakBir Görünümü', true),
    ('historical_extended', 'Geçmiş Veri (Genişletilmiş)', true),
    ('ai_insights_limited', 'Yapay Zeka İçgörüleri (Sınırlı)', true),
    ('ai_insights', 'Yapay Zeka İçgörüleri', true),
    ('ai_forecast', 'Yapay Zeka Tahmini', true),
    ('ai_brief', 'Yapay Zeka Özeti', true),
    ('automation_roadmap', 'Otomasyon Yol Haritası', true),
    ('whatsapp_query', 'WhatsApp Sorgulama', true),
    ('priority_support', 'Öncelikli Destek', true),
    ('api_access', 'API Erişimi', true),
    ('custom_reports', 'Özel Raporlar', true),
    ('scheduled_exports', 'Zamanlanmış Dışa Aktarma', true),
    ('historical_full', 'Geçmiş Veri (Tam)', true),
    ('unlimited_competitors', 'Sınırsız Rakip', true),
    ('province_diff_alerts', 'İl Bazlı Fark Uyarıları', true)
ON CONFLICT (key) DO NOTHING;

-- Yönetim denetim kaydı: her yönetici yazma işlemi burada izlenir.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,            -- ör. 'org.create', 'org.member.add', 'staff.role.set', 'feature.toggle'
    target_type VARCHAR(40),
    target_id VARCHAR(80),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
