---
name: Abonelik ve Ödeme Anayasası
description: Traktör Sektör Analizi platformunun 3 katmanlı abonelik (Starter/Growth/Enterprise), kapsam (rakip sayısı + tarihsel ay limiti) gating, AI sorgu kotası, WhatsApp telefon yönetimi (Enterprise), 3 ödeme sağlayıcısı (Stripe/iyzico/Banka), makbuz modu (şirketsiz başlangıç) → e-fatura geçişi, kullanım sayaçları, anomali tespiti ve "İlk Ay ₺1" promosyon mimarisini tanımlar. Yeni feature, fiyat değişimi, plan ekleme veya provider entegrasyonu yapılırken bu doküman tek otoritedir. Hiçbir yerde "haftalık rapor" gibi TÜİK aylık ritmiyle çelişen vaatler kullanılmaz.
---

# ABONELİK VE ÖDEME ANAYASASI

> Bu doküman platformun ticari katmanını tanımlar: **kim ne görür, kim ne öder, ne zaman aktive olur, AI'ı nasıl kullanır, WhatsApp'tan nasıl sorgular, faturayı nasıl alır.**

İlgili eş anayasalar:
- `../traktor_anayasasi/SKILL.md`
- `../marka-sekme-deneyim-anayasasi/SKILL.md`
- `../turkce-karakter-anayasasi/SKILL.md`

---

## 1. ÜÇ KATMANLI PLAN MİMARİSİ (FİNAL)

| Plan | Slug | Tier | Aylık | Yıllık | Persona | Kapsam |
|------|------|------|-------|--------|---------|--------|
| **Starter** | `starter` | 1 | ₺990 | ₺9.990 | Bayi, küçük distribütör | Kendi marka, son 12 ay, 50 satır export/ay |
| **Growth** | `growth` | 2 | ₺2.990 | ₺29.990 | Marka pazarlama / strateji | + 5 rakip, son 36 ay, sınırsız export, **AI 50 sorgu/ay** |
| **Enterprise** | `enterprise` | 3 | ₺9.990 | ₺99.990 | Marka GM, distribütör grup CFO | + Sınırsız rakip, tüm geçmiş, **sınırsız AI**, **WhatsApp 3 hat**, API 10K/ay |

**KDV %20 dahil** sergilenir (Türkiye KOBİ/B2B beklentisi).
Yıllık plan = aylık × 10 (yaklaşık 2,4 ay hediye / %17 indirim).

### 1.1 Plan Limit Şeması (`plan_limits` JSONB)
```json
{ "max_rivals": 5, "history_months": 36, "ai_queries_monthly": 50,
  "export_rows_monthly": -1, "api_requests_monthly": 0, "whatsapp_phones": 0 }
```
- `-1` = sınırsız
- `0` = pakette yok
- Pozitif sayı = aylık limit

---

## 2. FEATURE KEY VE KAPSAM GATING (İKİ KATMANLI)

### 2.1 Feature Keys (özellik var/yok)
- `dashboard_basic`, `map_basic`, `historical_basic`, `province_basic`, `model_catalog`, `hp_segment_basic`, `brand_summary`, `export_limited` (Starter)
- `competitor_analysis`, `brand_compare`, `model_compare`, `province_top_brand`, `model_region_analysis`, `media_watch`, `export_basic`, `weather_data`, `tarmakbir_view`, `historical_extended`, `ai_insights_limited` (Growth)
- `ai_insights`, `ai_forecast`, `ai_brief`, `automation_roadmap`, `whatsapp_query`, `priority_support`, `api_access`, `custom_reports`, `scheduled_exports`, `historical_full`, `unlimited_competitors`, `province_diff_alerts` (Enterprise)

Cumulative: Growth = Starter + Growth, Enterprise = Starter + Growth + Enterprise.

### 2.2 Backend Middleware Çifti
```js
// Özellik gate (var/yok)
app.get('/api/sales/brand-compare', authMiddleware, requireFeature('brand_compare'), handler);

// Kullanım gate (kota)
app.get('/api/insights', authMiddleware,
    requireFeature('ai_insights', 'ai_insights_limited'),  // Growth ya da Enterprise
    requireAiQuota(),                                       // aylık 50 / sınırsız (fair-use)
    handler
);
```

### 2.3 Fair-Use Mantığı
- Enterprise'da AI sorgu sınırsız ama **24 saatte 200 sorgu üstü throttle** (`429 AI_FAIR_USE_THROTTLE`).
- Growth'ta aylık 50 sorgu, dolarsa `402 AI_QUOTA_EXHAUSTED` → kullanıcı Enterprise'a yükseltir.
- Frontend'de %80'de uyarı, %100'de "Yükselt" CTA'sı.

---

## 3. ÜÇ ÖDEME SAĞLAYICISI

| Sağlayıcı | Code | Aktivasyon | Webhook |
|-----------|------|------------|---------|
| **Stripe** | `stripe` | Anında | `/api/billing/webhook/stripe` (HMAC-SHA256) |
| **iyzico** | `iyzico` | Anında | `/api/billing/webhook/iyzico` (HMAC-SHA256 + base64) |
| **Banka Havalesi** | `bank_transfer` | Manuel onay | Yok — admin onaylar |

Her provider `billing/providers.js`'te ortak arabirimle soyutlandı: `createCheckout`, `verifyWebhook`, `parseWebhookEvent`. Anahtar yoksa otomatik **MOCK MODE**.

---

## 4. ŞİRKETSİZ BAŞLANGIÇ → E-FATURA YOL HARİTASI

### 4.1 Aşama 1: Makbuz Modu (şu an)
- `invoices.invoice_type = 'receipt'`
- `invoices.is_legal_invoice = false`
- `invoices.legal_invoice_pending = true`
- Ödeme başarılı olduğunda Iyzico/Stripe panelinden gelir izlenir, vergi dairesi de oradan görür.
- Kullanıcıya **"makbuz/dekont"** PDF gönderilir; sözleşmede *"Geçici dönemde resmi fatura yerine ödeme belgesi düzenlenir"* maddesi.

### 4.2 Aşama 2: Şahıs/Limited Şirket Açılışı (1-3 ay)
- Şahıs şirketi (~₺3.000) veya LTD ŞTİ (~₺5.000-8.000) kurulumu.
- Mali Mühür (~₺400/yıl) + GİB Portal kayıt.
- E-Arşiv Fatura (yıllık brüt ≥ ₺1M zorunlu, altında gönüllü).

### 4.3 Aşama 3: Toplu Geçmiş Faturalama
Şirket kurulduğunda admin endpoint `POST /api/admin/billing/legalize-pending` ile bekleyen `receipt`'ler resmi e-arşiv faturasına çevrilir.

### 4.4 Kod Hazırlığı
- `legal/einvoice-stub.js` interface'i bekliyor (boş impl).
- Mali müşavir/entegratör seçimi yapıldığında sadece bu dosya doldurulur (Logo, Mikro, eFatura.com.tr, vb.).

### 4.5 Fatura Adresi Snapshot
Her ödeme anında müşterinin VKN/Vergi Dairesi/Adres bilgileri `invoices` satırına **snapshot** olarak yazılır. Sonradan adres değişse bile geçmiş fatura kayıtları doğru kalır.

---

## 5. WHATSAPP KANALI (Sadece Enterprise)

### 5.1 Mimari
- `whatsapp_phones` tablosu kullanıcı başına 3 telefon (E.164 format: `+905321234567`).
- Yeni telefon eklenince `admin_approved = false` — admin panelinden onaylanır (kötüye kullanım kontrolü).
- WhatsApp Business API webhook gelince:
  1. `from` numarası ile `whatsapp_phones` eşleştirilir.
  2. Bağlı kullanıcının marka bağlamı yüklenir.
  3. Sorgu işlenir; AI ile zenginleştirilirse `requireAiQuota` çalışır.
  4. Cevap WhatsApp'tan döner.

### 5.2 Endpoint'ler
- `GET /api/billing/whatsapp` — kullanıcının hatları
- `POST /api/billing/whatsapp` — telefon ekle (admin onayı bekler)
- `DELETE /api/billing/whatsapp/:id` — telefon sil
- `POST /api/billing/whatsapp/:id/approve` — admin onay

### 5.3 Sorgu Sayacı
Her WA sorgusu `usage_meters.whatsapp_query_count` artar; sınır yok ama analitik için tutulur.

---

## 6. RAKİP SEÇİMİ (Growth: 5 / Enterprise: sınırsız)

Subscription'a `rivals_selection JSONB` eklendi. `[brand_id, brand_id, ...]`.

### 6.1 Endpoint
- `GET /api/billing/rivals` — seçili rakipler + max_rivals + tüm marka listesi
- `PUT /api/billing/rivals` — yeni seçim (max_rivals aşılırsa 400)

### 6.2 UI
Subscription sayfasında **"Rakip Seçimi"** sekmesinde marka çoklu seçim. Growth'ta 5/5 dolduktan sonra yeni seçim grileşir.

### 6.3 Backend Kullanım
Marka karşılaştırma, medya radarı gibi sayfalarda yalnızca `rivals_selection` içindeki markalar listelenir. Enterprise (-1) tüm markaları görür.

---

## 7. KULLANIM SAYAÇLARI (`usage_meters`)

| Sayaç | Birim | Reset | Limit Yeri |
|-------|-------|-------|------------|
| `ai_queries_count` | sorgu | aylık (1. günü) | `plan_limits.ai_queries_monthly` |
| `ai_tokens_used` | token | aylık | analitik (limit yok) |
| `export_rows_count` | satır | aylık | `plan_limits.export_rows_monthly` |
| `api_request_count` | istek | aylık | `plan_limits.api_requests_monthly` |
| `whatsapp_query_count` | sorgu | aylık | analitik (limit yok) |
| `anomaly_flags` | sayı | aylık | sadece izleme |

Sayaçlar `getCurrentMonthMeter(userId)` upsert pattern'i ile her API çağrısında güvenle güncellenir.

---

## 8. ANOMALİ TESPİTİ (KOPYALAMA RİSKİ)

### 8.1 İzlenen Sinyaller
- 1 saatte 100+ farklı sayfa açma → `anomaly_type = 'page_burst'`
- 5 dakikada 50+ API çağrısı → `anomaly_type = 'api_spike'`
- Aynı IP'den birden fazla hesap → `anomaly_type = 'duplicate_ip'`
- Headless browser user-agent → `anomaly_type = 'bot_signature'`

`usage_anomalies` tablosuna kayıt + admin'e e-posta. Admin paneli flag'leri inceler, gerekirse aboneliği askıya alır.

### 8.2 Frontend Önlemleri
- Premium grafik kartlarında `user-select: none`, sağ tık devre dışı.
- Export çıktılarına otomatik watermark (kullanıcı email + zaman damgası, en alt satıra).
- Telif Beyanı: kayıt sırasında "Tüm raporlar telif kapsamında, ihlal halinde ₺50.000 cezai şart" onayı zorunlu.

---

## 9. "İLK AY ₺1" PROMOSYONU (TRIAL YERİNE)

Trial kopyalama riski getirdiği için kullanılmıyor. Yerine:

### 9.1 Akış
1. Kullanıcı kart bilgisini girer (Iyzico/Stripe).
2. İlk ay sadece ₺1 çekilir (`subscriptions.first_month_promo_price = 1.00`).
3. 7 gün içinde iptal hakkı (para iade).
4. 31. günde tam ücret çekilir.

### 9.2 Avantaj
- Kart kaydı zorunluluğu botları kovar.
- Anlık kazıma riski düşer.
- Dönüşüm oranı klasik trial'a yakın (~3-4x baseline).

### 9.3 Backend
```js
const first_month = req.body.use_promo ? 1.00 : null;
INSERT INTO subscriptions (..., first_month_promo_price) VALUES (..., $X)
```
İlk fatura kesilirken `first_month_promo_price` kontrolü yapılır.

---

## 10. STATUS MAKİNESİ

```
[none]
   ↓ signup
[pending] ──payment_success──→ [active]
                                    ↓ cancel
                              [active+cancel_at_period_end]
                                    ↓ period_end
                              [cancelled]

[active] ──payment_failed──→ [past_due] ──retry_success──→ [active]
                                          ──retry_fail (60d)──→ [cancelled]
```

- **Enterprise için özel**: `invoice_pending` ara durumu (havale 30-60 gün gecikse de erişim açık kalır).

---

## 11. UI / UX STANDARTLARI

### 11.1 Subscription Sayfası
- **Kullanım Kartı** (üstte): AI/export/API/WhatsApp sayaçları, kritik durumda kırmızı.
- **3 Plan Kartı**: Growth ortada **EN POPÜLER** rozetiyle, Starter solda, Enterprise sağda.
- **Period Switch**: aylık ↔ yıllık (yaklaşık 2,4 ay hediye notu).
- **Provider Seçimi**: Stripe / iyzico / Banka — `is-mock` flag'iyle sandbox göstergesi.
- **Fatura Geçmişi**: makbuz/e-arşiv tipi etiketi, "Yasal fatura bekliyor" rozeti.

### 11.2 Paywall Overlay
- Premium sayfaya yetkisiz girişte tam ekran (`paywall-overlay`).
- "Paketi yükselt" → subscription tab'ına gönderir.

### 11.3 AI Kota Uyarıları
- %80'de pasif uyarı (sarı bant)
- %100'de aktif paywall + "Enterprise'a yükselt" CTA'sı

---

## 12. ENDPOINT ENVANTERİ

| Endpoint | Metod | Yetki | Amaç |
|----------|-------|-------|------|
| `/api/plans` | GET | public | Aktif planlar |
| `/api/subscription` | GET | auth | Mevcut abonelik |
| `/api/me/features` | GET | auth | Frontend gating cache |
| `/api/billing/usage` | GET | auth | Aylık sayaçlar + uyarılar |
| `/api/billing/payment-providers` | GET | public | 3 sağlayıcı |
| `/api/billing/checkout` | POST | auth | Ödeme başlat |
| `/api/billing/cancel` | POST | auth | Dönem sonunda iptal |
| `/api/billing/invoices` | GET | auth | Fatura geçmişi |
| `/api/billing/rivals` | GET / PUT | auth | Rakip seçimi yönetimi |
| `/api/billing/whatsapp` | GET / POST | auth | Telefon listesi / ekleme |
| `/api/billing/whatsapp/:id` | DELETE | auth | Telefon sil |
| `/api/billing/whatsapp/:id/approve` | POST | adminOnly | Admin onayı |
| `/api/billing/webhook/stripe` | POST | imza | Stripe |
| `/api/billing/webhook/iyzico` | POST | imza | iyzico |
| `/api/billing/bank-confirm` | POST | adminOnly | Havale onay |
| `/api/billing/bank-pending` | GET | adminOnly | Bekleyen havaleler |
| `/api/auth/signup` | POST | public | Hesap + pending abonelik |

---

## 13. TÜİK VERİ RİTMİYLE UYUM (DEĞİŞMEZ KURAL)

❌ **YASAK**: "Haftalık rapor", "Daily insights", "Anlık güncelleme"
✅ **DOĞRU**: "Aylık tescil verisi (T+15 gün)", "Yeni dönem yayımlandığında push bildirim", "Aylık AI yönetici brifi"

İstisna: **Medya Radarı** günlük güncellenir (bu TÜİK değil, n8n medya tarama).

---

## 14. CHECKLIST: YENİ PREMIUM ÖZELLİK EKLEME

- [ ] `seed-data.js` → uygun katmanın `PLAN_FEATURE_CATALOG`'una eklendi
- [ ] Limit gerekli mi? `PLAN_LIMITS`'a sayısal limit eklendi
- [ ] Backend endpoint `requireFeature(...)` + (gerekiyorsa) `requireAiQuota()` ile sarmalandı
- [ ] Frontend `PAGE_FEATURE_GATES` haritası güncellendi
- [ ] Plan kartı features listesinde Türkçe açıklama
- [ ] Kullanım sayacı için `usage_meters`'da kolon var mı / artırılıyor mu?
- [ ] Anomali sinyali oluşturuyor mu? (örn. yeni endpoint'te abuse riski varsa `anomaly_flags`)
- [ ] `node --check server.js` geçti
- [ ] Lokal test: Starter / Growth / Enterprise kullanıcılarla manuel deneme
- [ ] Paywall overlay yetkisiz kullanıcıya gösteriliyor

---

## 15. SAYISAL TARGET (FİNANSÇI BAKIŞI)

İlk 6 ay hedef portföy:
- 100 Starter → ₺99K MRR
- 50 Growth → ₺149K MRR
- 10 Enterprise → ₺99K MRR
- **Toplam: ~₺347K MRR** = ~₺4,2M ARR

Maliyet kalemleri:
- Iyzico/Stripe komisyonu: %2,5-3,5
- AI token (Groq): aylık ~₺3K-8K (Enterprise sayısına bağlı)
- Railway/sunucu: aylık ~₺2K-5K
- Mali müşavir + KDV: aylık ~₺3K
- WhatsApp Business API: aylık ~₺500-1K

**Net marj hedefi: %75-82** (SaaS sektör ortalaması).

---

## 16. SON SÖZ

Bir kullanıcı abone olduğunda:
1. **Hangi plana abone olduğunu** banner üst sağ ve subscription sayfasında görür.
2. **Bu ay ne kadar kullandığını** kullanım kartında görür.
3. **Bir sonraki adımın** ne olduğunu (Yükselt / Token al / WA hat ekle) önerilerde görür.

Bu üçü net cevaplanamıyorsa abonelik akışı eksiktir.
