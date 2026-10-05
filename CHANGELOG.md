# Değişiklik Günlüğü

## Ekim 2026 sertleştirme dönemi

Kaynak: `git log` (3-4 Ekim 2026) ve PR #24 açıklaması. Sıra: eskiden yeniye. Commit kimlikleri yazılmamıştır; ilgili ayrıntı için skill belgelerine bakın (`skills/guvenlik-anayasasi`, `skills/kalite-ve-ajan-koordinasyon-anayasasi`, `skills/erisilebilirlik-tasarim-anayasasi`).

### 3 Ekim 2026 — temel altyapı
- Faz 0 güvenlik sertleştirmesi (backend, ön yüz, depo).
- Faz 1: migration sistemi, indeksler, TÜİK içe aktarma düzeltmesi, testler, yedekleme kılavuzu.
- Hetzner Storage Box'a şifreli gece yedeği (GitHub Actions); yedek adlandırması ve ayrı Hetzner projesi; çalışmayan Railway deploy iş akışı kaldırıldı.
- Düzeltmeler: şema sırası ("Sunucu hatası" girişi), Dockerfile `npm ci`, harita altlığı filigranı, marka giriş yolunda `API is not defined`, süper kullanıcı önizleme kutusu çakışması.

### 4 Ekim 2026 — hız, bölme ve yeni özellikler
- Faz 2a: sıkıştırma, küçültme (`public/dist`), önbellek ve `#/sayfa` URL yönlendirmesi; Railway build hatası (markdown-pdf/phantomjs) giderildi.
- `server.js` bölme adım 1-13: rota envanteri anlık görüntüsü, config/db, auth/limiter ara katmanları, public/webhook, signup+Google, media-watch, billing, satış analitiği, modeller, dashboard/admin, satış analiz, seed/admin/TARMAKBİR, forecast, AI analiz, `initDB` modülü (15.5 bin satırdan ~6.7 bin satıra; davranış değişmedi). Kayan `require` yolları ve kopan yardımcılar düzeltildi; CI'a `no-undef` taraması eklendi (`/api/provinces` 500 hatası).
- Şifre sıfırlama (e-posta), SMTP modülü, Brevo HTTPS API desteği (Railway SMTP portları engelli), tanı logları; Google kaydı düzeltmesi.
- `change-plan` kendine geri dönüp 429 veriyordu: checkout işleyicisini doğrudan çağıracak şekilde düzeltildi.
- `TRUST_PROXY_HOPS` (Cloudflare hazırlığı) ve ana alan adı 301 yönlendirmesi (`REDIRECT_HOSTS`).
- Yedek geri yükleme tatbikatı (betik + aylık iş akışı) ve `/health` çalışma süresi izleme (`uptime.yml`).
- n8n güvenlik/sağlık denetimi notları; v4 işlemci akışına `x-query-token` doğrulaması, boş anahtar koruması.
- Tüm kimlik doğrulamalı GET rotaları için duman testi.
- Bağımlılık güvenlik güncellemeleri (axios, qs override, form-data, path-to-regexp); kullanılmayan `node-cron` kaldırıldı.
- Performans: bağlantı havuzu/sorgu zaman aşımı ayarları, kullanıcıya özel yanıt önbelleği, makul API hız sınırı (600/dk), yük testi betiği (`PERFORMANS.md`).

### 4 Ekim 2026 — güvenlik sertleştirmesi (PR #24)
- Zorunlu CSP; üçüncü taraf kütüphaneler ve yazı tipleri `public/vendor/`'dan; `Permissions-Policy`; rota envanteri anlık görüntüsü güncellendi.
- Oturum anahtarı `localStorage`'dan `httpOnly` çereze (`tk_session`) taşındı; CSRF koruması; çıkış rotası.
- Saklanan XSS (ayarlar sayfası `company_name`) kapatıldı; kayıt alanlarında işaretleme/uzunluk doğrulaması ve sıkı e-posta deseni.
- Kritik: `/billing/success` ile ödemesiz abonelik aktivasyonu kapatıldı; mock ödeme üretimde kapalı; banka bilgisi sayfasında XSS.
- Bağımsız denetim bulguları: WhatsApp webhook açıkları, medya takip IDOR, rol/marka/aktiflik her istekte DB'den (pasif kullanıcının eski token'ı), text-to-SQL fonksiyon allow-list'i, SSRF (`isPrivateHost`), Google hesap bağlama (ön-ele-geçirme), üretim tespiti (`isProduction`).
- Ön yüzde kaçışsız basılan veri alanları (marka/etiket/başlık/URL) kaçışlandı; zehirli veriyle tüm sayfa XSS taraması: 0.

### 4 Ekim 2026 — erişilebilirlik ve mobil
- Klavye erişimi, etiketler, `public/a11y.js`, skip link, odak göstergesi, `pageTitleSr`; marka renkli zeminlerde okunur yazı (`--on-brand`); `--text-muted` kontrastı; mobil yatay taşma ve giriş sayfası dokunma sorunu düzeltildi.
- Tarayıcı denetimleri (`e2e/`): `auth-flow`, `xss-crawl`, `a11y`, `brand-contrast`, `mobile-overflow`. Sonuç: axe 0 ihlal (masaüstü + mobil), 24 markada WCAG AA kontrast.

### 4 Ekim 2026 — dayanıklılık ve ürün kararları
- Boş veritabanında 500 veren 17 rota düzeltildi (boş-DB testi); JSON gövde sınırı 1mb; AI/sorgu girdi sınırları; giriş numaralandırma ve zamanlama koruması.
- Davet kodu ile kayıt (hash'li, atomik tüketim, admin API ve arayüz); e-posta doğrulaması zorunlu (mevcut kullanıcılar muaf, kayıt oturum vermez).
- AI kotası uygulaması (atomik, fail-closed, tüm AI uçları); ödeme onaylanana kadar abonelik kısıtlı, plan değiştiren aktif müşterinin erişimi korunur.
- WhatsApp asistanı yalnızca admin onaylı numaralara cevap verir (numara maskeli log).
- Migration'lar: `006` (davet kodları, mevcut kullanıcılar doğrulanmış), `007` (WhatsApp onayı; mevcut numaralar onaysız), `008` (AI kota sayacı).
- PR #24 doğrulama notu: `npm test` 145/145, `lint:undef` ve `lint:syntax` temiz; Chromium (minify modu) giriş akışı 12/12, XSS taraması 0, axe 0 ihlal.

### Birleştirme sonrası yapılacaklar (Railway)
- `NODE_ENV=production`; WhatsApp için `WHATSAPP_APP_SECRET` ve `WHATSAPP_VERIFY_TOKEN`; Stripe/iyzico anahtarları yoksa üretimde kart ödemesi 503 (banka havalesi çalışır).
- Mevcut WhatsApp numaralarını admin ekranından yeniden onaylayın; ilk davet kodlarını Ayarlar → Davet Kodları'ndan oluşturun; `restore-drill` iş akışını bir kez elle çalıştırın.

### Belgeler
- Yeni anayasalar: `skills/guvenlik-anayasasi`, `skills/erisilebilirlik-tasarim-anayasasi`, `skills/kalite-ve-ajan-koordinasyon-anayasasi`; kimlik, abonelik, medya takip, WhatsApp ve ana anayasa güncellendi (ortam değişkenleri tablosu).

## CSP sıkılaştırma (satır içi olay yöneticileri kaldırıldı)
- 160 satır içi olay yöneticisi `data-on-*` modeline taşındı; `public/inline-actions.js` (eval'siz güvenli yorumlayıcı, birim testli) ve `scripts/codemod-inline-handlers.js` eklendi.
- Satır içi `<script>` blokları `login.js`, `signup.js`, `reset-password.js` dosyalarına taşındı.
- CSP: `script-src 'self'` + Google GSI, `script-src-attr 'none'`; `'unsafe-inline'` yalnızca stil için.
- Tarayıcı doğrulaması: `e2e/click-through.js` (32 menü sayfası, filtreler, admin kartları, bildirimler, çıkış) iki modda 92 OK, CSP ihlali 0.
- authMiddleware: kullanıcı durumu DB'den okunamazsa 503 (fail-closed).

## Canlı olay düzeltmeleri
- `master`'da kopmuş geo yardımcıları (`enrichProvinceWithReference` vb.) Model-Bölge ve `/api/provinces`'i düşürüyordu; Marka Merkezi bu yüzden "marka seçimi bulunamadı" diyordu. Düzeltildi, `lint:undef` CI'da.
- Panel açılışında marka/il yüklemesi bağımsız; `/api/brands`, `/api/provinces` kısa önbellek + son iyi liste; il tohumlaması tek uçuşta.
- TÜİK içe aktarma okumaları bloklamaz (DELETE, koşullu ALTER, ANALYZE).
- 125 hata yakalayıcının tamamı artık günlüğe yazar (`logRouteError`), `[5xx]` izleme ve global hata ara katmanı.

### 5 Ekim 2026 — küçük sertleştirmeler
- E-posta doğrulama token'ı veritabanında SHA-256 hash olarak saklanır; e-postadaki ham bağlantı değişmedi.
- Süresi dolan abonelikler saatlik tarama ile `expired` olur (`BILLING_SWEEP_INTERVAL_MS`); yeniden aktivasyonda `cancel_at_period_end` sıfırlanır; abonelik sayfasında onay bekleyen plan değişikliği gösterilir.
- Harita sayfalarından ayrılırken oluşan Leaflet `invalidateSize` yarışı giderildi (zamanlayıcılar haritanın hâlâ sayfada olduğunu kontrol eder).
- İki adımlı doğrulama (TOTP): isteğe bağlı, yönetici/süper kullanıcı için zorunlu (üretimde); kurtarma kodları, tekrar kullanım engeli, süper kullanıcı sıfırlaması; ayrıntı `skills/kimlik-dogrulama-anayasasi` §12a. Yeni ortam değişkenleri: `REQUIRE_ADMIN_2FA`, `TOTP_ENC_KEY`.
- Davet kodu marka uyuşmazlığı artık genel hata verir (kod geçerliliği sızdırılmaz); Google ile kayıt akışı için otomatik test (`GOOGLE_TOKENINFO_URL`, yalnızca üretim dışı).
- Kayıt için IP'den bağımsız genel sınır (`SIGNUP_GLOBAL_MAX`, varsayılan 200/saat): X-Forwarded-For sahtelenirse bile toplu hesap açma/e-posta taraması sınırlanır. Sızma testi (yetki, enjeksiyon, kimlik/2FA) bulguları: bkz. bu günkü rapor.
- Sızma testi bulguları giderildi: `sql-guard` virgüllü (örtük) birleşimleri sayar (en fazla 2, JOIN'lerle birlikte MAX_JOINS); `isPrivateHost` host'u kendisi normalize eder (127.1, 0177.0.0.1, 0x7f.1 ...).
- Medya Takip tarayıcısı (`media-watch-bridge.js`) depoya eklendi (canlıda hiç yoktu, sayfa boştu): kaynak başına tek indirme, dönüşümlü marka penceresi, 3 MB yanıt sınırı, ilk açılışta tarama, saatlik varsayılan zamanlama; birim + uçtan uca testler. Railway'de `MEDIA_WATCH_WEBHOOK_KEY` ve `MEDIA_WATCH_BRIDGE_AUTOSTART=true` gerekir.
- Sağlık uçları: `GET /health/ready` (herkese açık, yalnızca durum, 2 sn önbellek) ve `GET /health/deep` (yalnızca yönetici: veritabanı gecikmesi, havuz, bellek, olay döngüsü).
- AI Asistan (sohbet) sayfası ve `/api/chatbot/ask|history`: oturum + paket özelliği (`ai_insights`) + AI kotası (yardım/tanıtım ücretsiz), kullanıcı başına dakikada 20 istek, soru en çok 500 karakter, konuşma kimliği sunucuda kullanıcıdan türetilir (istemci `session_id`'si kabul edilmez), üretilen SQL yalnızca yöneticiye döner, yanıtlar kaçışlı gösterilir. Eski bilgisayar sürümünden esinlenildi, güvenlik kurallarına göre yeniden yazıldı. Testler: `tests/chatbot.test.js`, `npm run e2e:chatbot`.
- Yönetişim paneli (yalnızca yönetici): özet göstergeler (kullanıcı, yönetici 2FA oranı, kilitli hesap, abonelik durumları ve 7 günde bitecekler, AI kullanımı ve maliyeti, WhatsApp onay bekleyenler, kullanılabilir davet kodu, şüpheli IP'ler), giriş denetim kaydı (olay filtresi, imleç tabanlı sayfalama) ve sistem sağlığı (`/health/deep`). Yeni veri toplama ve herkese açık uç yok. Testler: `tests/governance.test.js`, `npm run e2e:governance`.
- Medya Takip: "Şimdi Tara" artık taramayı arka planda başlatır (202; sürerken 409) — dakikalar süren tarama istek zaman aşımına uğruyordu. Köprü durumu `/api/admin/media-watch/bridge-status` ve Yönetişim → Sistem Sağlığı'nda "Medya tarama" kartı (son çalıştırma, kaynak hataları).
