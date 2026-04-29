---
name: Medya Takip ve Çoklu Kaynak Tarama Anayasası
description: Traktör Sektör Analizi platformunda Marka Medya Radarı altyapısının (6 pack tarama akışı, 33+ uluslararası RSS kaynağı, 12+ TR sektör yayını, OEM resmi basın, çoklu dil destekli RSS aggregator, AI Türkçe çeviri katmanı, n8n workflow orchestrasyonu) tek doğru kaynağıdır. Yeni kaynak eklerken, pack genişletirken, AI çeviri/özet entegrasyonu yaparken veya n8n workflow düzenlerken bu doküman okunur. media-watch-bridge.js, n8n-workflows/, /api/media-watch/* endpoint'leri ve frontend loadMediaWatchPage akışı bu kurallara göre çalışır.
---

# MEDYA TAKİP VE ÇOKLU KAYNAK TARAMA ANAYASASI

> Bu doküman platformun **istihbarat katmanını** tanımlar. Hangi kaynak hangi pack'te, ne sıklıkta taranır, marka eşleşmesi nasıl yapılır, dil/ülke bilgisi nasıl saklanır, AI çevirisi ne zaman tetiklenir.

İlgili eş anayasalar:
- `../traktor_anayasasi/SKILL.md`
- `../marka-sekme-deneyim-anayasasi/SKILL.md`
- `../abonelik-odeme-anayasasi/SKILL.md` (media_watch feature gating)
- `../turkce-karakter-anayasasi/SKILL.md`

---

## 1. ALTI PACK MİMARİSİ

| Pack | Kapsam | Tarama yöntemi | Kaynak sayısı | Otomatik tetikleme |
|------|--------|----------------|---------------|--------------------|
| **Pack 1** | Genel haber + resmi karar + video | Google News RSS | 3 query/marka | Cron `*/30 * * * *` |
| **Pack 2** | Şikayet + forum + sosyal medya | Google News RSS (site: filtreleri) | 4 query/marka | Cron |
| **Pack 3** | Markanın kendi kanalları | Google News RSS (brand.social_links) | 6 query/marka | Cron |
| **Pack 4** | Uluslararası tarım yayınları | **Doğrudan RSS** | 21 kaynak (EN/DE/FR/IT) | Cron |
| **Pack 5** | Türkiye sektör yayınları | **Doğrudan RSS** | 12 kaynak (TR) | Cron |
| **Pack 6** | OEM resmi basın bültenleri | Google News (parent OEM site:) | 9 marka grubu | Cron |

### 1.1 BRIDGE_PACKS Listesi
Default: `pack-1,pack-2,pack-3,pack-4,pack-5,pack-6`. Env değişkeni `MEDIA_WATCH_BRIDGE_PACKS` ile özelleştirilir.

### 1.2 Pack 4 Kaynak Listesi (Uluslararası)
- **EN/Global**: Reuters Agriculture, AgFunder News, Modern Farmer, Agriland (IE/UK), Farmers Weekly UK, AgWeb, Successful Farming, Farm Online (AU), AgTech Navigator, Precision Ag, FAO News, USDA News, FWI Machinery, Future Farming, Euro Farmer
- **DE**: agrarheute, topagrar
- **FR**: Réussir Machinisme, La France Agricole
- **IT**: AgroNotizie

### 1.3 Pack 5 Kaynak Listesi (TR Sektör)
Tarım Pulsu, Tarım Haber, Tarımdan Haber, Agropedia, Tarım & Yatırım, Köyden, Çiftçi Postası, Tarım Dünyası, İHA Tarım, AA Tarım, DHA Tarım, TZOB Duyurular.

### 1.4 Pack 6 Kaynak Listesi (OEM Press)
9 marka grubu: CNH (Case/New Holland), Deere (John Deere), AGCO (Massey Ferguson, Fendt, Valtra), Kubota, CLAAS, SDF (Deutz-Fahr, SAME), Argo (Landini, McCormick), YTO, Lovol.

---

## 2. KAYNAK EKLEME KURALI

### 2.1 Yeni Uluslararası Kaynak (Pack 4)
`media-watch-bridge.js` → `INTERNATIONAL_SOURCE_REGISTRY` array'ine yeni nesne ekle:
```js
{
    code: 'unique_short',         // snake_case, benzersiz
    name: 'Görünen ad',           // UI'da görünür
    rss: 'https://...',           // RSS feed URL
    language: 'en',               // ISO 639-1
    country: 'GB',                // ISO 3166-1 alpha-2 (veya 'WORLD'/'EU')
    category: 'news'              // news / tech / official / machinery
}
```

### 2.2 Yeni Türkiye Kaynağı (Pack 5)
Aynı yapı `SECTOR_PUBLICATIONS_REGISTRY` array'ine. `language: 'tr'`, `country: 'TR'`.

### 2.3 Yeni OEM Marka Grubu (Pack 6)
`OEM_PRESS_PATTERNS` haritasına yeni grup:
```js
{ '[group_code]': ['site:...com OR site:...de news press'] }
```

### 2.4 Test Yükümlülüğü
Yeni kaynak eklendikten sonra:
1. `node --check media-watch-bridge.js` syntax check
2. Lokal bridge `start-media-watch-bridge.ps1` ile başlat
3. `curl -X POST http://127.0.0.1:3011/api/media-watch/source-pack-4 -d '{}'` ile test
4. En az 1 marka için 1+ kayıt çekmesi beklenir

---

## 3. MARKA EŞLEŞTİRME (BRAND MATCHING)

### 3.1 Algoritma
`brandMatchesText(brand, ...texts)` fonksiyonu:
1. Marka adı + slug + alias listesi (ör. CASE → Case IH, CaseIH, Case Construction)
2. Tam kelime eşleşmesi (`\\b...\\b` regex) — false positive önleme
3. Lowercase + Türkçe karakter dahil

### 3.2 ALIAS_MAP Genişletme
Yeni marka için alias gerekiyorsa `ALIAS_MAP` objesine ekleyin:
```js
'YENİ_MARKA': ['Yeni Marka', 'YeniMarka', 'YM Tractors']
```

### 3.3 False Positive Riski
"CASE" gibi kısa marka adları için `\\b` zorunlu — yoksa "case study", "in case of" gibi metinler eşleşir.

---

## 4. DİL VE ÜLKE BİLGİSİ

### 4.1 Şema Sütunları (`media_watch_items`)
- `language VARCHAR(5) DEFAULT 'tr'` (ISO 639-1)
- `country_code VARCHAR(5) DEFAULT 'TR'` (ISO 3166-1)
- `original_title TEXT` — çeviri öncesi başlık snapshot'ı
- `translated_title TEXT` — AI çevirisi
- `translated_summary TEXT` — AI özetlenmiş Türkçe
- `translation_model VARCHAR(50)` — kullanılan AI model (örn. llama-3.3-70b-versatile)
- `translated_at TIMESTAMP`

### 4.2 Görüntüleme Mantığı (Frontend)
- Türkçe kayıt → orijinal title/summary
- Yabancı dil kayıt + `translated_title` doluysa → çeviri gösterilir, "TR" rozeti çıkar
- Yabancı dil + henüz çevrilmemişse → orijinal başlık + dil rozeti (EN/DE/FR/IT) + "Çevir" butonu

### 4.3 Coğrafi Kapsam KPI
Frontend Medya Radarı sayfasının üstünde 5 hücreli şerit:
- 30 gün toplam kayıt
- Son 24 saat
- Ülke sayısı + bayraklar
- Dil sayısı + ISO kodları
- Kaynak (domain) sayısı

Backend endpoint: `GET /api/media-watch/coverage?brand_id=...`.

---

## 5. AI ÇEVİRİ KATMANI

### 5.1 Endpoint
`POST /api/media-watch/translate { item_id }` — `requireFeature('ai_brief', 'media_watch')`.

### 5.2 Akış
1. Item DB'den okunur. Eğer `language === 'tr'` ise erken çıkış (`{ skipped: true }`).
2. Groq API (`llama-3.3-70b-versatile`) ile prompt:
   ```
   Aşağıdaki tarım sektörü haberini TÜRKÇE'ye çevir ve 3 cümleyle özetle.
   ```
3. JSON response: `{ translated_title, translated_summary }`
4. DB güncellenir; `original_title` korunur.
5. AI usage kaydı atılır (Enterprise/Growth kotasından düşülür).

### 5.3 Maliyet Kontrolü
- Çeviri çağrısı `requireAiQuota` ile kotalı (Growth: aylık 50, Enterprise: sınırsız fair-use).
- Otomatik toplu çeviri YASAK; kullanıcı butona basana kadar çevrilmez.

---

## 6. n8n WORKFLOW ORCHESTRASYONU

### 6.1 Mevcut Workflow'lar (`n8n-workflows/`)
- `media-watch-pack-1.json` — genel haber
- `media-watch-pack-2.json` — şikayet/forum/sosyal
- `media-watch-pack-3.json` — marka kendi kanalları
- `media-watch-pack-4.json` — uluslararası RSS aggregator
- `media-watch-pack-5.json` — TR sektör yayınları
- `media-watch-pack-6.json` — OEM resmi basın

### 6.2 Workflow Şablonu
Her pack 4 node'tan oluşur:
1. **Webhook** (`POST /webhook/media-watch-pack-X`)
2. **Ingest Payload** → `${APP_BASE_URL}/api/media-watch/ingest`
3. **Refresh Alerts** → `${APP_BASE_URL}/api/media-watch/alerts/refresh`
4. **Refresh Brief** → `${APP_BASE_URL}/api/media-watch/brief/refresh`

### 6.3 Env Değişkenleri (n8n)
```
APP_BASE_URL=http://app:3000   (Docker network)
MEDIA_WATCH_WEBHOOK_KEY=<random-secret>
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<password>
```

### 6.4 DIRECT_MODE vs n8n Mode
- Lokal/Railway tek-konteyner deploy → `MEDIA_WATCH_BRIDGE_DIRECT=true` (n8n'i bypass eder)
- Çoklu konteyner + n8n hizmeti aktif → `false` (webhook akışı)

---

## 7. MANUEL TARAMA TETİKLEMESİ

### 7.1 Endpoint
`POST /api/media-watch/run-now { pack?, brand_id? }` — `requireFeature('media_watch')` + `tier_rank >= 3` (Enterprise) veya admin.

### 7.2 Davranış
Bridge'in `/api/media-watch/push-pack-X` veya `/api/media-watch/push-all` endpoint'ini çağırır. Sonuç JSON: `{ payload_count, item_count, results }`.

### 7.3 Frontend
Status şeridindeki "Şimdi Tara" butonu. Tıklanınca:
- Disable + spinner
- Sonuç gelince toast + 1.5sn sonra `loadMediaWatchPage()` reload
- 402 ENTERPRISE_REQUIRED hatası gelirse "Aboneliğinizi yükseltin" alert

---

## 8. ZAMANLAMA VE PERFORMANS

### 8.1 Cron
- Default: `*/30 * * * *` (her 30 dakika)
- 6 pack × ~12 marka × ~3-25 query = saatte ~3000+ HTTP çağrısı
- `autorunInFlight` mutex'i ile eş zamanlı çalışma engellenir
- Pack-bazlı sıralı yürütme (paralel değil) — kaynak rate-limit'ini aşmamak için

### 8.2 Timeout
- Tek RSS çağrısı: `MEDIA_WATCH_BRIDGE_TIMEOUT_MS` (default 12000)
- Bridge dönüşü: 60sn maksimum (frontend bekleme süresi)

### 8.3 Hata Toleransı
- Bir kaynak çökerse `console.warn` log'u atılır, diğer kaynaklara devam edilir
- Pack'in tamamı başarısız olursa "bridge-error" item'ı yazılır (UI'da görünür)

---

## 9. GÜVENLİK

### 9.1 Webhook Authorization
Tüm `/api/media-watch/ingest`, `/alerts/refresh`, `/brief/refresh` endpoint'leri `x-media-watch-key` header gerektirir (`MEDIA_WATCH_WEBHOOK_KEY` env). Yoksa 401.

### 9.2 Bridge Erişimi
Bridge `127.0.0.1:3011` üzerinden çalışır (lokal-only). Internet'e açık DEĞİL. CORS sadece izinli origin'lere izin verir.

### 9.3 RSS Kaynaklarına Saldırı Riski
- `User-Agent: Traktor-Media-Watch-Bridge/1.0` ile gönderilir.
- Kaynak rate limit aşılırsa 30dk cron yeterli olmazsa interval artırılır.
- DDoS önlemi: tek kaynağa eş zamanlı 1+ istek gönderilmez (sıralı).

---

## 10. UI / UX STANDARTLARI

### 10.1 Üst Şerit Bileşenleri (loadMediaWatchPage)
```
┌─ CANLI Göstergesi (yeşil pulse) ─ Kaynak özeti (X kaynak, Y dil, Z ülke) ─ [Şimdi Tara] ─┐
├─ Coğrafi Kapsam Şeridi: 30 gün toplam | son 24 sa | Ülke | Dil | Kaynak ─────────────────┤
├─ 6'lı KPI Bandı ──────────────────────────────────────────────────────────────────────────┤
├─ Kategori Chip Bandı (Tümü, Risk, Lansman, Övgü, Şikayet, Resmî, Uluslararası, ...)──────┤
├─ Tam Genişlik Akış (kart grid 2 sütun) ───────────────────────────────────────────────────┤
└─ Alt Strip (4 sütun: Top kaynaklar, Etiketler, Coğrafi, n8n Sağlık) ──────────────────────┘
```

### 10.2 Kart Üzerinde Dil Göstergesi
- Türkçe değilse `<span class="mwx-feed-lang">EN</span>` rozeti
- Çevrilmediyse → `<button class="mwx-feed-translate"><i class="fa-language"></i></button>`
- Çevrildiyse → `<span class="mwx-feed-translated">TR ✓</span>` rozeti

### 10.3 Renk Standartları
- Coverage stat: mavi (info), yeşil (up); marka primary değil — global gösterge
- Uluslararası kategori: turuncu (#f59e0b)
- Risk Radarı: kırmızı (#f43f5e)

---

## 11. ÇEKİRDEK ENDPOINT ENVANTERİ

| Endpoint | Metod | Yetki | Amaç |
|----------|-------|-------|------|
| `/api/media-watch/overview` | GET | requireFeature('media_watch') | Marka için omurga |
| `/api/media-watch/items` | GET | requireFeature('media_watch') | Filtrelenmiş akış |
| `/api/media-watch/alerts` | GET | requireFeature('media_watch') | Açık alarmlar |
| `/api/media-watch/brief` | GET | requireFeature('ai_brief','media_watch') | Yönetici brifi |
| `/api/media-watch/ingest` | POST | webhook key | Bridge/n8n verisi |
| `/api/media-watch/sources` | GET | requireFeature('media_watch') | Kaynak registry |
| `/api/media-watch/coverage` | GET | requireFeature('media_watch') | Coğrafi/dil/kaynak istatistikleri |
| `/api/media-watch/run-now` | POST | media_watch + tier 3 | Manuel tarama tetikle |
| `/api/media-watch/translate` | POST | requireFeature('ai_brief','media_watch') | AI çeviri |
| `/api/media-watch/alerts/refresh` | POST | webhook key | Alarm yenile |
| `/api/media-watch/brief/refresh` | POST | webhook key | Brif yenile |

---

## 12. CHECKLIST: YENİ KAYNAK / PACK EKLEME

- [ ] Kaynak `INTERNATIONAL_SOURCE_REGISTRY` veya `SECTOR_PUBLICATIONS_REGISTRY` veya `OEM_PRESS_PATTERNS`'a eklendi
- [ ] `code` benzersiz, `language` ISO 639-1, `country` ISO 3166-1
- [ ] RSS URL HTTPS olmalı; HTTP ise warn-log'la geç
- [ ] Yeni alias varsa `ALIAS_MAP`'e eklendi
- [ ] `BRIDGE_PACKS` env'i veya default'unda yeni pack varsa enabled
- [ ] n8n workflow JSON'u `n8n-workflows/` altında (template'i kopyala)
- [ ] `node --check media-watch-bridge.js` geçti
- [ ] Lokal `curl http://127.0.0.1:3011/api/media-watch/sources` registry'i listeliyor
- [ ] Manuel tarama (`/api/media-watch/run-now`) yeni kaynaktan kayıt çekiyor
- [ ] Frontend kart kütüphanesinde dil/ülke bayrağı doğru görünüyor

---

## 13. SON SÖZ

Marka Medya Radarı, **markanın dünyanın her köşesindeki sesini** tek panoda toplar. Yeni bir kaynak eklemek bir tweetten daha hızlı olmalı, ama yeni bir pack eklemek bir mimari karar gibi düşünülmeli (cron yükü, rate-limit, dil çeşitliliği). Marka'nın söz duyulmadığı tek bir kaynak bile platformda **eksiklik** demektir.

Bir gün hedef: Türkiye'deki tüm tarım/sektör/sosyal medya/global haber/akademik patent/fuar/devlet duyurusu kaynaklarının haritada **80+ kaynak**, **15+ dil**, **40+ ülke** kapsamında izlenmesi.
