-- İki adımlı doğrulama (TOTP). Secret AES-256-GCM ile şifreli saklanır; kurtarma kodları yalnızca SHA-256 hash olarak.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;
