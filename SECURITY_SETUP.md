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

## E-posta (SMTP) kurulumu

> **Railway Free/Hobby planı giden SMTP portlarını (25/465/587) engeller** (loglarda `ETIMEDOUT`). Bu durumda `BREVO_API_KEY` kullanın (Brevo → SMTP & API → API keys); mailler HTTPS ile gönderilir, `SMTP_*` değişkenleri gerekmez. `MAIL_FROM` yine zorunlu.

Şifre sıfırlama ve e-posta doğrulama mailleri SMTP ile gönderilir. **SMTP tanımlı değilse e-posta gönderilmez**: kullanıcı "Şifremi unuttum" dediğinde her zaman aynı genel mesajı görür ama mail ulaşmaz (sunucu ilk kullanımda tek bir uyarı loglar). Production'da `APP_BASE_URL` (örn. `https://alanadiniz.com`) de tanımlı olmalıdır; aksi halde mail içindeki bağlantı üretilemez.

Gerekli ortam değişkenleri: `SMTP_HOST`, `SMTP_PORT` (varsayılan 587), `SMTP_SECURE` (465 için `true`), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

| Sağlayıcı | SMTP_HOST | Port | Kullanıcı / Şifre |
|---|---|---|---|
| Brevo | `smtp-relay.brevo.com` | 587 | Brevo SMTP login / SMTP anahtarı |
| Resend | `smtp.resend.com` | 465 (`SMTP_SECURE=true`) veya 587 | Kullanıcı `resend`, şifre API anahtarı |
| Mailgun | `smtp.mailgun.org` (AB: `smtp.eu.mailgun.org`) | 587 | `postmaster@alanadiniz` / SMTP şifresi |
| Amazon SES | `email-smtp.<bölge>.amazonaws.com` | 587 | SES SMTP kimlik bilgileri (IAM'den ayrı üretilir) |

Teslim edilebilirlik: `MAIL_FROM` adresinin alan adı için sağlayıcının verdiği **SPF** ve **DKIM** (mümkünse DMARC) DNS kayıtlarını ekleyin; aksi halde mailler spam'e düşer veya reddedilir. Şifre sıfırlama bağlantısı 30 dakika geçerli ve tek kullanımlıktır; token veritabanında yalnızca sha256 özeti olarak saklanır.

## Doğrulama

- [ ] Docker Compose'u test et: `docker compose config -q`
- [ ] Node.js sözdizimini kontrol et: `npm test`
- [ ] Tüm ortam değişkenleri ayarlanmış mı: `.env` dosyasını gözden geçir

## Cloudflare proxy (turuncu bulut) ve ana alan adı yönlendirmesi

Railway ortam değişkenleri:

| Değişken | Değer | Amaç |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` (varsayılan) → Cloudflare proxy açılınca `2` | `req.ip` ve hız sınırlarının gerçek istemci IP'sini görmesi |
| `REDIRECT_HOSTS` | `tarimtraktor.com,www.tarimtraktor.com` | Bu alan adlarına gelen istekler `APP_BASE_URL`'e 301 ile yönlenir (`/health` hariç) |

Cloudflare'i "Yalnızca DNS"ten "Proxied"a geçirme sırası: (1) `TRUST_PROXY_HOPS=2` ayarla ve deploy et,
(2) Cloudflare'de SSL modunu **Full (strict)** yap, (3) kaydı turuncu buluta çevir,
(4) giriş denemesi sınırının tek bir IP'ye (Cloudflare) düşmediğini logdan doğrula.
Apex/www için Railway'e özel alan adı olarak da eklenmelidir (aksi halde yönlendirme çalışmaz).

## Bağımlılık güvenliği (npm audit)

- `axios`, `form-data`, `path-to-regexp`, `body-parser` güncellendi; kullanılmayan `node-cron` kaldırıldı; `qs` için `overrides` ile güvenli sürüm (6.16.0) zorlandı. Üretim bağımlılıklarında `npm audit` yalnızca `xlsx` için uyarı verir.
- **Kabul edilen risk: `xlsx@0.18.5`** (prototype pollution, ReDoS; npm'de düzeltilmiş sürüm yok, düzeltme yalnızca SheetJS CDN paketinde `0.20.x`). Yalnızca `import-tuik.js` kullanır ve depodaki sabit dosyayı (`EXCEL_PATH`) okur; kullanıcıdan Excel yüklenmez. **Kullanıcı Excel yüklemesi eklenirse önce `xlsx`'i `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` ile yükseltin.**

## Oturum, CSP ve ödeme güvenliği (Ekim 2026)

**Oturum:** Tarayıcı oturumu `tk_session` adlı **httpOnly, SameSite=Lax, Secure (HTTPS)** çerezindedir; JavaScript okuyamaz
(XSS ile çalınamaz). API istemcileri (n8n vb.) `Authorization: Bearer` kullanmaya devam eder. Çerezle gelen değiştirici
isteklerde (POST/PUT/PATCH/DELETE) CSRF koruması: `X-Requested-With: XMLHttpRequest` + eşleşen `Origin`. Kullanıcı
pasife alınırsa/rolü değişirse en geç 60 sn içinde etkili olur (JWT'deki rol değil DB'deki rol esastır).

**Üretim tespiti:** `NODE_ENV=production` **veya** Railway'in kendi ortam değişkenleri (`RAILWAY_ENVIRONMENT*`,
`RAILWAY_PROJECT_ID`). Üretimde: mock ödeme kapalı, ayrıntılı hata mesajları kapalı, Secure çerez, WhatsApp webhook imzası zorunlu.
Yine de Railway'de `NODE_ENV=production` tanımlamanız önerilir.

**CSP:** Zorunlu. Betikler yalnızca kendi sunucumuzdan (`/vendor/*`: Chart.js, Leaflet, DOMPurify, Font Awesome, yazı tipleri) ve
Google ile giriş için `accounts.google.com`. Acil geri alma: `CSP_MODE=report` (yalnızca raporla) ya da `CSP_MODE=off`.
`'unsafe-inline'` hâlâ açık (satır içi `onclick=` yöneticileri nedeniyle); kalıcı çözüm olay yöneticilerini `addEventListener`'a taşımaktır.

**Ödeme:** Abonelik yalnızca imzalı sağlayıcı webhook'u ile aktive edilir. Sahte (MOCK) ödeme yalnızca geliştirmede veya
`ALLOW_MOCK_BILLING=1` ile çalışır. Stripe/iyzico anahtarları tanımlı değilse üretimde kart ödemesi `503` döner; banka havalesi (admin onaylı) çalışır.

**WhatsApp:** Üretimde `WHATSAPP_APP_SECRET` ve `WHATSAPP_VERIFY_TOKEN` tanımlı olmalıdır; aksi hâlde webhook istekleri reddedilir.

**Tarayıcı denetimleri:** `e2e/README.md` (XSS taraması, erişilebilirlik, marka kontrastı, mobil taşma).

## Davet kodu, e-posta doğrulaması ve WhatsApp onayı (ilk kurulum sonrası)

- Kayıt **davet kodu** ister: ilk kodları yönetici olarak Ayarlar → Davet Kodları'ndan (API: `POST /api/admin/invites`) oluşturun. Kod yalnızca oluşturulurken bir kez gösterilir; veritabanında yalnızca özeti saklanır.
- **E-posta doğrulaması zorunludur**: e-posta gönderimi (Brevo veya SMTP, yukarıdaki bölüm) ve `APP_BASE_URL` tanımlı olmalıdır; aksi halde yeni kullanıcılar giriş yapamaz. Önceden kayıtlı kullanıcılar migration ile doğrulanmış sayıldı.
- WhatsApp asistanı yalnızca **admin onaylı** numaralara cevap verir; mevcut numaralar migration sonrası onaysızdır. Yönetici onayı: `GET/POST /api/admin/whatsapp-phones...` (arayüz: Ayarlar).
- Ayrıntılı kurallar ve yeni özellik kontrol listesi: `skills/guvenlik-anayasasi/SKILL.md`.
