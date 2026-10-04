# Traktör Sektör Analizi: Proje Durumu ve Yol Haritası

> Sonraki çalışmalar buradan devam eder. Önce `skills/operasyon-altyapi-anayasasi/SKILL.md` ve `skills/traktor_anayasasi/SKILL.md` okunur. Bu dosya **canlı bir kayıttır**: iş bitince ilgili satır güncellenir, tarih eklenir.
>
> Son güncelleme: **2026-10-04**

## 1. Hedef

Uygulamayı **müşterilere hizmet verecek kalite ve güvenlik düzeyine** getirmek. Çalışma düzeni: büyük model **moderatör/orkestratör** (karar, doğrulama, birleştirme), uygulama işleri **ucuz model alt-ajanlarında** (kurallar: operasyon anayasası §6).

## 2. Tamamlanan işler (kronolojik özet)

| Alan | Yapılan | Kanıt |
|------|---------|-------|
| İlk canlıya alma | Railway deploy, harita filigranı (CARTO) kaldırıldı, Dockerfile `npm ci` düzeltmesi, `schema.sql` FK sırası, admin hesabı, `/giris/<slug>` mutlak yol | ilk PR'lar (#1-#5) |
| **Faz 0: Güvenlik** | Yetkilendirme/rol DB doğrulaması, JWT güvenli varsayılan, CORS izin listesi, Stripe ham gövde, zamanlama güvenli karşılaştırma, WhatsApp imzası, text-to-SQL koruması, genel 500, `trust proxy`, XSS (escapeHtml/DOMPurify) | testler: `security`, `sql-guard`, `auth-matrix` |
| **Faz 1: Temel** | Sıralı migrasyonlar (001-005, `schema_migrations`), TÜİK içe aktarma düzeltmesi, test altyapısı, **CI** (postgres:16), **gece şifreli yedek → Hetzner** | `ci.yml`, `db-backup.yml`, `BACKUP.md` |
| **Faz 2a: Performans** | Minify (esbuild) + `?v=` sürümleme + önbellek, `#/sayfa` yönlendirmesi | `scripts/build-assets.js` |
| **Faz 2b: `server.js` bölme** | 5/13 adım (bkz. §5) | `git log --oneline` ("refactor: server.js bölme") |
| **Faz 3: Şifre sıfırlama** | sha256 özetli tek kullanımlık 30 dk token, kullanıcı sızdırmama, hız sınırları, `password_changed_at` ile JWT geçersiz kılma | `password-reset.test.js` |
| **Alan adı** | `tarimtraktor.com` (Cloudflare), `app.tarimtraktor.com` canlı | §3 |
| **E-posta** | Brevo domain doğrulandı; **HTTPS API** ile gönderim (Railway SMTP'yi engelliyor); Cloudflare Email Routing (`destek@`, `info@`, `iletisim@`) | PR #17-#18; şifre sıfırlama maili Gmail'e ulaştı |
| **Google ile giriş** | Yeni alan adında çalışıyor (silinmiş istemci geri getirildi, yetkili kaynak eklendi) | |
| **Hata düzeltme** | `change-plan` kendine geri dönüp 429 veriyordu → `checkout` işleyicisini doğrudan çağırıyor | PR #22, `billing-change-plan.test.js` |

Test durumu: **40/40 yeşil**, CI yeşil, `master` = canlı.

## 3. Mevcut canlı durum

- Uygulama: `https://app.tarimtraktor.com` (+ eski Railway adresi yedek).
- Mail: şifre sıfırlama çalışıyor; gelen kutusu yönlendirmesi çalışıyor.
- Railway sağlık kontrolü tanımlı (`railway.json`, `/health`).
- Cloudflare **DNS only** (turuncu bulut kapalı); DNSSEC **henüz açılmadı** (düğme "Enable DNSSEC").
- Google OAuth yayın durumu **Testing** (yalnızca test kullanıcısı girebilir).

## 4. Kullanıcı tarafında bekleyen işler (benim yapamadığım)

| # | İş | Neden önemli |
|---|----|--------------|
| 1 | Google **Branding** sayfasını kaydet + **Audience → Publish app** | Müşteriler Google ile giremez (şu an yalnızca test kullanıcısı) |
| 2 | Cloudflare **DNSSEC → Enable DNSSEC** | Alan adı güvenliği; Cloudflare Registrar + DNS olduğu için DS elle girilmez |
| 3 | **2FA kararı**: isteğe bağlı + admin için zorunlu (önerilen) mi, herkes için zorunlu mu? | 2FA tasarımı bu karara bağlı |
| 4 | **E-fatura sağlayıcısı** tercihi (ör. Paraşüt, Logo, Foriba/diğer) | Yasal fatura entegrasyonu |
| 5 | Yedek **parola ifadesini** güvenli yerde sakla; **geri yükleme testi** için onay | Yedeğin işe yaradığını kanıtlamak |
| 6 | Aylık: GitHub Actions'ta yedek işinin çalıştığına bak | 60 gün hareketsizlikte zamanlama durur |
| 7 | (İsteğe bağlı) `tarimtraktor.com` ve `www` → `app.` yönlendirmesi (Cloudflare Redirect Rule) | Ana adres şu an açılmıyor |
| 8 | (İsteğe bağlı) Gmail "Farklı adresten gönder" ile `destek@` olarak yanıt verme (Brevo SMTP) | Müşteriye `destek@` adresinden yanıt |

## 5. Yol haritası (önerilen sıra)

### A. Müşteri açısından kritik
1. **2FA (TOTP)**: uygulama içi kullanıcılar için. Tasarım: kullanıcı ayarlardan açar; admin/superuser için zorunlu; kurtarma kodları; login akışında ikinci adım; `auth_audit` olayları; hız sınırı; testler. Kimlik anayasası güncellenir. *(Karar bekliyor, bkz. §4-3)*
2. **E-fatura**: ödeme sonrası yasal fatura (sağlayıcı seçimi sonrası). `invoices` tablosunda `legal_invoice_pending`, `einvoice_pdf_url` alanları zaten var.
3. **n8n servisi**: akışların güvenli ve sağlıklı çalışması, uygulamayla bağlantı (`RAILWAY_N8N_ARCHITECTURE.md`, `WHATSAPP_N8N_SETUP.md`).

### B. İşletme güvenilirliği
4. **Yedek geri yükleme testi** (geçici DB'ye `scripts/restore-db.sh`; satır sayıları karşılaştırılır).
5. **İzleme**: çalışma süresi izleme (dış kontrol) + hata takibi. Henüz yok.
6. Railway **deploy sağlık kontrolü** zaten var; kontrol edilmesi yeterli.
7. Brevo/Hetzner/Cloudflare **kota ve süre sonu** takvimi (Brevo anahtarları 1 yıl geçerli: **2027-10**).

### C. Teknik borç
8. **`server.js` bölme, kalan 8 adım**: satış analitiği (3-4 dosya), modeller/model-intelligence, dashboard, admin, forecast, seed fonksiyonları, `initDB`, SPA fallback/bridge/listen. Her adım ayrı PR; kalıp operasyon anayasası §7. Taşınan kod yalnızca bağlama satırı farkıyla olmalı.
9. **Cloudflare proxy (turuncu bulut) hazırlığı**: sunucu gerçek IP'yi (`CF-Connecting-IP`) doğru okumalı; sonra proxy açılır (DDoS/WAF/önbellek).
10. `getLatestSalesPeriod` çift tanımı sadeleştirilir (davranışı koruyan ayrı PR).
11. Ölü kod: `getPlanFeatureKeys`, `userHasFeature` (hiçbir yerde çağrılmıyor).
12. Ana alan adı yönlendirmesi + `www`.

## 6. Bilinen açık noktalar / riskler

- WhatsApp webhook POST, debug uçları ve Google akışı **otomatik testle kapsanmıyor** (kod taşındı, davranış aynı).
- `run-now` ve `translate` (media-watch) başarılı yolları testlenmedi (köprü/AI çağrısı gerektirir).
- Şu an canlıda **aktif ödeme yok**; Stripe/iyzico mock modda. Gerçek ödeme açılmadan önce: gerçek anahtarlar, webhook imza doğrulaması, e-fatura, `change-plan` canlı denemesi.
- **Meta/WhatsApp callback adresleri eski Railway adresinde kayıtlı** (webhook, gizlilik, şartlar, veri silme). Eski adres açık tutulmalı; yeni alan adına taşıma ayrı, bilinçli bir iştir (Meta paneli + doğrulama belirteci birlikte güncellenir). Bkz. `skills/stratejikplan-whatsapp-sales-assistant/references/live-context.md`.
- `server.js`'te eslint `no-undef` ile 9 eski uyarı var (bu çalışmadan önce de vardı): `enrichProvinceWithReference`, `hpRangeFromHorsepower` vb. Ayrı temizlik işi.

## 7. Bir sonraki oturum için başlangıç kontrol listesi

1. `git fetch origin master && git checkout -B <dal> origin/master`
2. `npm run lint:syntax && npm test` (geçici Postgres + `TEST_DATABASE_URL`)
3. Bu dosyanın §4 ve §5'ini oku; kullanıcıdan gelen kararlara göre sıradaki işi seç.
4. İşi yap → PR → CI yeşil → squash → canlıda doğrula → **bu dosyayı güncelle**.
