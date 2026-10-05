---
name: Traktor Sektor Analizi - Sistem Anayasasi
description: Türkiye Traktör Sektör Analizi uygulamasına (Node.js, PostgreSQL, Vanilla JS) ait temel mimari kurallar, veritabanı ilişkileri, TUIK veri entegrasyonu, model yılı mantığı, sayfa standartları, veri kaynağı seçim kuralları ve sunucu (Railway/Docker) dağıtım prensipleri. Bu repo üzerinde geliştirme, SQL, import, dashboard, raporlama veya veri eşleştirme yapan herhangi bir yapay zeka asistanı projeye başlamadan önce bu kılavuzu okumalı; TeknikVeri ve TuikVeri alan detayları gerektiğinde eş skill olarak `traktor-veri-sozlugu` ile birlikte kullanmalıdır.
---

## PROJE GIRIS NOKTASI

- Bu repo uzerinde herhangi bir gelistirme yapmadan once bu skill'i temel proje baglami olarak kullan.
- TeknikVeri, TuikVeri, alan anlamlari, eslestirme anahtarlari, fiyat kurallari ve sehir normalizasyonlari icin `../traktor-veri-sozlugu/SKILL.md` ve `../traktor-veri-sozlugu/references/veri-sozlugu.md` dosyalarini da oku.
- Kullanıcıya görünen UI, dashboard, rapor, seed veya backend yanıt metni değişiyorsa `../turkce-karakter-anayasasi/SKILL.md` dosyasını da oku; görünür kopyada ASCII Türkçe bırakma.
- Model fotoğrafı, galeri verisi, n8n görsel otomasyonu veya kullanıcıya görünen traktör görseli değişiyorsa `../model-gorsel-dogruluk-anayasasi/SKILL.md` dosyasını da oku; marka/seri/benzer model görselini ana model fotoğrafı gibi yayınlama.
- SQL, import, dashboard, raporlama ve veri eslestirme islerinde hangi bilginin `teknik_veri`, `tuik_veri`, `sales_data` veya `sales_view` tablosundan gelecegini bu anayasa ile veri sozlugu birlikte belirler.
- Projeyi her seferinde yeniden anlatmak yerine bu skill ve veri sozlugu skill'i sabit giris dokumani olarak kabul edilmelidir.
- **Ana dizin / indeks — diğer anayasalar (işe göre oku):**
  - Güvenlik (oturum, CSP, XSS, SQL, ödeme/webhook, WhatsApp, IDOR, kontrol listesi): `../guvenlik-anayasasi/SKILL.md`
  - Erişilebilirlik, kontrast, mobil, marka renkli zeminde okunur yazı, e2e denetimleri: `../erisilebilirlik-tasarim-anayasasi/SKILL.md`
  - Test, CI, migration, rota envanteri, `server.js` bölme, yedek/yük testi, **çok ajanlı çalışma protokolü**: `../kalite-ve-ajan-koordinasyon-anayasasi/SKILL.md`
  - Kimlik/kayıt/oturum: `../kimlik-dogrulama-anayasasi/SKILL.md`; abonelik/ödeme/AI kotası: `../abonelik-odeme-anayasasi/SKILL.md`; medya takip: `../medya-takip-anayasasi/SKILL.md`; WhatsApp asistanı: `../stratejikplan-whatsapp-sales-assistant/SKILL.md`
  - Operasyon belgeleri (kökte): `SECURITY_SETUP.md`, `PERFORMANS.md`, `BACKUP.md`, `RAILWAY_N8N_ARCHITECTURE.md`, `e2e/README.md`, `CHANGELOG.md`
- Uygulamanin lokal olarak nerede calistigi, hangi dosyanin hangi ortamda etkili oldugu ve Railway deploy akisi icin `references/deployment-runtime.md` dosyasini da oku.
- Canlı altyapı (Railway, Cloudflare, Brevo, Hetzner, Google OAuth), yayın süreci, alt-ajan kuralları, öğrenilmiş tuzaklar ve `server.js` bölme planı için `../operasyon-altyapi-anayasasi/SKILL.md`; proje durumu, açık işler ve yol haritası için kök dizindeki `PROJE_DURUMU.md` dosyasını oku.

# TRAKTÖR SEKTÖR ANALİZİ - SİSTEM ANAYASASI ("YAPAY ZEKA KURALLARI")
Bu doküman, Traktör Sektör Analizi uygulamasının mimarisini, veri hiyerarşisini ve kodlama ilkelerini belirler. Projeye dahil olan tüm yapay zeka asistanlarının (ve geliştiricilerin), projede kod yazmadan veya değişiklik yapmadan önce bu "Anayasa" kurallarını benimsemesi **ZORUNLUDUR.**

---

## 1. MİMARİ VE TEKNOLOJİ YIĞINI (TECH STACK)
- **Backend:** Node.js (v22, Dockerfile), Express.js. Giriş noktası `server.js`; **kod modüllere bölünmektedir** (`src/config.js`, `src/db.js`, `src/middleware/*`, `src/lib/*`, `src/routes/*`). Bölme sürüyor: ilerleme ve kalıp için `../operasyon-altyapi-anayasasi/SKILL.md` §7. Bölünmemiş bölümler hâlâ `server.js` içindedir (bölme kuralları: kalite anayasası §10; 13 adımlık bölme tamamlandı)
- **Veritabanı:** PostgreSQL (Railway'de v18; testlerde/CI'da v16), Railway internal bağlantı. Şema değişiklikleri `database/migrations/NNN_*.sql` ile (sıralı, değiştirilmez, yenisi eklenir)
- **Frontend:** Vanilla JavaScript (ES6+), Vanilla CSS, HTML5
  - `public/app_v3.js` - Ana uygulama (SPA, sayfa yükleyiciler)
  - `public/api_v3.js` - API client (cache destekli)
  - `public/style.css` - Tüm stiller (dark-mode temalı)
  - `public/index.html` - Ana HTML, sidebar menü
- **Grafik:** Chart.js (bar, line, pie, scatter, doughnut)
- **Harita:** Leaflet.js + GeoJSON (Türkiye il sınırları)
- **Yapay Zeka:** Groq API (Llama 3.3 70B), n8n otomasyon
- **Dağıtım:** Railway; `master`'a birleşen her değişiklik **otomatik deploy** edilir (PR → CI → squash). `railway up` kullanılmaz. Ayrıntı: `../operasyon-altyapi-anayasasi/SKILL.md` §5

**YASAK:** React, Vue, Angular, Tailwind CSS, inline style (mevcut CSS sınıfları kullanılmalı).

## 1.1 CALISMA ORTAMI VE GUNCELLEME GERCEGI
- Lokal olarak esas uygulama `http://localhost:3002` adresinde calisir.
- Production uygulama **`https://app.tarimtraktor.com`** adresindedir (eski adres `https://affectionate-blessing-production-f2fe.up.railway.app/` yedek olarak açık).
- Bu projede `localhost:3000` baska bir uygulamaya ait olabilir; gelistirme ve dogrulama yaparken varsayilan adres olarak daima `localhost:3002` kullan.
- Frontend dosyalari `public/` altindadir ve lokal Docker uygulamasina bagli volume uzerinden servis edilir; bu nedenle frontend degisiklikleri genelde tarayici yenilemesi ile gorunur.
- Backend davranislari `server.js` ve `src/` altindadir (route modulleri); bu dosyadaki degisikliklerin lokal calisan uygulamaya yansimasi icin runtime yeniden baslatmasi gerekebilir.
- Eski lokal "Railway'e Güncelle" deploy butonu / `deploy-bridge.js` akışı **artık canlıya çıkış yolu değildir**: canlıya çıkış GitHub PR + CI + `master` birleşmesiyle olur (otomatik deploy). Bu buton/bridge'e güvenme, yeni iş için kullanma.

---

## 2. VERİTABANI VE VERİ AKIŞI HİYERARŞİSİ

### A) Kaynak Katman (Ham Veri)
- **`tuik_veri`:** TÜİK Excel raporundan gelen ham tescil verisi
- **`teknik_veri`:** Traktör teknik özellikleri (HP, vites, çekiş tipi)

### B) Platform Katmanı (Normalize Veri)
- **`brands`:** Marka indeks tablosu (id, name, slug, primary_color)
- **`provinces`:** İl tablosu (id, name, plate_code, latitude, longitude, region, soil_type, climate_zone, primary_crops)
- **`tractor_models`:** Traktör modelleri (brand_id, model_name, horsepower, price_list_tl, category, cabin_type, drive_type)
- **`sales_data`:** Ana satış verisi tablosu - TÜM analitik endpoint'ler buradan beslenir

### C) `sales_data` Sütunları (KRİTİK)
| Sütun | Açıklama |
|-------|----------|
| `brand_id` | Marka FK (brands tablosu) |
| `province_id` | İl FK (provinces tablosu) |
| `year` | Tescil yılı (2020-2025) |
| `month` | Tescil ayı (1-12) |
| `quantity` | Satış adedi |
| `category` | `tarla` veya `bahce` |
| `cabin_type` | `kabinli` veya `rollbar` |
| `drive_type` | `2WD` veya `4WD` |
| `hp_range` | HP segmenti (standart aralıklar) |
| `gear_config` | Vites konfigürasyonu (`8+2`, `12+12`, `CVT` vb.) |
| `model_year` | Traktörün üretim/model yılı |

### D) Marka İsimleri Standardı (KRİTİK)
Brands tablosundaki marka isimleri aşağıdaki standart listeyle uyumlu olmalıdır:

| Standart İsim | YANLIŞ Kullanım |
|----------------|-----------------|
| CASE | ~~CASE IH~~ |
| DEUTZ | ~~DEUTZ-FAHR~~ |
| KİOTİ | ~~KIOTI~~ |

`initDB()` içinde otomatik normalizasyon çalışır. Yeni marka eklerken standart listeyi kontrol et.

### E) Fiyat Birimi — TEK KAYNAK KURALI (KRİTİK ANAYASA MADDESİ)
- **Fiyat kaynağı: `teknik_veri.fiyat_usd`** — Bu tablo tek ve mutlak fiyat kaynağıdır.
- **Para birimi: USD ($)**. Tüm fiyat ve ciro gösterimlerinde dolar kullanılır.
- `initDB()` sırasında `teknik_veri.fiyat_usd` → `tractor_models.price_usd` olarak senkronize edilir.
- Sorgularda **sadece `price_usd`** kullanılır. `price_list_tl` **ASLA** kullanılmaz.
- TL'den dolara çevirme, fallback, COALESCE gibi geçici çözümler **YASAKTIR**.
- Frontend'de `fmtPrice()` fonksiyonu otomatik $ gösterir.
- **Tek istisna:** Abonelik planı fiyatları ₺ ile gösterilir.

### F) Tablo Eşleştirme Kuralı — teknik_veri ↔ tractor_models (KRİTİK ANAYASA MADDESİ)
`teknik_veri` ve `tractor_models` tablolarının ortak eşleştirme alanları:

| teknik_veri | tractor_models | Eşleştirme |
|-------------|----------------|------------|
| `marka` | `brands.name` (FK: brand_id) | Marka eşleştirmesi |
| `tuik_model_adi` | `model_name` | Model eşleştirmesi |

**ZORUNLU KURALLAR:**
1. Model eşleştirmesi **DAİMA** `teknik_veri.tuik_model_adi` üzerinden yapılır
2. `teknik_veri.model` alanı (kısa model adı) eşleştirme için **KULLANILMAZ**
3. Senkronizasyon SQL'i: `WHERE UPPER(tm.model_name) = UPPER(tv.tuik_model_adi)`
4. Fiyat senkronizasyonu bu eşleştirme ile `teknik_veri.fiyat_usd` → `tractor_models.price_usd` aktarılır

---

## 3. MODEL YILI FİLTRESİ (N ve N-1 KURALI) - EN KRİTİK KURAL

### Kural
Tüm analitik sorgular **sadece son 2 model yılının** (N ve N-1) verilerini içermelidir. Yani bir tescil yılında (year), sadece o yıl veya bir önceki yıl üretilmiş traktörler raporlanır.

### Teknik Uygulama: `sales_view`
```sql
CREATE OR REPLACE VIEW sales_view AS
SELECT * FROM sales_data
WHERE model_year IS NULL OR year = model_year OR year = model_year + 1
```

### ZORUNLU KURALLAR:
1. **Tüm analitik SELECT sorguları `FROM sales_view` kullanmalıdır** (asla doğrudan `FROM sales_data` değil)
2. **INSERT/DELETE/ALTER işlemleri `sales_data` tablosunu kullanır** (view'a yazılamaz)
3. **Seed/reseed işlemleri `sales_data` tablosunu kullanır**
4. `model_year IS NULL` olan eski veriler geçiş döneminde dahil edilir
5. View, `initDB()` fonksiyonunda her server başlangıcında oluşturulur/güncellenir
6. **Her sayfanın üstünde model yılı bilgi notu gösterilmelidir**

### Bilgi Notu (Tüm Analitik Sayfalar)
```
ℹ Veriler model yılı bazında son 2 yılı (N ve N-1) kapsamaktadır
```
Bu not `#modelYearNote` elementi ile gösterilir. Sadece ayarlar, abonelik gibi analitik olmayan sayfalarda gizlenir.

---

## 4. HP SEGMENT STANDARTLARI (DEĞİŞTİRİLEMEZ)

Tüm HP analizlerinde aşağıdaki 11 segment kullanılır:

| Segment | HP Aralığı |
|---------|-----------|
| 1-39 | 1-39 HP |
| 40-49 | 40-49 HP |
| 50-54 | 50-54 HP |
| 55-59 | 55-59 HP |
| 60-69 | 60-69 HP |
| 70-79 | 70-79 HP |
| 80-89 | 80-89 HP |
| 90-99 | 90-99 HP |
| 100-109 | 100-109 HP |
| 110-119 | 110-119 HP |
| 120+ | 120 HP ve üzeri |

Bu segmentler `seed`, `endpoint`, `frontend` ve tüm HP tabanlı analizlerde tutarlı olmalıdır. Değiştirilmesi yasaktır.

---

## 5. DİSTRİBÜTÖR GRUPLARI (MARKA BİRLEŞTİRME)

```javascript
const distributorGroups = {
    'TÜRK TRAKTÖR (CNH)': ['new-holland', 'case-ih', 'fiat'],
    'TÜMOSAN': ['tumosan'],
    'MASSEY FERGUSON': ['massey-ferguson'],
    'MAHINDRA GRUBU (ERKUNT&MAHINDRA)': ['erkunt'],
    'SAME DEUTZ-FAHR': ['deutz-fahr', 'same'],
    'HATTAT': ['hattat'],
    'KUTLUCAN (FENDT&VALTRA)': ['fendt', 'valtra'],
    'BAŞAK': ['basak'],
    'KUBOTA': ['kubota'],
    'JOHN DEERE': ['john-deere'],
    'SOLIS': ['solis'],
    'LANDINI': ['landini', 'mccormick'],
    'ANTONIO CARRARO': ['antonio-carraro'],
    'CLAAS': ['claas']
};
```

---

## 6. FRONTEND KODLAMA STANDARTLARI

### 6.1 Dosya Yapısı
| Dosya | İçerik |
|-------|--------|
| `public/index.html` | Ana HTML, sidebar menü, top-bar (yearFilter, modelYearNote) |
| `public/app_v3.js` | Tüm sayfa yükleyicileri, navigasyon, chart tanımları |
| `public/api_v3.js` | API client (`API` objesi), cache mekanizması |
| `public/style.css` | Tüm CSS (dark-mode, bm-*, bc-*, obt-*, tm-* prefixler) |

### 6.2 SPA Navigasyon
```javascript
function navigateTo(page) {
    // 1. Chart'ları destroy et
    // 2. Harita instance'larını temizle (leafletMap, mapFullInstance, riMapInstance, _bmMap)
    // 3. Title/subtitle ayarla
    // 4. Model yılı bilgi notu ayarla
    // 5. Yıl seçici görünürlüğünü ayarla
    // 6. İlgili loader fonksiyonunu çağır
}
```

### 6.3 Yıl Seçici Kuralı
Yıl seçici (`#yearFilter`) **sadece** `selectedYear` kullanan sayfalarda gösterilir:

| Yıl Seçici GÖRÜNÜR | Yıl Seçici GİZLİ |
|---------------------|-------------------|
| dashboard | historical, total-market |
| prov-top-brand | brand-summary, distributor |
| map, map-full | hp-segment, hp-top, hp-top-il |
| sales, competitors | hp-top-model, hp-top-il-cat |
| province | obt-hp, brand-hp, hp-brand-matrix |
| regional-index | brand-compare, benchmark |
| tarmakbir, tarmakbir2 | model-region, models, weather |
| | ai-insights, subscription, settings |

Kendi içinde tarih aralığı hesaplayan sayfalar yıl seçiciye bağımlı DEĞİLDİR.

### 6.4 Yeni Sayfa Ekleme Şablonu
Yeni bir sekme eklerken şu adımlar takip edilmelidir:

1. **index.html:** Sidebar'a `<a class="menu-item" data-page="slug" onclick="navigateTo('slug')">` ekle
2. **app_v3.js - titles:** `'slug': ['Başlık', 'Alt Başlık']`
3. **app_v3.js - loaders:** `'slug': loadSlugPage`
4. **app_v3.js:** `async function loadSlugPage()` fonksiyonu yaz
5. **api_v3.js:** Gerekli API metotlarını ekle
6. **server.js:** Backend endpoint'i ekle (`FROM sales_view` kullan!)
7. **style.css:** CSS sınıflarını ekle (prefix kuralı: `bm-*`, `bc-*`, `obt-*` vb.)
8. **Yıl seçici:** `yearActivePages` dizisine eklenmeli mi kontrol et
9. **Harita temizliği:** Harita kullanıyorsa `navigateTo`'daki cleanup'a ekle

### 6.5 CSS Prefix Kuralları
| Prefix | Sayfa |
|--------|-------|
| `tm-*` | Toplam Pazar |
| `bs-*` | Brand Summary (Marka) |
| `ht-*` | HP Top kartları |
| `htm-*` | HP Top Model |
| `mf-*` | Map Full |
| `obt-*` | OBT HP |
| `bc-*` | Brand Compare (Marka Karşılaştırma) |
| `bm-*` | Benchmark (Teknik Kıyaslama) |
| `ri-*` | Regional Index |
| `mr-*` | Model-Region |
| `tb-*` | TarmakBir |

### 6.6 Sayı Formatlama Kuralları
```javascript
fmtNum(n)   // 1.500 → "1,5 B", 10.000.000 → "10 M", 2.500.000.000 → "2,5 Mr", <1000 → "1.234"
fmtPrice(n) // 5.000 → "5 B $", 8.250.000 → "8,3 M $", 1.200.000.000 → "1,2 Mr $"
fmtPct(n)   // 45.67 → "45.7%"
```

**Para Birimi Kuralı:** Traktör fiyatları veritabanında dolar ($) bazında kayıtlıdır. Tüm fiyat ve ciro gösterimlerinde **$** kullanılır, **₺** kullanılmaz. Tek istisna: abonelik planı fiyatları (₺ ile satılır).

**Kısaltma Kuralı (Türkçe):**
| Büyüklük | Kısaltma | Örnek |
|----------|----------|-------|
| Bin (1.000) | B | 5,2 B |
| Milyon (1.000.000) | M | 45,6 M |
| Milyar (1.000.000.000) | Mr | 1,2 Mr |

**Ondalık Ayracı:** Virgül kullanılır (Türkçe format). 45.6 → "45,6"

### 6.7 Chart.js Kuralları
- Canvas mutlaka `<div style="position:relative;height:XXXpx;">` içinde olmalı (sonsuz büyüme engeli)
- Chart instance'ları `charts` objesinde tutulur, sayfa değişiminde `destroy()` edilir
- Dark-mode renkleri: grid `rgba(255,255,255,0.05)`, tick `#64748b`, legend `#94a3b8`
- `datalabels: { display: false }` varsayılan

---

## 7. BACKEND API STANDARTLARI

### 7.1 Endpoint Yapısı
- Analitik endpoint'ler `server.js` ve `src/routes/*` içinde tanımlıdır (bölme sürüyor; yeni route'u, ilgili bölüm hangi dosyadaysa oraya ekle)
- Güvenlik: `authMiddleware` zorunlu
- SQL: Parametrik sorgular (`$1, $2, ANY($3)`) - SQL injection koruması
- Aggregation: Mümkünse `GROUP BY` ve `SUM()` SQL seviyesinde yapılır

### 7.2 Dinamik Yıl/Ay Hesaplama Şablonu
```javascript
const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
const maxYear = parseInt(latestRes.rows[0].max_year);
const mmRes = await pool.query('SELECT MAX(month) as mm FROM sales_view WHERE year=$1', [maxYear]);
const maxMonth = parseInt(mmRes.rows[0].mm);
const prevYear = maxYear - 1;
```
Bu pattern tüm endpoint'lerde tutarlı kullanılır. Sabit yıl yazılmaz, veriden hesaplanır.

### 7.3 `sales_view` vs `sales_data` Kullanımı
| İşlem | Tablo/View |
|-------|-----------|
| SELECT (analitik sorgular) | `sales_view` |
| INSERT (veri ekleme) | `sales_data` |
| DELETE (veri silme) | `sales_data` |
| ALTER TABLE | `sales_data` |
| COUNT (seed kontrolü) | `sales_data` |
| CREATE VIEW | `sales_data` (kaynak) |

---

## 8. DAĞITIM VE DEPLOYMENT

### 8.0 Gerçek Runtime Adresleri
- Lokal uygulama: `http://localhost:3002`
- Lokal deploy bridge: `http://127.0.0.1:3010` (eski akış, canlıya çıkış için kullanılmaz; bkz. 8.1)
- Production uygulama: `https://app.tarimtraktor.com` (eski Railway adresi yedek)
- Ayrıntılı runtime ve deploy rehberi: `references/deployment-runtime.md`

### 8.1 Dağıtım Akışı (GÜNCEL, DEĞİŞMEZ)
1. Atanmış geliştirme dalında çalış; `npm run lint:syntax` ve `npm test` yerelde geçmeli.
2. Dalı push et, **PR aç**, **CI (`test`) yeşil** olunca **squash merge** yap.
3. `master`'a birleşince **Railway otomatik deploy eder.** Elle `railway up` YAPILMAZ; "GitHub Actions deploy çalışmıyor" bilgisi **eskidir** (deploy GitHub Actions ile değil, Railway'in GitHub entegrasyonuyla yapılır).
4. Deploy sonrası canlıda (`https://app.tarimtraktor.com`) ilgili ekran/endpoint doğrulanır. Doğrulamadan "deploy tamam" varsayımı yapılmaz.
5. Railway Variables değişikliği "staged" olur; **Deploy** denmeden devreye girmez.
Tam süreç, tuzaklar, alt-ajan kuralları: `../operasyon-altyapi-anayasasi/SKILL.md`.

### 8.2 initDB Akışı
Server başlangıcında `initDB()` şu sırayla çalışır:
1. **Migrasyonları çalıştır** (`database/migrate.js` → `runMigrations`; `schema_migrations`, advisory lock, dosya başına işlem). Eski "schema.sql + satır içi ALTER" yaklaşımı 001-002 migrasyonlarına taşındı.
2. `model_year` sütunu ekle (IF NOT EXISTS)
3. `sales_view` oluştur (CREATE OR REPLACE)
4. Marka/il/plan seed et (yoksa)
5. Admin kullanıcı oluştur
6. `app.listen()` başlat

### 8.3 Reseed
```
POST /api/admin/reseed-sales
```
Tüm satış verisini silip yeniden oluşturur. `model_year` dahil (~70% aynı yıl, ~30% önceki yıl).

---

## 9. MEVCUT SEKME HARİTASI

### Temel Analizler
| Sekme | Slug | Açıklama |
|-------|------|----------|
| Dashboard | `dashboard` | Genel bakış, KPI kartları |
| Tarihsel Gelişim | `historical` | Yıllara göre trend |
| Toplam Pazar | `total-market` | Marka bazlı aylık karşılaştırma |
| Marka | `brand-summary` | Tüm markalar yıllık+aylık özet |
| Distribütör | `distributor` | Marka grupları bazında analiz |

### HP Analizleri
| Sekme | Slug | Açıklama |
|-------|------|----------|
| HP Segment | `hp-segment` | Adet/% tabloları + pasta grafik |
| Top 10 HP&Marka | `hp-top` | HP segmentlerinde en çok satan markalar |
| Top 10 HP&İl | `hp-top-il` | HP segmentlerinde en çok satıldığı iller |
| Top 10 HP&Model | `hp-top-model` | Bahçe/Tarla ayrımlı HP&Model |
| Top 10 HP&İl Seg. | `hp-top-il-cat` | Bahçe/Tarla ayrımlı HP&İl |
| OBT HP | `obt-hp` | Bahçe/Tarla HP segment adet+% birleşik |
| Marka HP Detay | `brand-hp` | Marka bazlı HP segment detayı |
| HP Marka Matris | `hp-brand-matrix` | HP-Marka çapraz tablo |

### Karşılaştırma ve Strateji
| Sekme | Slug | Açıklama |
|-------|------|----------|
| Top 10 İl&Marka | `prov-top-brand` | İl bazında en çok satan markalar |
| Marka Karşılaştırma | `brand-compare` | İki marka arası KPI, fiyat, HP dağılımı |
| Teknik Kıyaslama | `benchmark` | 4 katmanlı benchmarking (scorecard, gap, momentum, fiyat) |
| Bölgesel Mekanizasyon | `regional-index` | İl bazlı ısı haritası |
| Model-Bölge Analizi | `model-region` | Model-bölge uyumluluğu |

### Harita ve Coğrafi
| Sekme | Slug | Açıklama |
|-------|------|----------|
| Harita 1 | `map-full` | Tam ekran filtrelenebilir Türkiye haritası |
| Türkiye Haritası | `map` | İl bazlı satış dağılımı |

### TarmakBir
| Sekme | Slug | Açıklama |
|-------|------|----------|
| TarmakBir (N+N1) | `tarmakbir` | Model yılı bazlı aylık satış |
| Bütün Model Yılları | `tarmakbir2` | Marka bazlı aylık rapor |

### Diğer
| Sekme | Slug | Açıklama |
|-------|------|----------|
| Satış Analizi | `sales` | Detaylı satış verileri |
| Rakip Analizi | `competitors` | Çok boyutlu karşılaştırma |
| Model Karşılaştırma | `models` | Teknik özellik analizi |
| İl Analizi | `province` | Toprak, iklim ve ekin verileri |
| Hava & İklim | `weather` | Hava durumu ve iklim analizi |
| AI Öngörüler | `ai-insights` | Groq/Llama3 destekli yapay zeka analiz |
| Abonelik | `subscription` | Plan ve ödeme yönetimi |
| Ayarlar | `settings` | Hesap ayarları |

---

## 10. TEKNİK KIYASLAMA (BENCHMARK) 4 KATMAN MODELİ

### Katman 1: Teknik Benchmarking (Scorecards)
- Ortalama HP Gücü karşılaştırması
- Birim Güç Maliyeti (₺/HP)
- Segment bazlı pazar payı bar chart
- Kategori & donanım dağılımı (Tarla/Bahçe/4WD/Kabinli)

### Katman 2: Pazar Boşluğu (Gap Analysis)
- Hakimiyet haritası (marka1 > %20 = mavi, marka2 > %20 = kırmızı, baş başa = gri)
- HP vs Fiyat scatter plot (model konumlandırma)
- HP segment detay tablosu (adet + ağırlık + pazar payı)

### Katman 3: Büyüme & Momentum (YoY)
- Aylık satış trendi bar chart
- Pazar payı trend çizgi grafiği (5 yıl)
- YoY büyüme oranı tablosu (▲/▼ göstergeler)

### Katman 4: Fiyat & Özellik Kesişimi
- Model fiyat karşılaştırması (HP segmentine göre)
- Özellik kesişimi tablosu (4WD+Kabin+Tarla vb.)

---

## 11. ABONELİK MODELİ PLANI (GELECEK)

| Katman | Bronz | Gümüş | Altın |
|--------|-------|-------|-------|
| Temel satış adetleri | ✅ | ✅ | ✅ |
| HP/Marka/İl analizleri | ❌ | ✅ | ✅ |
| Teknik Benchmarking | ❌ | ✅ | ✅ |
| Gap Analysis & Hakimiyet Haritası | ❌ | ❌ | ✅ |
| AI Öngörüler (Groq) | ❌ | ❌ | ✅ |
| Talep Tahminleme (ARIMA+) | ❌ | ❌ | ✅ |
| Anomali Tespiti | ❌ | ❌ | ✅ |

---

## 12. WHATSAPP AI ASİSTAN (TEXT-TO-SQL)

### 12.1 Mimari
WhatsApp Business API → Webhook (`/api/public/whatsapp/webhook`; imza + onaylı numara kapısı) → Groq AI (Llama 3.3 70B) → PostgreSQL → AI Yorumlama → WhatsApp Yanıt

### 12.2 İşleyiş Zinciri
1. **Doğal Dil Sorusu** → WhatsApp'tan gelir
2. **textToSql(question)** → Groq AI, veritabanı şemasını (`DB_SCHEMA_PROMPT`) bilerek SQL üretir
3. **isSafeSql(sql)** → Güvenlik kontrolü: sadece `SELECT` izinli; `DROP`, `DELETE`, `INSERT`, `UPDATE`, `ALTER`, `TRUNCATE` yasaklı
4. **executeSafeSql(sql)** → 8 saniye timeout ile çalıştırır, maks 20 satır (`LIMIT 20`)
5. **interpretResults(question, sql, result)** → Groq AI ham veriyi yorumlar, sektörel analiz ve kısa yorum ekler
6. **WhatsApp Yanıt** → Kullanıcıya doğal dilde gönderilir

### 12.3 Güvenlik Katmanları
| Katman | Kural |
|--------|-------|
| SQL Doğrulama | `src/lib/sql-guard.js` `isSafeSql`: yalnızca `SELECT`/`WITH`, tablo allow-list'i, fonksiyon allow-list'i (ayrıntı: güvenlik anayasası §5) |
| Yasaklı Kelimeler | Yazma/DDL/`SET`/`COPY` vb. + hassas tablolar (`users`, ödeme, abonelik, `pg_*` ...) |
| Çalıştırma | Salt-okunur transaction (`SET TRANSACTION READ ONLY`) |
| Timeout | 8.000ms (8 saniye, `SET LOCAL statement_timeout`) |
| Satır Limiti | Prompt'ta `LIMIT 20` talimatı; yorumlamaya ilk 20 satır gönderilir |
| Hata Yönetimi | SQL hatası kullanıcıya "Teknik hata" olarak döner, detay loglanır |

### 12.4 Yerleşik Komutlar (Built-in Intents)
- `yardım` / `help` / `merhaba` → Asistan yetenek listesi
- `toplam satış` → Toplam adet (yıl bazlı)
- `en çok satan marka` → Top 5 marka
- `en çok satan il` → Top 5 il
- `hp dağılımı` → HP segment bazlı adet
- **Diğer tüm sorular** → Text-to-SQL fallback

### 12.5 Ortam Değişkenleri
| Değişken | Açıklama |
|----------|----------|
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook doğrulama tokeni |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API erişim tokeni |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp iş telefon numarası ID |
| `GROQ_API_KEY` | Groq API anahtarı (Llama 3.3 70B) |
| `WHATSAPP_QUERY_API_KEY` | Dahili sorgu API güvenlik anahtarı (`x-query-token`) |
| `WHATSAPP_APP_SECRET` | Webhook imzası (`X-Hub-Signature-256`); üretimde zorunlu |

Tam ortam değişkeni listesi için bölüm 14.

### 12.6 Endpoint'ler
| Yol | Metod | Açıklama |
|-----|-------|----------|
| `/api/public/whatsapp/webhook` | GET | Meta webhook doğrulama (verify token) |
| `/api/public/whatsapp/webhook` | POST | Gelen mesaj işleme + AI yanıt (imza ve onaylı numara zorunlu) |
| `/api/public/assistant/sales-query` | POST | Dahili API (`x-query-token`) - doğrudan soru gönderme |

> Eski dokümandaki `/webhook/whatsapp` ve `/api/whatsapp/query` yolları kodda yoktur (doğrulandı); güncel yollar yukarıdadır.

### 12.7 DB_SCHEMA_PROMPT
Groq AI'ya gönderilen prompt, veritabanının tam şemasını (tablolar, sütunlar, ilişkiler, örnek değerler) içerir. Bu sayede AI doğru SQL üretir. Şema güncellendiğinde `DB_SCHEMA_PROMPT` de güncellenmelidir.

---

## 13. YAPILMAMASI GEREKENLER (YASAK LİSTESİ)

1. `FROM sales_data` kullanarak analitik sorgu yazmak (sadece `FROM sales_view`)
2. HP segment aralıklarını değiştirmek
3. Sabit yıl/ay yazmak (veriden dinamik hesaplanmalı)
4. Model yılı filtresini devre dışı bırakmak
5. Canvas'ı sabit boyutlu div olmadan kullanmak
6. Chart instance'larını destroy etmeden yeni chart oluşturmak
7. Harita instance'larını temizlemeden sayfa değiştirmek
8. `authMiddleware` olmadan endpoint yazmak
9. Inline CSS veya Tailwind kullanmak
10. React/Vue/Angular framework eklemek
11. Veritabanına elle INSERT atmak (import-tuik.js kullanılmalı)
12. `master`'a doğrudan push etmek, CI yeşil olmadan birleştirmek ya da `railway up` ile elle deploy etmek (süreç: PR → CI → squash → otomatik deploy)
13. WhatsApp Text-to-SQL'de `SELECT` dışında SQL komutu izin vermek
14. `DB_SCHEMA_PROMPT`'u veritabanı şeması değişince güncellememek
15. Fiyat sorgularında `price_list_tl` kullanmak (`price_usd` tek kaynak)
16. TL fiyatını dolara çevirmek veya COALESCE ile TL fallback yapmak
17. Sırları (anahtar, parola, DB URL, token) koda, commit'e, PR'a, loga ya da sohbete yazmak
18. Mevcut migrasyon dosyasını değiştirmek (yeni dosya ekle)
19. Route envanteri snapshot'ını (`tests/snapshots/routes.txt`) route gerçekten eklenip kaldırılmadan yenilemek
20. Refactor PR'ında davranış değiştirmek (refactor ve düzeltme ayrı PR)
21. Stripe webhook ham gövde ayarını (`express.raw`, `express.json`'dan ÖNCE) taşımak/bozmak
22. Railway'de SMTP (25/465/587) ile mail göndermeyi denemek (engelli; Brevo HTTPS API kullan)
23. Kullanıcı/DB verisini ön yüzde kaçışsız `innerHTML`'e basmak; yeni satır içi `onclick=` yazmak; CDN'den betik yüklemek (bkz. güvenlik anayasası)
24. `process.env.NODE_ENV === 'production'` ile üretim tespiti yapmak (`isProduction()` kullanılır)
25. Doğrulanmamış (DB'siz `skip` olan) testle "yeşil" demek; yapısal şema değişikliğini migration dışında yapmak (bkz. kalite anayasası)

---

## 14. RAILWAY ORTAM DEĞİŞKENLERİ (KODDA OKUNANLAR)

Aşağıdaki değişkenlerin tamamı kodda okunduğu doğrulanmıştır (`grep process.env`). Hepsi isteğe bağlıdır; "üretimde" sütunu önerilen/zorunlu durumu gösterir. Sırlar yalnızca Railway'de tutulur (`SECURITY_SETUP.md`).

| Değişken | Okunduğu yer | Anlamı / varsayılan | Üretimde |
|----------|--------------|---------------------|----------|
| `NODE_ENV` | `src/lib/env.js`, `src/db.js`, `server.js` | `production` → üretim (Railway değişkenleri de üretim sayılır) | **`production` ayarla** |
| `DATABASE_URL` | `src/db.js` | PostgreSQL bağlantısı | zorunlu |
| `JWT_SECRET` | `src/config.js` | JWT imza anahtarı; yoksa her açılışta rastgele (oturumlar düşer) | zorunlu |
| `APP_BASE_URL` | `src/config.js` | Mail bağlantıları ve yönlendirme hedefi | zorunlu |
| `SUPERUSER_EMAILS` | `src/config.js` | Virgüllü superuser e-postaları (varsayılan `yukselozdek@gmail.com`) | ayarla |
| `CORS_ORIGINS` | `server.js` | İzinli ek origin'ler (CORS + CSRF Origin kontrolü) | ayarla |
| `TRUST_PROXY_HOPS` | `server.js` | Proxy atlama sayısı; varsayılan `1`, Cloudflare proxy açılınca `2` | duruma göre |
| `REDIRECT_HOSTS` | `server.js` | Bu host'lardan gelen istekleri `APP_BASE_URL`'e 301 yönlendirir (`/health` hariç) | isteğe bağlı |
| `PG_POOL_MAX` / `PG_STATEMENT_TIMEOUT_MS` / `PG_CONNECT_TIMEOUT_MS` / `PG_IDLE_TIMEOUT_MS` | `src/db.js` | Havuz üst sınırı 20 / sorgu zaman aşımı 120000 / bağlantı 10000 / boşta 30000 | `PERFORMANS.md` |
| `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS` | `server.js` | Genel API sınırı; varsayılan 600 / 60000 ms | `PERFORMANS.md` |
| `RESPONSE_CACHE_TTL_MS` | `server.js` | Kullanıcıya özel yanıt önbelleği; varsayılan 60000 (0 = kapalı) | `PERFORMANS.md` |
| `CSP_MODE` | `server.js` | `enforce` (varsayılan) \| `report` \| `off` — **yalnızca acil geri alma** | boş bırak |
| `ALLOW_MOCK_BILLING` | `src/routes/billing.js` | `1` → üretimde de mock ödeme (yalnızca bilinçli test) | **boş bırak** |
| `GOOGLE_OAUTH_CLIENT_ID` | `src/routes/signup-google.js` | Google girişi (yoksa 503) | Google kullanılıyorsa zorunlu |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `IYZICO_API_KEY` / `IYZICO_SECRET_KEY` / `IYZICO_BASE_URL` | `billing/providers.js` | Ödeme sağlayıcıları; yoksa mock (üretimde kart ödemesi 503) | kart ödemesi için |
| `BANK_TRANSFER_BANK` / `_HOLDER` / `_IBAN` / `_SWIFT` | `billing/providers.js` | Banka havalesi bilgileri | havale için |
| `WHATSAPP_APP_SECRET` | `src/routes/public.js` | Webhook imza anahtarı; **yoksa üretimde webhook 503** | zorunlu |
| `WHATSAPP_VERIFY_TOKEN` | `src/config.js` | Meta GET doğrulaması (boşsa hep 403) | zorunlu |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | `src/config.js` | Graph API ile mesaj gönderimi | zorunlu |
| `WHATSAPP_GRAPH_API_BASE` | `server.js` | Graph API tabanı; varsayılan `https://graph.facebook.com/v21.0` (testlerde sahte sunucu) | boş bırak |
| `WHATSAPP_QUERY_API_KEY` | `src/config.js` | Dahili `sales-query` anahtarı (`x-query-token`) | zorunlu |
| `MEDIA_WATCH_WEBHOOK_KEY` | `src/config.js` | Medya/n8n webhook anahtarı (yoksa `WHATSAPP_QUERY_API_KEY`) | zorunlu |
| `INSIGHTS_API_KEY` | `server.js` | `/api/insights` için `x-api-key` | ayarla |
| `GROQ_API_KEY` | `server.js`, `src/routes/media-watch.js` | Medya çevirisi (`media-watch`); ayrıca `MINIMAX_API_KEY` tanımsızsa onun yerine kullanılır | AI için |
| `MINIMAX_API_KEY` / `MINIMAX_BASE_URL` | `server.js`, `src/routes/ai-analyze.js` | AI analiz sağlayıcısı (anahtar yoksa `GROQ_API_KEY`); taban varsayılan `https://api.minimax.io/v1` (testlerde sahte sunucu) | AI için |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `BREVO_API_KEY` | `src/lib/mailer.js` | E-posta (Brevo HTTPS API Railway SMTP engeli için tercih edilir) | zorunlu (doğrulama/sıfırlama için) |
| `SERVE_MINIFIED` | `server.js` | `1` → `public/dist` küçültülmüş varlıklar (`NODE_ENV=production`'da zaten açık) | otomatik |

Ek (yalnızca ilgili özelliklerde): `N8N_WHATSAPP_PROCESSOR_URL`, `RAILWAY_SERVICE_N8N_URL`, `N8N_MODEL_INTEL_WEBHOOK_URL`, `MODEL_IMAGE_BRIDGE_URL`, `MEDIA_WATCH_BRIDGE_*`, `MEDIA_WATCH_APP_BASE_URL`, `MAIL_OUTBOX_FILE` (test). Yeni env değişkeni eklenirse bu tablo ve `SECURITY_SETUP.md` aynı işte güncellenir.

---

**SON SÖZ:** Bu anayasa, projenin tutarlılığını ve kalitesini korumak için yazılmıştır. Yeni özellik eklerken, mevcut yapıyı bozmamaya dikkat edilmelidir. Sorgu performansı, veri tutarlılığı ve kullanıcı deneyimi her zaman önceliklidir.
