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
| Login rate limit | 5 dk içinde 15 deneme |
| Signup rate limit | 1 saat içinde 5 deneme |
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

- 30 gün geçerli (`expiresIn: '30d'`)
- Payload: `{ id, email, role, brand_id, sup }`
- Frontend `localStorage.auth_token`
- 401 cevabında otomatik logout
- CORS + helmet aktif; HTTPS Railway tarafında zorunlu

## 9. MARKA CLAIM KORUMASI

- Aynı markaya 1 yıl içinde 5+ farklı domain'den kayıt → manual review queue (TODO: gelecek sürüm)
- Şu anda DB seviyesinde unique constraint yok; admin paneli üzerinden manuel onay/red yapılır.

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
- [ ] `node --check server.js` geçti mi?
- [ ] Manuel test: login → wrong password 5x → lock → wait 15 min

## 13. KAPSAM DIŞI

- Şifre sıfırlama (gelecek sürüm — destek talebiyle manuel)
- 2FA (gelecek sürüm)
- SSO/SAML kurumsal entegrasyonu (Enterprise+ talebine bağlı)
- WebAuthn / passkey (uzun vade)
