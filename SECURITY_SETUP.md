# Güvenlik Kurulumu Kontrol Listesi

Üretim ortamına dağıtmadan önce aşağıdaki adımları tamamlayın:

## Gerekli Adımlar

- [ ] **PostgreSQL Şifresini Değiştir**: Railway veya Docker PostgreSQL örneğinin parolasını değiştir ve `POSTGRES_PASSWORD` çevre değişkenini güncelle
- [ ] **JWT_SECRET Oluştur**: `openssl rand -hex 48` ile yeni bir JWT_SECRET oluştur ve `.env` dosyasına ekle
- [ ] **SUPERUSER_EMAILS Ayarla**: `SUPERUSER_EMAILS` çevre değişkenine yönetici email adreslerini ayarla (virgülle ayrılmış)
- [ ] **CORS_ORIGINS Ayarla**: `CORS_ORIGINS` çevre değişkenine izin verilen domain'leri ayarla
- [ ] **Google OAuth Ayarla**: `GOOGLE_OAUTH_CLIENT_ID` çevre değişkenini Google Cloud Console'dan alınan ID ile güncelle
- [ ] **WhatsApp Entegrasyonunu Ayarla**: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` çevre değişkenlerini Meta Business Platform'dan alınan değerlerle güncelle
- [ ] **INSIGHTS_API_KEY Ayarla**: İç API anahtarı için `INSIGHTS_API_KEY` çevre değişkenini belirle

## Veritabanı Temizliği

- [ ] **Demo Hesaplarını Deaktive Et**: Üretim ortamında aşağıdaki SQL komutunu çalıştır:
```sql
UPDATE users SET is_active=false WHERE email LIKE 'demo@%';
```

## Git Geçmişi Temizliği

- [ ] **Açık Şifreler İçin Geçmiş Temizle**: `tmp/check_db.js` dosyası üretim veritabanı şifresini içeriyordu. Git geçmişinden kaldırmak için:
```bash
git filter-repo --invert-paths --path tmp/check_db.js
git push --force-with-lease
```
**Not**: `git filter-repo` tüm git geçmişini değiştirir ve force push gerektirir. Diğer geliştiricileri uyar.

## N8N Kimlik Bilgileri

- [ ] **N8N Şifrelerini Değiştir**: `N8N_BASIC_AUTH_PASSWORD` ve `N8N_ENCRYPTION_KEY` çevre değişkenlerini güvenli değerler ile güncelle
- [ ] **N8N Credential Store Kullan**: İş akışlarında kullanılan kimlik bilgileri (WhatsApp, API anahtarları) N8N'in yerleşik credential store'unda sakla (ortam değişkenlerinde değil)

## Ortam Değişkenleri

Tüm `CHANGE_ME` işaretlemelerini gerçek değerlerle değiştir:
- Ödeme sağlayıcı API anahtarları (Stripe, iyzico)
- AI sağlayıcı API anahtarları (OpenAI, Anthropic, MiniMax)
- Harici API anahtarları (Bing Search, Brave Search, OpenWeatherMap)

## Doğrulama

- [ ] Docker Compose'u test et: `docker compose config -q`
- [ ] Node.js sözdizimini kontrol et: `npm test`
- [ ] Tüm ortam değişkenleri ayarlanmış mı: `.env` dosyasını gözden geçir
