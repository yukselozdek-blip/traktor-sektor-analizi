-- Davet kodları: marka sahteciliğini önlemek için kayıt (şifre ve Google) geçerli bir davet kodu ister.
-- Kod düz metin saklanmaz; yalnızca SHA-256 özeti (code_hash) ve son 4 karakter (code_hint) tutulur.
CREATE TABLE IF NOT EXISTS invite_codes (
    id SERIAL PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    code_hint VARCHAR(8) NOT NULL,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    plan_slug VARCHAR(100),
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_brand ON invite_codes(brand_id);

-- E-posta doğrulaması artık zorunlu. Bu kuraldan ÖNCE kayıt olmuş mevcut kullanıcılar kilitlenmesin diye
-- hepsi doğrulanmış sayılır (bir kez çalışır; yeni kayıtlar doğrulama bağlantısıyla doğrulanır).
UPDATE users SET email_verified = true WHERE email_verified IS NOT TRUE;
