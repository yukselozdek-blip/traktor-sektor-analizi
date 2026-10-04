---
name: Kimlik Doğrulama ve Üyelik Güvenlik Anayasası
description: Traktör Sektör Analizi platformunun login/signup/Google OAuth akışı, şifre politikası, brute-force koruma, hesap kilidi, email doğrulama, superuser preview modu, marka claim koruması ve oturum güvenliği için tek doğru kaynak. Yeni auth endpoint, oturum yönetimi, password reset veya OAuth provider eklenirken bu doküman okunur. login.html, /api/auth/* endpoint'leri ve frontend gating bu kurallara göre çalışır.
---

# KİMLİK DOĞRULAMA VE ÜYELİK GÜVENLİK ANAYASASI

> Bu doküman platformun **kimlik katmanını** tanımlar. Kim nasıl hesap açar, nasıl giriş yapar, kötüye kullanım nasıl engellenir, superuser yetkisi nasıl uygulanır.

## 1. KAYIT (SIGNUP) AKIŞI — 4 ADIMLI WIZARD

| Adım | İçerik | Zorunluluk |
|------|--------|-----------|
| 1 | Plan seçimi (Starter/Growth/Enterprise) | zorunlu |
| 2 | E-posta + Şifre **veya** Google ile devam | zorunlu |
| 3 | Marka seçimi (markayı temsil eden kullanıcı) | zorunlu |
| 4 | Firma adı, unvan, firma türü (bayi/distribütör/OEM); ops. VKN/vergi dairesi/telefon/şehir | zorunlu (firma+unvan), opsiyonel diğerleri |

Marka olmadan kayıt **tamamlanmaz**. Pozisyon (job_title) seçimi olmadan kayıt **tamamlanmaz**.

## 2. ŞİFRE POLİTİKASI

`PASSWORD_POLICY` regex: `/^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/`

- Min 10 karakter
- En az 1 büyük harf (Türkçe büyük dahil: Ç,Ğ,İ,Ö,Ş,Ü)
- En az 1 rakam
- En az 1 özel karakter
- bcrypt cost = **12**

## 3. BRUTE-FORCE VE RATE-LIMIT

| Kontrol | Değer |
|---------|-------|
| Login rate limit | 5 dk içinde 15 deneme (`LOGIN_LIMITER`, `src/middleware/limiters.js`) |
| Signup rate limit | 1 saat içinde 5 deneme (`SIGNUP_LIMITER`) |
| Şifremi unuttum | IP başına 1 saatte 5 istek (`FORGOT_LIMITER`); kullanıcı başına 1 saatte en fazla 3 token |
| Reset doğrulama/uygulama | 15 dk içinde 30 istek (`RESET_LIMITER`), token tahminini zorlaştırır |
| Hesap kilidi | 5 başarısız login → 15 dk lock (`users.locked_until`) |
| Başarılı login | `failed_login_count = 0`, `locked_until = NULL` |

## 4. GOOGLE OAUTH

- `POST /api/auth/google` endpoint'i `id_token` alır.
- Google'ın `tokeninfo` endpoint'i ile minimal doğrulama yapılır.
- `email_verified !== 'true'` ise reddedilir.
- `GOOGLE_OAUTH_CLIENT_ID` env tanımlıysa `aud` (audience) eşleşmesi zorunlu.
- Mevcut hesap varsa Google ID bağlanır, yoksa marka+firma+unvan istenir (`GOOGLE_NEEDS_PROFILE` 202).
- Google ile gelen kullanıcı `email_verified = true` (Google zaten doğrulamış).

## 5. SUPERUSER MODU

- `SUPERUSER_EMAILS = { 'yukselozdek@gmail.com' }` sabitinde tanımlı.
- Bu email ile login/signup → otomatik `role = 'admin'`, `is_superuser = true`, `email_verified = true`.
- Superuser, **3 paketi de denemek için** `preview_plan_slug` alanını kullanır:
  - `POST /api/auth/preview-plan { plan_slug: 'starter' | 'growth' | 'enterprise' | null }`
  - `null` → tüm yetkiler (default admin davranışı)
- `requireFeature` ve `getPlanLimits` superuser'ın preview plan'ına göre kısıtlanır → her paketin kullanıcı deneyimi gerçekçi yaşanır.
- Frontend'de banner üstünde "Önizleme: Starter / Growth / Enterprise / Tüm yetkiler" select'i çıkar.

## 6. EMAIL DOĞRULAMA

- Kayıt sonrası `email_verify_token` (24 sa geçerli) üretilir.
- `GET /api/auth/verify-email?token=...` ile aktive edilir.
- Doğrulama olmadan kullanıcı sisteme giriş yapabilir, ama ödeme akışı sırasında onay istenir (gelecek sürüm).
- Superuser ve Google kullanıcıları otomatik doğrulanmış sayılır.

## 7. AUDIT LOG (auth_audit)

Her kritik kimlik olayı kaydedilir:

| Event | Açıklama |
|-------|----------|
| `login_success` | Başarılı şifre login |
| `login_failed` | Yanlış şifre (count + lock metadata) |
| `login_failed_unknown` | Email kayıtlı değil |
| `login_blocked_locked` | Lock süresi içinde deneme |
| `login_google` | Google login |
| `signup_password` | E-posta/şifre kaydı |
| `signup_google` | Google ile yeni kayıt |
| `signup_email_taken` | Email zaten kayıtlı |

## 8. JWT VE OTURUM

- **7 gün** geçerli (`expiresIn: '7d'`); `JWT_SECRET` tanımlı değilse açılışta geçici anahtar üretilir (her yeniden başlatmada oturumlar düşer; production'da `JWT_SECRET` zorunlu)
- Şifre değişince eski oturumlar **geçersiz** olur: `users.password_changed_at` ile JWT `iat` karşılaştırılır (60 sn önbellek; şifre sıfırlamada önbellek temizlenir)
- Payload: `{ id, email, role, brand_id, sup }`
- Frontend `localStorage.auth_token`
- 401 cevabında otomatik logout
- CORS + helmet aktif; HTTPS Railway tarafında zorunlu

## 9. MARKA CLAIM KORUMASI

- Aynı markaya 1 yıl içinde 5+ farklı domain'den kayıt → manual review queue (TODO: gelecek sürüm)
- Şu anda DB seviyesinde unique constraint yok; admin paneli üzerinden manuel onay/red yapılır.

## 9.1 ŞİFRE SIFIRLAMA (CANLI)

- `POST /api/auth/forgot-password` → her zaman aynı genel yanıt (kullanıcı var mı yok mu sızdırılmaz); kullanıcı varsa ve aktifse token üretilir, mail gönderilir. Sınıra takılan istek de aynı yanıtı verir (log'da `[forgot-password] istek atlandı...`).
- `GET /api/auth/reset-password/validate`, `POST /api/auth/reset-password`: token **sha256 özeti** olarak DB'de (`password_reset_tokens`, migrasyon 004), **tek kullanım**, **30 dk** geçerli, yeni istekte önceki açık tokenlar iptal edilir; yeni şifre politika regex'inden geçer.
- Bağlantı `APP_BASE_URL` (production'da zorunlu) ile üretilir: `https://app.tarimtraktor.com/reset-password.html?token=...`.
- Mail: Brevo HTTPS API (`BREVO_API_KEY`, `MAIL_FROM`); Railway SMTP portlarını engellediği için SMTP yedek yoldur. Bkz. `../operasyon-altyapi-anayasasi/SKILL.md` §3.
- Kod: `src/routes/password-reset.js`, `src/lib/mailer.js`, `src/lib/app-url.js`. Testler: `tests/password-reset.test.js` (`MAIL_OUTBOX_FILE` test kancası yalnızca production dışında çalışır).
- Google ile kayıtlı kullanıcının `password_hash` değeri boş (NULL) olabilir (migrasyon 005); bu kullanıcılar şifre sıfırlama ile şifre belirleyebilir.

## 10. ENDPOINT ENVANTERİ

| Endpoint | Metod | Yetki | Amaç |
|----------|-------|-------|------|
| `/api/auth/login` | POST | public + rateLimit | Şifre login |
| `/api/auth/signup` | POST | public + rateLimit | Yeni hesap (4-adım wizard) |
| `/api/auth/google` | POST | public + rateLimit | Google OAuth |
| `/api/auth/google-config` | GET | public | Frontend için client_id |
| `/api/auth/me` | GET | auth | Mevcut kullanıcı |
| `/api/auth/verify-email` | GET | public | Email token doğrulama |
| `/api/auth/preview-plan` | POST | superuser | Preview paketi seç |
| `/api/auth/forgot-password` | POST | public + FORGOT_LIMITER | Sıfırlama bağlantısı iste |
| `/api/auth/reset-password/validate` | GET | public + RESET_LIMITER | Token geçerli mi |
| `/api/auth/reset-password` | POST | public + RESET_LIMITER | Yeni şifre belirle |

## 11. UI / UX STANDARTLARI

### 11.1 Login Sayfası
- Sol panel: 3 paket önizleme (toolbar tab + içerik)
- Sağ panel: Login/Signup sekmesi + Google butonu
- Üstte "Tekrar hoş geldiniz" başlığı, altta demo bilgisi
- Brute-force koruma kullanıcıya bildirilir: "Hesabınız X dakika kilitli"

### 11.2 Signup Wizard
- 4 adımlı progress bar (active/done/pending)
- Şifre alanı altında **canlı güç göstergesi** (zayıf/orta/güçlü)
- Marka seçimi: arama kutusu + grid (max-height 220px scrollable)
- Pozisyon: dropdown (8 standart unvan + Diğer)

### 11.3 Superuser Banner
- `yukselozdek@gmail.com` yazıldığında login formunun üstünde altın bant
- Login sonrası top-right köşede "Önizleme: …" floating switcher

## 12. CHECKLIST: YENİ AUTH ÖZELLİĞİ EKLEME

- [ ] Endpoint `/api/auth/*` altında, rate-limit'li mi?
- [ ] Audit log atılıyor mu?
- [ ] Şifre işliyorsa bcrypt cost 12+ mi?
- [ ] Email format ve şifre policy kontrolü yapıldı mı?
- [ ] Frontend formu hidden field değil **gerçek input** mu?
- [ ] Hata mesajları user-friendly Türkçe mi?
- [ ] `npm run lint:syntax` ve `npm test` geçti mi? (yeni route ise route envanteri snapshot'ı bilinçli güncellendi mi?)
- [ ] Manuel test: login → wrong password 5x → lock → wait 15 min

## 13. KAPSAM DIŞI

- ~~Şifre sıfırlama~~ → **canlı** (bkz. §9.1)
- **2FA (TOTP)**: planlandı, henüz yok. Önerilen tasarım: isteğe bağlı + admin/superuser için zorunlu, kurtarma kodları, login'de ikinci adım. Karar ve ilerleme: `PROJE_DURUMU.md`
- SSO/SAML kurumsal entegrasyonu (Enterprise+ talebine bağlı)
- WebAuthn / passkey (uzun vade)
