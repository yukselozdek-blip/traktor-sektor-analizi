-- WhatsApp numara onayı: asistan yalnızca admin onaylı numaralara cevap verir.
-- admin_approved kolonu 002'de zaten vardı (DEFAULT false). Burada yalnızca red durumu eklenir.
-- KARAR: Mevcut kayıtlar ONAYSIZ sayılır (güvenli varsayılan); onaylı kalmasını isteyen
-- numaralar admin panelinden (Ayarlar > WhatsApp Numara Onayları) yeniden onaylanmalıdır.
ALTER TABLE whatsapp_phones ADD COLUMN IF NOT EXISTS admin_approved BOOLEAN DEFAULT false;
ALTER TABLE whatsapp_phones ADD COLUMN IF NOT EXISTS admin_approved_at TIMESTAMP;
ALTER TABLE whatsapp_phones ADD COLUMN IF NOT EXISTS admin_approved_by INTEGER REFERENCES users(id);
ALTER TABLE whatsapp_phones ADD COLUMN IF NOT EXISTS admin_rejected_at TIMESTAMP;
ALTER TABLE whatsapp_phones ADD COLUMN IF NOT EXISTS admin_rejected_by INTEGER REFERENCES users(id);
UPDATE whatsapp_phones SET admin_approved = false WHERE admin_approved IS NULL;
