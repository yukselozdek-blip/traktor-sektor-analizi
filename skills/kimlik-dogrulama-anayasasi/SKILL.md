---
name: Kimlik Doğrulama ve Üyelik Güvenlik Anayasası
description: Traktör Sektör Analizi platformunun davet kodu zorunlu kayıt, zorunlu e-posta doğrulaması, httpOnly çerez oturumu (tk_session), şifre politikası, brute-force koruma/hesap kilidi, genel 401, Google OAuth bağlama kuralı, şifre sıfırlama, superuser preview modu ve marka claim koruması için tek doğru kaynak. Yeni auth endpoint'i, oturum/çerez/JWT değişikliği, kayıt/giriş/davet/doğrulama akışı, password reset veya OAuth provider eklenirken bu doküman okunur (güvenlik ayrıntıları için `../guvenlik-anayasasi/SKILL.md` ile birlikte). login.html, signup.html, /api/auth/* ve /api/admin/invites bu kurallara göre çalışır.
---

# KİMLİK DOĞRULAMA VE ÜYELİK GÜVENLİK ANAYASASI

> Bu doküman platformun **kimlik katmanını** tanımlar. Kim nasıl hesap açar, nasıl giriş yapar, kötüye kullanım nasıl engellenir, superuser yetkisi nasıl uygulanır. Oturum/CSRF/IDOR/üretim tespiti gibi çapraz güvenlik kuralları `../guvenlik-anayasasi/SKILL.md`'dedir.

İlgili eş anayasalar: `../guvenlik-anayasasi/SKILL.md`, `../abonelik-odeme-anayasasi/SKILL.md`, `../kalite-ve-ajan-koordinasyon-anayasasi/SKILL.md`.

## 1. KAYIT (SIGNUP) AKIŞI — DAVET KODU ZORUNLU

Kayıt (şifre veya Google) **geçerli bir davet koduyla** yapılır; marka koddan gelir (marka sahteciliği engeli).

| Alan | Zorunluluk |
|------|-----------|
| Davet kodu (`invite_code`, biçim `TSA-XXXX-XXXX-XXXX`) | zorunlu (süper kullanıcı e-postası hariç) |
| E-posta + şifre **veya** Google ile devam | zorunlu |
| Ad-soyad (`full_name`), firma adı (`company_name`), unvan (`job_title`) | zorunlu |
| Plan seçimi (`plan_slug`) | opsiyonel; verilmezse davetteki `plan_slug` kullanılır; varsa kayıtla **`pending`** abonelik açılır |
| Marka (`brand_id`) | davet kodunun markasıyla **eşleşmeli** (aksi `400 Davet kodu seçtiğiniz markaya ait değil`, kod harcanmaz); gönderilmezse koddan alınır |
| VKN/vergi dairesi/telefon/şehir/bayi tipi | opsiyonel |

- Davet kodu (`src/lib/invites.js`): düz metin saklanmaz (SHA-256 `code_hash` + son 4 karakter `code_hint`); 12 karakterlik okunabilir alfabe; **atomik tüketim** (tek `UPDATE ... used_count < max_uses`, süre/aktiflik kontrolüyle) — kullanıcı + abonelik kaydıyla **aynı transaction**; kayıt başarısız olursa kod harcanmaz. Eksik/geçersiz/süresi dolmuş/iptal/kullanılmış kod için **tek genel mesaj** (`INVITE_ERROR`).
- Admin davet API'si (`src/routes/invites.js`, `authMiddleware + adminOnly`): `POST /api/admin/invites` (düz metin kod **yalnızca bu yanıtta, bir kez** döner; `max_uses` 1–1000, `expires_in_days` 1–3650), `GET /api/admin/invites` (hash/kod yok), `POST /api/admin/invites/:id/revoke`. Arayüz: Ayarlar → Davet Kodları.
- **Kayıt oturum VERMEZ:** şifreli kayıt `201` yanıtı token/çerez içermez (`email_verify_required: true`); giriş e-posta doğrulandıktan sonra yapılır. Üretim dışında yanıtta `verify_token_dev` döner (üretimde asla).
- Super kullanıcı e-postasıyla şifreli kayıt **otomatik yetki almaz** (normal doğrulama akışı). Süper kullanıcı e-postasında marka istekten gelir (davet kodu aranmaz); diğerlerinde marka koddan gelir.
- Kayıt alanları `validateProfileText` ile doğrulanır (`<`/`>` yasak, uzunluk sınırı) ve `SAFE_EMAIL` ile e-posta biçimi denetlenir.

## 2. ŞİFRE POLİTİKASI

`PASSWORD_POLICY` (`src/config.js`): `/^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/`

- Min 10 karakter, en az 1 büyük harf (Türkçe büyük dahil), 1 rakam, 1 özel karakter
- bcrypt cost = **12**
- Aynı politika kayıt, şifre sıfırlama ve `POST /api/admin/users`'ta geçerlidir.

## 3. BRUTE-FORCE VE RATE-LIMIT

| Kontrol | Değer |
|---------|-------|
| Login ve Google girişi (`LOGIN_LIMITER`) | 5 dk içinde 15 deneme |
| Signup (`SIGNUP_LIMITER`) | 1 saat içinde 5 deneme |
| Şifremi unuttum (`FORGOT_LIMITER`) | 1 saat içinde 5 |
| **Doğrulama e-postasını yeniden gönder** (`RESEND_LIMITER`) | 1 saat içinde 5 + hesap başına 60 sn bekleme |
| Şifre sıfırlama doğrula/uygula (`RESET_LIMITER`) | 15 dk içinde 30 |
| Hesap kilidi | 5 başarısız login → 15 dk lock (`users.locked_until`) |
| Başarılı login | `failed_login_count = 0`, `locked_until = NULL` |

**Genel 401 (numaralandırma yok):** bilinmeyen e-posta, yanlış şifre ve kilitli hesap **aynı gövdeyi** (`LOGIN_FAIL_MESSAGE`) döner; kalan deneme sayısı veya kilit süresi gövdede verilmez (kilitliyse yalnızca `Retry-After` başlığı). Olmayan/kilitli hesapta da `bcrypt.compare` (sahte hash `DUMMY_PASSWORD_HASH`) çalışır → zamanlama eşitlenir.

## 4. GOOGLE OAUTH

- `POST /api/auth/google` `id_token` alır; Google `tokeninfo` ile doğrulanır; `email_verified !== 'true'` reddedilir.
- `GOOGLE_OAUTH_CLIENT_ID` **zorunludur**: tanımsızsa Google girişi `503`; `aud` eşleşmesi şarttır.
- **Mevcut hesap varsa bağlanır**; pasif hesap Google ile de giremez (`403`). **Bağlama kuralı:** mevcut hesap e-postası **doğrulanmamış** ve şifreliyse (saldırganın kurbanın e-postasıyla önceden kayıt olma riski) bağlama sırasında **parola silinir** ve `password_changed_at` güncellenerek eski oturumlar geçersiz kılınır (audit: `google_link_cleared_unverified_password`). Google girişi şifre deneme sayaçlarını **sıfırlamaz**.
- **Yeni kullanıcı:** davet kodu (süper kullanıcı hariç) + firma + unvan zorunlu; eksikse `202 GOOGLE_NEEDS_PROFILE`. Kod, marka ve kullanıcı kaydı tek transaction'dadır. Google ile gelen yeni kullanıcı `email_verified = true` ve oturum (çerez) alır.

## 5. SUPERUSER MODU

- Superuser e-postaları `SUPERUSER_EMAILS` ortam değişkeninden (virgülle ayrılmış) okunur; tanımsızsa varsayılan `yukselozdek@gmail.com` (`src/config.js`).
- Doğrulanmış superuser e-postası ile giriş → `role = 'admin'`, `is_superuser = true`. Superuser e-postaları e-posta doğrulaması zorunluluğundan **muaftır**.
- Preview: `POST /api/auth/preview-plan { plan_slug: 'starter' | 'growth' | 'enterprise' | null }`; `null` → tüm yetkiler. `requireFeature` ve `getPlanLimits` preview planına göre kısıtlanır.
- Frontend'de banner üstünde "Önizleme" seçici çıkar.

## 6. E-POSTA DOĞRULAMASI — ZORUNLU

- Kayıtta `email_verify_token` (24 sa geçerli, **tek kullanımlık**) üretilir ve bağlantı e-postayla gönderilir (`src/lib/verify-email.js`; SMTP/Brevo yoksa kayıt yine başarılı olur, mail gitmez). Bağlantı tabanı yalnızca `APP_BASE_URL`'dir (üretimde).
- `GET /api/auth/verify-email?token=...` → doğrulanır, sonucu `/login.html?verified=1|0`'a yönlendirir.
- **Giriş doğrulama ister:** doğrulanmamış kullanıcı **doğru şifreyle** `403 { code: 'EMAIL_NOT_VERIFIED' }` alır; yanlış şifrede normal genel 401 alır (403 sızıntısı yok).
- `POST /api/auth/resend-verification` (herkese açık, `RESEND_LIMITER`): kayıtlı mı/doğrulanmış mı fark etmeksizin **her zaman aynı genel yanıt**; yalnızca doğrulanmamış, aktif, şifreli (`auth_provider='password'`) hesaba yeni token üretir.
- **Mevcut kullanıcıların muafiyeti:** migration `006_invite_codes.sql` bu kuraldan ÖNCE kayıtlı tüm kullanıcıları `email_verified = true` yapar (bir kez); yalnızca yeni kayıtlar doğrulama gerektirir.

## 7. AUDIT LOG (auth_audit)

| Event | Açıklama |
|-------|----------|
| `login_success` / `login_failed` / `login_failed_unknown` / `login_blocked_locked` | Şifre login sonuçları |
| `login_blocked_unverified` | Doğru şifre, doğrulanmamış e-posta |
| `login_google` / `login_google_inactive` | Google login / pasif hesap |
| `google_link_cleared_unverified_password` | Google bağlamada doğrulanmamış hesabın parolası silindi |
| `signup_password` / `signup_google` / `signup_email_taken` | Kayıt |
| `email_verified` / `verification_resent` | Doğrulama |
| `invite_created` / `invite_revoked` | Davet kodu yönetimi |

Şifre sıfırlama olayları ayrıca `password-reset` modülünde kaydedilir.

## 8. OTURUM VE JWT

- Tarayıcı oturumu **httpOnly çerez `tk_session`** (`SameSite=Lax`, HTTPS'te `Secure`, 7 gün). `localStorage`'da oturum anahtarı **tutulmaz** (`public/api_v3.js` eski `auth_token`'ı siler; `user_data`/`last_brand_slug` gibi kullanıcı bilgisi dışında sır yoktur).
- JWT: HS256 pin'li, ömür **7 gün** (`expiresIn: '7d'`), payload `{ id, email, role, brand_id, sup }`; ancak rol/marka/aktiflik her istekte DB'den okunur (60 sn önbellek) — token'daki rol iddiası yetki kaynağı değildir.
- Web istemcisi `X-Web-Session: 1` ile giriş yapar (token gövdede dönmez); API istemcileri `Authorization: Bearer` kullanır. Çerezli değiştirici isteklerde CSRF: `X-Requested-With: XMLHttpRequest` + Origin. `POST /api/auth/logout` çerezi siler.
- 401 cevabında istemci otomatik çıkış yapar. Şifre sıfırlama/değişimi önceki JWT'leri geçersiz kılar (`password_changed_at`).
- Ayrıntı: `../guvenlik-anayasasi/SKILL.md` §1.

## 9. MARKA CLAIM KORUMASI

- Marka ataması **davet koduyla** yapılır; kullanıcı kendi başına marka "seçip" sahiplenemez (kod başka markaya aitse kayıt reddedilir).
- Davet kodları admin tarafından markaya özel, sınırlı kullanımlı ve süreli üretilir; iptal edilebilir.
- Aynı markaya çok sayıda farklı alan adından kayıt için otomatik inceleme kuyruğu yoktur (gelecek sürüm, doğrulanmadı: kodda böyle bir kuyruk bulunmadı).

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
| `/api/auth/login` | POST | public + `LOGIN_LIMITER` | Şifre login |
| `/api/auth/signup` | POST | public + `SIGNUP_LIMITER` | Yeni hesap (davet kodu zorunlu, oturum vermez) |
| `/api/auth/google` | POST | public + `LOGIN_LIMITER` | Google OAuth |
| `/api/auth/google-config` | GET | public | Frontend için client_id |
| `/api/auth/me` | GET | auth | Mevcut kullanıcı |
| `/api/auth/logout` | POST | public | Çerezi siler |
| `/api/auth/verify-email` | GET | public | E-posta token doğrulama |
| `/api/auth/resend-verification` | POST | public + `RESEND_LIMITER` | Doğrulama e-postasını yeniden gönder |
| `/api/auth/forgot-password` | POST | public + `FORGOT_LIMITER` | Şifre sıfırlama isteği (her zaman aynı yanıt) |
| `/api/auth/reset-password/validate` | GET | public + `RESET_LIMITER` | Token geçerli mi |
| `/api/auth/reset-password` | POST | public + `RESET_LIMITER` | Yeni şifre (token tek kullanımlık, 30 dk, DB'de sha256) |
| `/api/auth/preview-plan` | POST | superuser/admin | Preview paketi seç |
| `/api/admin/invites` | GET / POST | adminOnly | Davet kodu listele / oluştur |
| `/api/admin/invites/:id/revoke` | POST | adminOnly | Davet kodunu iptal et |

## 11. UI / UX STANDARTLARI

### 11.1 Login Sayfası
- Sol panel: paket önizleme; sağ panel: Login/Signup sekmesi + Google butonu.
- Hatalar kullanıcı dostu Türkçe; hesap/kilit bilgisi sızdırılmaz (genel mesaj + "çok sayıda hatalı denemede 15 dk kilit" ipucu).
- Doğrulanmamış hesapta `EMAIL_NOT_VERIFIED` → "E-postanızı doğrulayın" + yeniden gönder.
- Sticky yalnızca masaüstünde (bkz. erişilebilirlik anayasası).

### 11.2 Signup
- Davet kodu alanı (`invite_code`), firma/unvan, marka seçimi (kodla eşleşmeli), plan, şifre alanı altında canlı güç göstergesi.
- Kayıt sonrası "doğrulama bağlantısı gönderildi" ekranı (oturum açılmaz).

### 11.3 Superuser Banner
- Superuser e-postası yazıldığında altın bant; login sonrası "Önizleme" seçici.

## 12. CHECKLIST: YENİ AUTH ÖZELLİĞİ EKLEME

- [ ] Endpoint `/api/auth/*` altında, rate-limit'li mi?
- [ ] Hata mesajları kullanıcı/hesap varlığını sızdırmıyor mu (genel 401/aynı yanıt)?
- [ ] Audit log atılıyor mu?
- [ ] Şifre işliyorsa bcrypt cost 12+ ve `PASSWORD_POLICY` kontrolü var mı?
- [ ] E-posta biçimi (`SAFE_EMAIL`) ve serbest metin alanları (`validateProfileText`) doğrulandı mı?
- [ ] Oturum veren yol `SESSION_ISSUING` kümesine girmeli mi? Çerez değiştirici istekler CSRF başlığı gönderiyor mu?
- [ ] Yeni giriş yolu e-posta doğrulaması ve davet kodu kurallarını atlamıyor mu (Google dahil)?
- [ ] Tokenlar (`email_verify_token`, sıfırlama) tek kullanımlık, süreli, tahmin edilemez mi?
- [ ] Frontend formu hidden field değil **gerçek input** mu? Hata mesajları user-friendly Türkçe mi?
- [ ] `npm run lint:syntax`, `npm run lint:undef`, `npm test` (DB'li) ve `npm run e2e:auth` geçti mi?
- [ ] Manuel test: yanlış şifre 5x → kilit → 15 dk bekleme; doğrulanmamış hesapla giriş → 403

## 12a. İKİ ADIMLI DOĞRULAMA (TOTP) — CANLI

**Karar:** isteğe bağlı; yönetici (`role=admin`) ve süper kullanıcı için zorunlu (üretimde varsayılan açık).

- **Kod:** `src/lib/totp.js` (RFC 6238, SHA-1/6 hane/30 sn, ±1 adım, harici bağımlılık yok; RFC test vektörüyle doğrulanır), `src/lib/mfa.js` (kapı + ara token), `src/routes/mfa.js` (uç noktalar), `database/migrations/009_totp_2fa.sql`.
- **Akış:** şifre doğru → 2FA etkinse `{mfa_required, mfa_token}` (oturum/çerez YOK) → `POST /api/auth/2fa/verify` {mfa_token, code} → oturum. Zorunlu ama kurulmamış yönetici: `mfa_setup_required` + `setup` token'ı → `/2fa/setup` + `/2fa/enable` (kurulum token'ıyla) → oturum yalnızca etkinleştirmeden sonra. Google girişi (mevcut ve yeni süper kullanıcı) aynı kapıdan geçer.
- **Ara token** farklı anahtarla (`JWT_SECRET + ':mfa-step'`) ve `pur` (amaç) alanıyla imzalanır, 5 dk geçerlidir; oturum token'ı olarak ASLA kabul edilmez, `verify` token'ı ile kurulum yapılamaz.
- **Saklama:** secret AES-256-GCM ile şifreli (`TOTP_ENC_KEY`, yoksa `JWT_SECRET`'tan türetilir; **anahtar değişirse kayıtlı secret'lar çözülemez** → kullanıcıların 2FA'sı sıfırlanmalı). Kurtarma kodları (10 adet, tek kullanımlık) yalnızca SHA-256 hash olarak.
- **Saldırı korumaları:** aynı TOTP adımı ikinci kez kabul edilmez (`totp_last_step`, atomik); yanlış kod sayacı şifre kilidiyle ortak (5 hata → 15 dk); `LOGIN_LIMITER`; genel hata mesajı; tüm olaylar `auth_audit`'e (`mfa_*`).
- **Kapatma/yenileme:** şifre + güncel kod ister; zorunluluk açıkken yönetici kapatamaz (403). Cihaz kaybı: süper kullanıcı `POST /api/admin/users/:id/2fa-reset` (kendi hesabı hariç); kullanıcı sonraki girişte yeniden kurar.
- **Ortam:** `REQUIRE_ADMIN_2FA=0` zorunluluğu kapatır (acil geri alma), `=1` her ortamda açar; verilmezse yalnızca üretimde (`isProduction()`) açık. Testler `NODE_ENV=test` olduğundan etkilenmez.
- **Bilinen sınır:** zorunluluk giriş anında uygulanır; zorunluluk açılmadan önce verilmiş (en çok 7 günlük) oturumlar sürer. QR kod yok; kullanıcı anahtarı elle girer ya da `otpauth://` bağlantısına dokunur.
- **Ön yüz:** `login.html` `#mfaForm` (kod / kurulum / kurtarma kodları), `public/app_v3.js` ayarlar sayfasında "İki Adımlı Doğrulama" kartı. Doğrulama: `npm run e2e:mfa`, `tests/mfa.test.js`.

## 13. KAPSAM DIŞI

- ~~Şifre sıfırlama~~ → **canlı** (bkz. şifre sıfırlama bölümü)
- SSO/SAML kurumsal entegrasyonu (Enterprise+ talebine bağlı)
- WebAuthn / passkey (uzun vade)
- Marka claim için otomatik inceleme kuyruğu
