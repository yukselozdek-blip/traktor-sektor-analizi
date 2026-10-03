-- Google ile kayıt olan kullanıcıların şifresi yoktur (password_hash NULL yazılır).
-- 001_baseline'da alan NOT NULL olduğu için yeni Google kayıtları hata veriyordu.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
