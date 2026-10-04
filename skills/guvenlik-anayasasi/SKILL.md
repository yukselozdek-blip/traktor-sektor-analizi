---
name: Güvenlik Anayasası
description: Traktör Sektör Analizi platformunun güvenlik kuralları için tek doğru kaynak. Oturum/çerez/CSRF/JWT, authMiddleware, üretim tespiti (isProduction), CSP ve güvenlik başlıkları, XSS ve çıktı kaçışı (escapeHtml/safeHref), girdi doğrulama, text-to-SQL koruması (sql-guard), SSRF, ödeme/webhook güvenliği, WhatsApp webhook ve onaylı numara kapısı, hız sınırları/DoS, sırlar, bağımlılıklar ve IDOR (marka kapsamı) konularında herhangi bir kod yazılmadan, değiştirilmeden veya gözden geçirilmeden ÖNCE okunur. Yeni endpoint, auth/oturum değişikliği, ödeme akışı, webhook, SQL üreten kod, innerHTML basan ön yüz kodu, env değişkeni veya ham kullanıcı verisi işleyen her iş bu belgeye tabidir. Sonunda yeni özellik için işaretlenebilir güvenlik kontrol listesi vardır.
---

# GÜVENLİK ANAYASASI

> Bu doküman platformun **güvenlik katmanının** tek doğru kaynağıdır. Ekim 2026 sertleştirme döneminde (bkz. `CHANGELOG.md`, PR #24) bağımsız denetim bulguları kapatıldı; aşağıdaki kurallar o bulguların tekrar açılmasını önler. Her kural kodda doğrulanmıştır; kural ile kod çelişirse **önce kod okunur, sonra bu belge düzeltilir**.

İlgili eş anayasalar:
- `../kimlik-dogrulama-anayasasi/SKILL.md` (kayıt, giriş, davet kodu, e-posta doğrulaması)
- `../abonelik-odeme-anayasasi/SKILL.md` (abonelik, kota, ödeme akışı)
- `../stratejikplan-whatsapp-sales-assistant/SKILL.md` (WhatsApp asistanı)
- `../medya-takip-anayasasi/SKILL.md` (medya takip marka kapsamı)
- `../kalite-ve-ajan-koordinasyon-anayasasi/SKILL.md` (test, CI, ajan işleri)
- `../erisilebilirlik-tasarim-anayasasi/SKILL.md` (ön yüz kuralları)
- Kurulum/ortam: `../../SECURITY_SETUP.md`

---

## 1. OTURUM MODELİ

| Konu | Kural | Kod |
|------|-------|-----|
| Tarayıcı oturumu | `tk_session` çerezi: `HttpOnly; SameSite=Lax; Path=/; Max-Age=7 gün`, HTTPS'te `Secure` | `src/lib/session.js` (`setSessionCookie`) |
| Token yeri | Tarayıcı JS'i token'ı **göremez**; `localStorage`'a anahtar YAZILMAZ | `e2e/auth-flow.js` bunu denetler |
| Web istemcisi | `X-Web-Session: 1` başlığı olan giriş/kayıt/Google yanıtında `token` gövdeden çıkarılır (`session: true` döner) | `server.js` (oturum çerezi ara katmanı) |
| API istemcileri | `Authorization: Bearer <jwt>` kullanmaya devam eder; gövdede token alır; CSRF başlığı gerekmez | `getRequestToken` (Bearer önceliklidir) |
| Çıkış | `POST /api/auth/logout` çerezi siler | `server.js` |
| JWT | HS256 **pin'li** (`jwt.verify(..., { algorithms: ['HS256'] })`), ömür `7d`, payload `{ id, email, role, brand_id, sup }` | `issueAuthToken` (server.js), `src/middleware/auth.js` |
| Çerez veren yollar | Yalnızca `/api/auth/login`, `/api/auth/signup`, `/api/auth/google` ve **yalnızca 2xx + `body.token` varsa** (kayıt token döndürmez → çerez de vermez) | `SESSION_ISSUING` (server.js) |

### 1.1 CSRF
Çerezle kimlik doğrulanan **değiştirici** istekler (POST/PUT/PATCH/DELETE) için `csrfOk` (`src/lib/session.js`):
1. `X-Requested-With: XMLHttpRequest` başlığı ZORUNLU (yoksa 403 `İstek doğrulanamadı (CSRF)`).
2. `Origin` varsa `CORS_ORIGINS` + `APP_BASE_URL` kümesinde ya da istek `Host`'uyla aynı olmalı.
3. Çerez zaten `SameSite=Lax`.
- Yeni ön yüz `fetch`'i çerezle değiştirici istek atıyorsa `X-Requested-With` başlığını `public/api_v3.js` üzerinden gönderir; yeni bir sarmalayıcı yazılırsa bu başlık unutulmaz.
- Bearer isteklerinde CSRF kontrolü yoktur (tarayıcı otomatik göndermez).

### 1.2 `authMiddleware` her istekte DB'den okur
`src/middleware/auth.js` → `getAuthState(userId)`: `password_changed_at`, `is_active`, `role`, `brand_id`, `is_superuser` alanlarını DB'den okur ve **60 sn** (`PWD_CHANGED_TTL_MS`) bellek içi önbellekler (en fazla 10000 kayıt).
- Token'daki `role`/`brand_id`/`sup` iddiaları **yok sayılır**; DB değerleri `req.user`'a yazılır. Pasife alınan veya silinen kullanıcı en geç ~60 sn içinde 401 alır; rolü düşürülen kullanıcı aynı sürede etkilenir.
- Şifre değişiminden önce üretilmiş token (`payload.iat < password_changed_at`) reddedilir. Şifre sıfırlama/Google bağlama bu önbelleği `invalidatePasswordChangedCache` ile temizler.
- **Fail-closed:** Kullanıcı durumu (aktiflik/rol/şifre-değişim) DB'den okunamazsa `authMiddleware` 503 döner; JWT imzasına tek başına güvenilmez (`tests/auth-matrix.test.js`).
- Çoklu replikada önbellek süreç içidir; gecikme en fazla TTL kadardır.
- `adminOnly` ayrıca her istekte DB'den `role='admin'` ve `is_active` doğrular.
- Yeni kimlik doğrulamalı rota **mutlaka** `authMiddleware` ile başlar; yönetici rotaları `authMiddleware, adminOnly`. `tests/auth-matrix.test.js` rota envanteri anlık görüntüsünden bunu otomatik denetler.

### 1.3 CORS
`CORS_ORIGINS` (virgülle ayrılmış) + `APP_BASE_URL` dışındaki origin'e `Access-Control-Allow-Origin` verilmez. `Origin` başlığı olmayan istekler (sunucu-sunucu) geçer.

---

## 2. ÜRETİM TESPİTİ

`src/lib/env.js` → `isProduction()`: `NODE_ENV === 'production'` **veya** Railway'in kendi değişkenlerinden biri (`RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_PROJECT_ID`). Dockerfile `NODE_ENV` ayarlamadığı için yalnızca `NODE_ENV`'e güvenmek, unutulduğunda üretimi geliştirme gibi çalıştırırdı. **Yeni kodda `process.env.NODE_ENV === 'production'` yazılmaz; `isProduction()` (veya `config.IS_PRODUCTION`) kullanılır.**

Üretimde (`isProduction() === true`):

| Alan | Davranış | Kod |
|------|----------|-----|
| Sahte (MOCK) ödeme | **Kapalı** (`503`); yalnızca `ALLOW_MOCK_BILLING=1` ile açılır | `src/routes/billing.js` (`MOCK_BILLING_ALLOWED`) |
| `/billing/success` | Hiçbir koşulda abonelik aktive etmez (yalnızca `/?page=subscription&billing=processing`'e yönlendirir) | `src/routes/billing.js` |
| Mock webhook | Stripe/iyzico mock modda üretimde reddedilir | `billing/providers.js` (`verifyWebhook`) |
| Hata mesajı | `errMsg()` ayrıntı yerine `Sunucu hatası` döner | `src/config.js` |
| Çerez | `Secure` her zaman | `isSecureRequest` |
| CSP | `upgrade-insecure-requests` eklenir | `server.js` (`cspDirectives`) |
| WhatsApp webhook | `WHATSAPP_APP_SECRET` yoksa POST `503` | `src/routes/public.js` |
| Doğrulama token'ı | Kayıt yanıtında `verify_token_dev` **dönmez** | `src/routes/signup-google.js` |
| Mail bağlantıları | Yalnızca `APP_BASE_URL`'den üretilir (`Host` başlığına güvenilmez) | `src/lib/app-url.js` |
| `JWT_SECRET` yoksa | Rastgele geçici anahtar + yüksek sesli uyarı (her yeniden başlatmada oturumlar düşer) | `src/config.js` |

Not: `src/db.js` (DB SSL) ve minify servisi (`server.js`) hâlâ doğrudan `NODE_ENV === 'production'` okur; Railway'de **`NODE_ENV=production` yine de tanımlanmalıdır**.

---

## 3. İÇERİK GÜVENLİK POLİTİKASI (CSP) VE BAŞLIKLAR

`server.js` içinde helmet ile **zorunlu** (`CSP_MODE` varsayılan `enforce`):

| Yönerge | Değer |
|---------|-------|
| `default-src` | `'self'` |
| `script-src` | `'self' 'unsafe-inline' https://accounts.google.com/gsi/client` |
| `style-src` | `'self' 'unsafe-inline' https://accounts.google.com/gsi/style` |
| `img-src` | `'self' data: blob: https:` |
| `font-src` | `'self' data:` |
| `connect-src` | `'self' https://accounts.google.com` |
| `frame-src` | `https://accounts.google.com` |
| `object-src` | `'none'` |
| `base-uri` / `form-action` | `'self'` |
| `frame-ancestors` | `'none'` |

- Ek: `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`; `Cross-Origin-Opener-Policy: same-origin-allow-popups` (Google penceresi için); `Cross-Origin-Embedder-Policy` kapalı.
- **Üçüncü taraf kütüphane/yazı tipi CDN'den YÜKLENMEZ.** Chart.js, datalabels, DOMPurify, Leaflet, Font Awesome ve yazı tipleri `public/vendor/` altındadır (`public/vendor/README.md` sürüm tablosu; `/vendor/` 7 gün önbellek). Yeni kütüphane: `npm i` → dosyayı `public/vendor/`'a kopyala → README tablosuna sürümü yaz. `<script src="https://...">` (Google GSI hariç) EKLENMEZ; `tests/security-headers.test.js` bunu denetler.
- **Acil geri alma:** Railway'de `CSP_MODE=report` (yalnızca raporla, engelleme) veya `CSP_MODE=off`. Sorun çözülünce kaldırılır (varsayılan `enforce`).
- **Satır içi olay yöneticisi YASAĞI (hedef kural):** Yeni kodda `onclick="..."`, `onchange="..."` gibi satır içi olay yöneticileri YAZILMAZ; `addEventListener` ve `data-*` öznitelikleri kullanılır. Gerekçe: bu yöneticiler `'unsafe-inline'` bağımlılığının tek nedenidir; her yeni satır içi yönetici CSP'yi sıkılaştırmayı zorlaştırır.

<!-- CSP-DURUMU: koordinatör güncelleyecek -->

Belge yazılırken doğrulanan durum (**eskimiş olabilir; satır içi yöneticilerin kaldırılması ve CSP sıkılaştırması sürüyorsa koordinatör yukarıdaki işaretçiyi günceller, önce `server.js` `cspDirectives` ve `grep -c 'onclick=' public/*` ile kontrol edin**): `script-src` ve `style-src` hâlâ `'unsafe-inline'` içerir; `public/app_v3.js` içinde ~52, `public/index.html` içinde ~37 `onclick=` bulunur. `public/a11y.js` bu yöneticilere dayanır (bkz. erişilebilirlik anayasası).

---

## 4. GİRDİ DOĞRULAMA VE ÇIKTI KAÇIŞI (XSS)

**Asıl koruma çıktı kaçışıdır; girdi doğrulaması savunma derinliğidir.**

### 4.1 Ön yüz kuralı (KESİN YASAK)
Kullanıcı veya veritabanı kaynaklı HİÇBİR değer `innerHTML`/şablon dizgesi ile **kaçışsız** basılmaz. Marka adı, il, model, firma adı, etiket, başlık, haber/medya alanları, URL'ler, AI çıktısı dahil.

`public/app_v3.js` yardımcıları:
| Yardımcı | Kullanım |
|----------|----------|
| `escapeHtml(v)` | Metin düğümü ve tırnaklı öznitelik değerleri |
| `safeHref(v)` | `href`/`src`: `http(s):`, `data:image/` ve göreli URL'lere izin verir; `javascript:` vb. → `#` (çıktı zaten kaçışlıdır) |
| `jsArg(v)` | Satır içi yönetici argümanı (yeni kodda satır içi yönetici yazılmadığı için nadiren gerekir) |
| `mdToHtml(md)` | Önce `escapeHtml`, sonra yalnızca üretilen etiketler; `DOMPurify` ile (izinli etiket listesi, yalnızca `https?:` bağlantı) temizlenir |

- Kaçış gerekmeyen tek durum: `textContent`/`value` atamasıdır (tercih edilir).
- Sunucu tarafı HTML üreten kod (rapor, e-posta, `/billing/bank-info`) kendi kaçışını kullanır: `escapeHtml` (server.js rapor üreticileri), `escapeMailHtml` (e-posta), `escHtml` (`src/routes/billing.js`). Sorgu parametresi HTML'e kaçışsız yazılmaz.
- Doğrulama: `npm run e2e:xss` (bkz. `e2e/README.md`) zehirli veriyle tüm sayfaları gezer; çalışan betik = hata.

### 4.2 Sunucu girdi doğrulaması (`src/lib/validate.js`)
- `validateProfileText(body, fields)`: profil alanlarında `<` `>` yasak, uzunluk sınırları `MAX_LEN` (ör. `full_name` 120, `company_name` 160, `phone` 20, `city` 80).
- `SAFE_EMAIL` sıkı e-posta deseni; e-posta uzunluğu ≤ 254.
- Kullanıcı kaynaklı yeni serbest metin alanı eklenirse `MAX_LEN`'e eklenir ve ilgili rota `validateProfileText` çağırır. Şifre politikası `config.PASSWORD_POLICY` (kimlik anayasası §2).
- Tip kontrolü: gövde alanları `typeof` ile doğrulanır (dizi/nesne beklenmedik gelirse 500 değil 400 dönmeli).

---

## 5. SQL GÜVENLİĞİ

1. **Her zaman parametrik sorgu** (`$1, $2, ANY($3::int[])`). Kullanıcı girdisi SQL dizgesine yapıştırılmaz. Dinamik tablo/sütun gerekiyorsa sabit allow-list ile seçilir.
2. **Text-to-SQL (WhatsApp/asistan)**: LLM'in ürettiği SQL yalnızca `src/lib/sql-guard.js` → `isSafeSql` geçerse çalışır:
   - Tek ifade, yorum/`"`/`$`/`\` yok; yalnızca `SELECT`/`WITH`; yazma/DDL/`SET`/`COPY` vb. anahtar sözcükler yasak.
   - **Tablo allow-list'i** (`SQL_ALLOWED_TABLES`): `sales_view, sales_data, brands, provinces, tractor_models, teknik_veri, tuik_veri, market_share`; `users`, ödeme, abonelik, `auth_audit`, `pg_*`, `information_schema` vb. `SQL_DENY_PATTERN` ile reddedilir.
   - **Fonksiyon allow-list'i** (`SQL_ALLOWED_FUNCTIONS`): listede olmayan her `ad(` çağrısı reddedilir (ör. `query_to_xml`, `repeat`, `current_schema`). Yeni meşru fonksiyon gerekirse listeye eklenir ve `tests/sql-guard.test.js`'e test yazılır.
   - `FROM (` yalnızca alt sorgu olabilir; `CROSS JOIN` yasak; en fazla 6 `JOIN` (DoS).
   - Çalıştırma: `executeSafeSql` (server.js) → ayrı client, `BEGIN` + `SET TRANSACTION READ ONLY` + `SET LOCAL statement_timeout = 8000` + `ROLLBACK`.
3. `isSafeSql` gevşetilmez; şüphede reddet. Her gevşetme/ekleme sql-guard testiyle gelir.

---

## 6. SSRF

Sunucunun kullanıcı/DB kaynaklı bir URL'ye istek attığı her yerde `src/lib/validate.js` → `isPrivateHost(hostname)` ile hedef denetlenir (localhost, `.local/.internal/.lan/.home`, tek etiketli iç adlar, `10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10`, `>=224`, IPv6 loopback/ULA/link-local/`::ffff:`, ondalık/hex IP biçimleri). Mevcut kullanım: `src/routes/models.js` (kaynak/görsel URL'leri).
- `isPrivateHost` **ad çözümlemesi yapmaz** (yalnızca açık kalıplar); DNS rebinding'e karşı ek koruma gerekiyorsa ürün kararıdır.
- Yalnızca `http:`/`https:` şemaları kabul edilir; yönlendirme (redirect) takibi dikkatle ele alınır.

---

## 7. ÖDEME GÜVENLİĞİ

Ayrıntı: `../abonelik-odeme-anayasasi/SKILL.md`. Güvenlik açısından değişmez kurallar:
1. **Abonelik YALNIZCA** imzalı sağlayıcı webhook'u (`/api/billing/webhook/stripe`, `/api/billing/webhook/iyzico`) **veya** admin onaylı banka havalesi (`/api/billing/bank-confirm`, `adminOnly`) ile `active` olur.
2. `/billing/success` ASLA sorgu parametresine (plan/dönem) güvenerek aktive etmez. Yalnızca mock akışta (geliştirme veya `ALLOW_MOCK_BILLING=1`) ve yalnızca oturumdaki kullanıcının **kendi bekleyen** ödemesi için çalışır; plan/dönem ödeme kaydından okunur.
3. Mock sağlayıcı üretimde `503` verir. `ALLOW_MOCK_BILLING=1` üretimde yalnızca bilinçli, geçici test içindir; sonra kaldırılır.
4. Webhook imzası zorunlu: Stripe `STRIPE_WEBHOOK_SECRET` (zaman damgası + HMAC-SHA256), iyzico `IYZICO_SECRET_KEY` HMAC; karşılaştırma `timingSafeEqual`. Anahtar tanımsızsa üretimde mock webhook reddedilir.
5. Banka bilgisi sayfası (`/billing/bank-info`) tüm parametreleri kaçışlar.

---

## 8. WHATSAPP

Ayrıntı: `../stratejikplan-whatsapp-sales-assistant/SKILL.md`.
- **İmza zorunlu:** `POST /api/public/whatsapp/webhook` → `X-Hub-Signature-256` HMAC-SHA256 (`WHATSAPP_APP_SECRET`, ham gövde `req.rawBody` üzerinden), `safeEqualStr`. Üretimde `WHATSAPP_APP_SECRET` yoksa `503`. Geliştirmede yoksa uyarı loglanır ve imza atlanır.
- **GET doğrulaması:** `WHATSAPP_VERIFY_TOKEN` boşsa hiçbir istek eşleşmez (403); challenge düz metin (`text/plain`, ≤ 200 karakter).
- **Dahili sorgu:** `POST /api/public/assistant/sales-query` → `x-query-token` = `WHATSAPP_QUERY_API_KEY` (tanımsızsa `503`, yanlışsa `401`); `question` metin ve ≤ 1000 karakter.
- **Onaylı numara kapısı:** `src/lib/whatsapp-approval.js` → `checkWhatsappAuthorization`. Numara kayıtlı + `admin_approved` + telefon aktif + kullanıcı aktif + e-postası doğrulanmış + (admin değilse) aktif abonelikte `whatsapp_phones` limiti > 0 olmalı; aksi halde LLM/SQL zinciri **çalıştırılmaz** (webhook sessizce yok sayar, sales-query `403`).
- **PII:** Loglarda telefon numarası ve mesaj metni YOKTUR; yalnızca `last4(from)` ve uzunluk/neden kodu. Yönetici listesinde `maskPhone` (`phone_masked`). Yeni log satırı numara/mesaj yazmaz.
- Numara ekleyen kullanıcı `approval: 'pending'` alır; admin onayı olmadan cevap alamaz.

---

## 9. KİMLİK (ÖZET)

Ayrıntı: `../kimlik-dogrulama-anayasasi/SKILL.md`.
- **Davet kodu zorunlu kayıt:** `src/lib/invites.js`; kod düz metin saklanmaz (SHA-256), tüketim tek atomik `UPDATE`, kayıt transaction'ında (kayıt başarısız olursa kod harcanmaz). Hata mesajı tek ve genel (`INVITE_ERROR`).
- **E-posta doğrulaması zorunlu:** doğrulanmamış kullanıcı giriş yapamaz (şifre doğruysa `403 EMAIL_NOT_VERIFIED`; yanlış şifrede 401 → numaralandırma yok). Süper kullanıcı e-postaları muaf. Kayıt oturum/çerez/token VERMEZ.
- **Genel 401:** bilinmeyen e-posta, yanlış şifre ve kilitli hesap aynı gövdeyi döner (`LOGIN_FAIL_MESSAGE`); kalan deneme sayısı sızdırılmaz. Kilitliyse yalnızca `Retry-After` başlığı eklenir.
- **Zamanlama eşitleme:** olmayan kullanıcıda bile `bcrypt.compare` sahte hash ile çalıştırılır (`DUMMY_PASSWORD_HASH`).
- **Google bağlama:** mevcut e-postası **doğrulanmamış** şifreli hesap Google'a bağlanırsa parola SİLİNİR ve eski oturumlar geçersiz kılınır (ön-ele-geçirme koruması); Google girişi şifre deneme sayaçlarını sıfırlamaz; pasif hesap Google ile de giremez. Google doğrulaması `GOOGLE_OAUTH_CLIENT_ID` `aud` eşleşmesi ister (tanımsızsa Google girişi `503`).
- Süper kullanıcı e-postasıyla **şifreli kayıt** otomatik yetki ALMAZ (normal doğrulama akışı).
- Şifre sıfırlama: token DB'de yalnızca sha256 özeti, 30 dk, tek kullanımlık (bkz. `SECURITY_SETUP.md`).

---

## 10. HIZ SINIRLARI VE DoS

| Kontrol | Değer | Kod |
|---------|-------|-----|
| Genel API (`/api/`) | IP başına 600 / 60 sn (`API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS`) | `server.js` |
| Giriş ve Google girişi | 15 / 5 dk (`LOGIN_LIMITER`) | `src/middleware/limiters.js` |
| Kayıt | 5 / saat (`SIGNUP_LIMITER`) | aynı |
| Şifremi unuttum | 5 / saat (`FORGOT_LIMITER`) | aynı |
| Doğrulama e-postası yeniden gönder | 5 / saat (`RESEND_LIMITER`) + hesap başına 60 sn bekleme | aynı, `src/routes/invites.js` |
| Şifre sıfırlama doğrula/uygula | 30 / 15 dk (`RESET_LIMITER`) | aynı |
| Hesap kilidi | 5 başarısız giriş → 15 dk | `server.js` login |
| JSON gövde | varsayılan **1mb**; yalnızca `/api/media-watch/ingest`, `/api/model-intelligence/gallery-callback`, `/api/insights` (POST) için 10mb; Stripe webhook ham gövde 1mb | `server.js` |
| `/api/ai/analyze` (`src/routes/ai-analyze.js`) | `type` ≤ 64 karakter, `context` nesne ve ≤ 20000 karakter, serbest metin alanları ≤ 2000 karakter; dizi bekleyen alanlar doğrulanır (400, 500 değil) | `ai-analyze.js` |
| sales-query | `question` ≤ 1000 karakter | `src/routes/public.js` |
| Text-to-SQL | 8 sn `statement_timeout`, ≤ 6 JOIN | `executeSafeSql`, `sql-guard.js` |
| DB | `PG_STATEMENT_TIMEOUT_MS` (varsayılan 120000) | `src/db.js` |
| AI kotası | atomik, fail-closed (bkz. abonelik anayasası) | `requireAiQuota` |

Yeni "büyük gövde" gereksinimi `LARGE_JSON_PATHS`'e **bilinçli** eklenir (varsayılan 1mb korunur). Proxy: `TRUST_PROXY_HOPS` yanlışsa hız sınırları tek IP'ye düşer/aldatılır (bkz. `SECURITY_SETUP.md` Cloudflare bölümü).

---

## 11. SIRLAR

- Sır (anahtar, token, parola, bağlantı dizesi) **asla** depoya, skill belgesine, test dosyasına (test sabitleri hariç), logda veya hata yanıtına yazılmaz. Yalnızca Railway/GitHub Secrets.
- Okunan sırlar (kodda doğrulandı): `JWT_SECRET`, `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_QUERY_API_KEY`, `MEDIA_WATCH_WEBHOOK_KEY` (yoksa `WHATSAPP_QUERY_API_KEY`), `INSIGHTS_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `GROQ_API_KEY`, `MINIMAX_API_KEY`, `BREVO_API_KEY`, `SMTP_*`.
- Sır karşılaştırması sabit zamanlı yapılır: `config.safeEqualStr` (`timingSafeEqual`). `===` ile sır karşılaştırılmaz. Boş yapılandırılmış sır, boş istekle eşleşmemelidir (503/403).
- Yeni env değişkeni eklenince `SECURITY_SETUP.md` ve `traktor_anayasasi` ortam tablosu güncellenir.
- Kurulum kontrol listesi: `../../SECURITY_SETUP.md` (demo hesaplar, git geçmişi temizliği, n8n kimlik bilgileri).

---

## 12. BAĞIMLILIK GÜVENLİĞİ

- `npm audit` düzenli çalıştırılır; üretim bağımlılıklarında yalnızca `xlsx` için uyarı bekleniyor.
- **Kabul edilen risk: `xlsx@0.18.5`** (prototype pollution, ReDoS; npm'de düzeltilmiş sürüm yok). Yalnızca `import-tuik.js` depodaki sabit dosyayı okur. **Kullanıcıdan Excel yüklemesi eklenirse ÖNCE** `xlsx` `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` ile yükseltilir (`SECURITY_SETUP.md`).
- `qs` için `package.json` `overrides` ile güvenli sürüm zorlanır; kullanılmayan paketler (ör. `node-cron`) kaldırılır.

---

## 13. IDOR KURALI (MARKA KAPSAMI)

**Marka kullanıcısı (`brand_user`) yalnızca KENDİ markasının verisini okuyabilir/değiştirebilir.** İstekten gelen `brand_id`/kayıt `id` yetki kaynağı değildir.

Kalıp (`resolveMediaWatchScopedBrandId`, `server.js`):
```js
// admin: istenen brand_id'yi kullanabilir; diğerleri: DAİMA kendi req.user.brand_id'si (DB'den gelir)
function resolveMediaWatchScopedBrandId(req, requestedBrandId = null) {
    if (req.user?.role === 'admin') return requestedBrandId ? parseInt(requestedBrandId, 10) : null;
    return parseInt(req.user?.brand_id || 0, 10) || null;
}
```
- Tek kayıt uçlarında (örn. `/api/media-watch/translate`) sahiplik SQL'de denetlenir: `WHERE id = $1 AND brand_id = $2`; başkasının kaydı **404** gibi davranır.
- Marka kapsamlı yeni her liste/özet/istatistik rotası bu kalıbı (veya eşdeğerini) kullanır. `brand_id` boş kalıp tüm markaları döndürmesi yalnızca admin için olabilir.
- Kullanıcıya ait kaynaklar (`whatsapp_phones`, ödemeler, abonelik) `user_id = req.user.id` ile sınırlanır (`DELETE ... WHERE id = $1 AND user_id = $2`).

---

## 14. GÜVENLİK REGRESYON TESTLERİ — HANGİ DOSYA NEYİ KORUR

DB gerektiren testler `TEST_DATABASE_URL` yoksa `SKIP` olur; **güvenlik değişikliği DB'li çalıştırılmadan doğrulanmış sayılmaz** (bkz. kalite anayasası).

| Test dosyası | Korudukları |
|--------------|-------------|
| `tests/session-cookie.test.js` | httpOnly+SameSite çerez, `X-Web-Session` gövdeden token çıkarma, CSRF (başlık/Origin), Bearer muafiyeti, çıkış, bozuk çerez |
| `tests/auth-matrix.test.js` | Rota envanterindeki her `authMiddleware` rotası anonime 401, `adminOnly` rotası brand_user'a 403, DB'de olmayan/pasif kullanıcı token'ı, rolün DB'den okunması |
| `tests/security.test.js` | Temel: admin rotaları, giriş kilidi/genel 401, CORS, yabancı JWT, pasif admin, Stripe/WhatsApp webhook imzası, `sales-query` 503 |
| `tests/security-regressions.test.js` | `isProduction`, WhatsApp GET boş token, media-watch IDOR (coverage/translate), admin kullanıcı oluşturma doğrulaması, deneme sayısı sızıntısı, üretimde `WHATSAPP_APP_SECRET` yoksa 503 |
| `tests/security-headers.test.js` | CSP zorunlu mod, CDN betiği/stili yok, `/vendor/` sunumu ve önbellek |
| `tests/input-validation.test.js` | `SAFE_EMAIL`, `validateProfileText`, `isPrivateHost` (SSRF), kayıt girdi doğrulaması |
| `tests/sql-guard.test.js` | `isSafeSql` (yazma/DDL, çoklu ifade, hassas tablo, fonksiyon/parantezli birleşim atlatmaları, meşru sorgular) |
| `tests/dos-limits.test.js` | JSON 1mb/10mb, ai-analyze 400'leri, sales-query sınırı, giriş genel 401, zamanlama eşitleme (statik) |
| `tests/billing-security.test.js` | `/billing/success` ödemesiz aktivasyon yok, başkasının `session_id`'si, üretimde mock 503, bank-info XSS |
| `tests/subscription-limits.test.js` | Yalnızca active/trialing + süresi dolmamış abonelik yetki verir |
| `tests/billing-plan-change.test.js`, `tests/billing-change-plan.test.js` | Plan değişiminde mevcut erişim korunur; change-plan checkout'a delege |
| `tests/ai-quota.test.js` | Atomik kota, 429/402/503, iade, fail-closed |
| `tests/invite-codes.test.js` | Davet kodu: tek kullanım, yarış, hash'li saklama, marka uyuşmazlığı, admin API |
| `tests/email-verification.test.js` | Doğrulama zorunlu giriş, token ömrü/tek kullanım, resend genel yanıt ve limit |
| `tests/password-reset.test.js` | Genel yanıt, hash'li token, tek kullanım, eski JWT iptali, limitler |
| `tests/whatsapp-approval.test.js` | Onaylı numara kapısı, log maskeleme, admin onay/ret API'si |
| `tests/response-cache.test.js` | Yanıt önbelleği kullanıcılar arası paylaşılmaz (yetki sızıntısı yok) |
| `tests/route-inventory.test.js` | Tüm rota/ara katman tablosu anlık görüntüsü (yeni korumasız rota fark edilir) |
| `tests/route-smoke.test.js`, `tests/empty-db.test.js` | Hiçbir GET rotası 5xx vermez (normal ve boş DB) |
| `e2e/xss-crawl.js`, `e2e/auth-flow.js` | Tarayıcıda XSS taraması ve çerez/oturum akışı (CI'da YOK; elle) |

---

## 15. YENİ ÖZELLİK EKLERKEN GÜVENLİK KONTROL LİSTESİ

- [ ] Yeni rota `authMiddleware` ile başlıyor mu (yönetici ise `adminOnly`)? Public ise gerçekten public olmalı mı ve hız sınırı var mı?
- [ ] Rota marka/kullanıcı verisi döndürüyor mu? `resolveMediaWatchScopedBrandId` kalıbıyla (veya `user_id` ile) kapsamlandı mı; başka markanın `id`'si 404/403 mü?
- [ ] Özellik/abonelik kapısı gerekiyorsa `requireFeature(...)`; AI çağrısı ise `requireAiQuota()` + `recordAiUsage(..., req)` var mı?
- [ ] Tüm SQL parametrik mi? Dinamik kısımlar allow-list'ten mi? LLM üretimli SQL `isSafeSql` + `executeSafeSql`'den mi geçiyor?
- [ ] Gövde alanları tip/uzunluk/biçim doğrulanıyor mu (`validate.js`)? Hatalı girdi 400 mü (500 değil)?
- [ ] Gövde 1mb'a sığıyor mu? Büyük gövde gerekiyorsa `LARGE_JSON_PATHS`'e bilinçli eklendi mi?
- [ ] Ön yüzde kullanıcı/DB verisi `escapeHtml`/`safeHref`/`textContent` ile basılıyor mu (kaçışsız `innerHTML` YOK)? Yeni satır içi `onclick` yazılmadı mı?
- [ ] Yeni `<script>`/`<link>` dış kaynaktan mı yükleniyor? (Olmamalı; `public/vendor/` kullan.) CSP ihlali yok mu?
- [ ] Sunucu kullanıcı kaynaklı URL'ye istek atıyorsa `isPrivateHost` denetimi var mı?
- [ ] Sır/token/parola/numara/kişisel veri loga veya yanıta yazılıyor mu? (Yazılmamalı; numara için `last4`/`maskPhone`.)
- [ ] Sır karşılaştırması `safeEqualStr` ile mi; boş yapılandırma boş istekle eşleşmiyor mu?
- [ ] Üretim davranışı `isProduction()` ile ayrıldı mı; ayrıntılı hata yalnızca geliştirmede mi (`errMsg`)?
- [ ] Çerezle çağrılan değiştirici istek `X-Requested-With` gönderiyor mu?
- [ ] Hata yanıtları kullanıcı varlığını/yapılandırmayı sızdırmıyor mu (genel mesaj)?
- [ ] Ödeme/abonelik durumunu değiştiren yol yalnızca imzalı webhook veya admin onayıyla mı?
- [ ] Yeni env değişkeni `SECURITY_SETUP.md` ve `traktor_anayasasi` ortam tablosuna işlendi mi?
- [ ] Yeni bağımlılık `npm audit` temiz mi; xlsx kuralı çiğnenmedi mi?
- [ ] Davranışı koruyan regresyon testi yazıldı mı (§14'teki uygun dosyaya)? Rota eklendiyse `UPDATE_SNAPSHOT=1` ile anlık görüntü bilinçli güncellendi mi (yalnızca koordinatör, bkz. kalite anayasası)?
- [ ] `npm test` (DB'li), `npm run lint:syntax`, `npm run lint:undef` temiz mi; ön yüz değiştiyse `npm run e2e:xss` ve `npm run e2e:auth` çalıştırıldı mı?
