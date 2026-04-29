---
name: Marka Sekme Deneyim Anayasası
description: Traktör Sektör Analizi platformunda her marka odaklı sekmenin (Dashboard, Marka Karşılaştırma, AI Öngörüler, Medya Radarı, Marka Merkezi vb.) uyması zorunlu olan deneyim, banner, marka bağlamı, layout, CSS, KPI, grafik ve davranış standartlarını tanımlar. Yeni bir sekme yazan ya da mevcut sekmeyi yeniden tasarlayan asistan, kod değişikliğine başlamadan önce bu anayasayı okumalıdır. Bu doküman traktor_anayasasi ve turkce-karakter-anayasasi ile birlikte uygulanır.
---

# MARKA SEKME DENEYİM ANAYASASI

> Bu anayasa, platformdaki **tüm marka bağlamlı sayfaların** ortak deneyim çerçevesini tanımlar. Her sekme bu kurallara uymalıdır. Aykırı tasarım önerisi yapılırsa kullanıcının onayı alınmadan uygulanmamalıdır.

İlgili eş anayasalar:
- `../traktor_anayasasi/SKILL.md` — proje genel mimari kuralları
- `../turkce-karakter-anayasasi/SKILL.md` — UI metinlerinde Türkçe karakter zorunluluğu
- `../traktor-veri-sozlugu/SKILL.md` — veri kaynağı seçim kuralları
- `../model-gorsel-dogruluk-anayasasi/SKILL.md` — model fotoğrafı kuralları

---

## 1. MARKA BAĞLAMI TEK KAYNAKTAN GELİR

### 1.1 Banner = Tek Marka Seçici
- **Sayfanın hiçbir yerinde "marka seç" tipi ikinci bir combobox bulunmaz.**
- Marka seçimi yalnızca üst global banner (`renderGlobalBrandBanner`) üzerinden yapılır.
- Banner, sticky biçimde `#brandBannerHost` içinde her sayfa için `navigateTo` çağrısında çizilir.
- Sayfa kodu marka kimliğini `activeBrandContext?.id || currentUser?.brand_id` üzerinden okumalıdır.

### 1.2 Rakip / Karşılaştırma Seçicileri İstisnadır
- Rakip (rival) seçici, model B seçici, segment seçici gibi **karşılaştırma odaklı** alanlar istisna olarak kalabilir; marka seçicisi DEĞİLDİR.
- Marka A her zaman bannerdaki marka olmalıdır (örn. Marka Karşılaştırma'da Marka A kilitli, Marka B opsiyonel rakip).

### 1.3 Marka Değişiminde Otomatik Yenilenme
- Banner'dan marka değiştirildiğinde sayfa otomatik yeniden yüklenmeli ve sayfa içi alt-tab durumu (varsa) korunmalıdır.
- `setActiveBrandContext(brand, { persist: currentUser?.role === 'admin' })` çağrısı sayfa girişinde yapılmalıdır.

---

## 2. SAYFA İSKELETİ STANDARDI

Her marka sekmesi şu sırayı izlemelidir:

```
[1] #brandBannerHost — banner (sticky)
[2] {page}-shell wrapper (max-width: none, width: 100%)
    [2.1] (opsiyonel) Üst durum şeridi — CANLI / son güncelleme / kısa rehber
    [2.2] KPI bandı — 4–6 kart arası, profesyonel ölçülerde
    [2.3] (opsiyonel) Sayfa-içi sekme şeridi — 3–5 odaklanmış sekme
    [2.4] Ana içerik — full width, mantıklı grid
    [2.5] (opsiyonel) Alt analiz şeridi — 3–4 kompakt destek kartı
    [2.6] (opsiyonel) AI brifi / yönetim notu paneli
```

### 2.1 Yasaklar
- Sayfa içinde ikinci bir hero/banner duplikatı (örn. `aix-hero` + global banner birlikte) **yasak**.
- Inline style **yasak**; renk-değişken için `style="--feed-color:..."` gibi CSS custom property atamaları kabul edilebilir.
- React/Vue/Angular/Tailwind/jQuery **yasak**.
- `innerHTML` içine sanitize edilmemiş veri **yasak**; `dashboardSafe` / `mediaWatchSafe` zorunludur.

### 2.2 Şablon İskeleti (örnek)
```html
<div class="{prefix}-shell">
  <section class="{prefix}-status-strip">…</section>      <!-- opsiyonel -->
  <section class="{prefix}-kpi-grid">…</section>          <!-- 4–6 kart -->
  <section class="{prefix}-tab-strip">…</section>         <!-- opsiyonel -->
  <section class="{prefix}-main">…</section>              <!-- full width -->
  <section class="{prefix}-strip-grid">…</section>        <!-- opsiyonel -->
  <section class="{prefix}-brief-panel">…</section>       <!-- opsiyonel -->
</div>
```

---

## 3. CSS KAPSAMA VE PREFIX KURALLARI

### 3.1 Sayfa-bazlı CSS Prefix'leri (zorunlu)
| Sekme | Prefix |
|-------|--------|
| Marka Karşılaştırma | `bcx-` |
| Model Karşılaştırma Stüdyosu | `mcx-` |
| Model-Bölge Analizi | `mrx-` |
| Marka Medya Radarı | `mwx-` |
| AI Öngörüler | `aix-` |
| İl Liderlik Merkezi | `ptx-` |
| İl Analizi | `pdx-` |

Yeni bir sekmeye 3 harfli benzersiz bir prefix atayın (Önce mevcutları kontrol edin).

### 3.2 Layout Kuralları
- **Width:** `{prefix}-shell` her zaman `max-width: none; width: 100%; margin: 0;` olmalıdır.
- **Gap:** Boşluk olmadan, sayfa kenarına kadar uzatılmış kart yerleşimi tercih edilir.
- **Z-index:** Sidebar 1500, banner 1200, modal 2000, leaflet harita 0–500. Bu hiyerarşiyi koruyun.

### 3.3 Renkler
- Sayfa içi vurgu rengi olarak **aktif markanın** primary/secondary/accent renkleri kullanılmalıdır (`getBrandThemeProfile(brand)`).
- Genel UI dark teması: arka plan `linear-gradient(180deg, rgba(30,41,59,0.95), rgba(15,23,42,0.92))`, kenarlık `rgba(148, 163, 184, 0.14)`, başlık `#f8fafc`, ikincil metin `#cbd5e1`, soluk metin `#94a3b8`.
- Tonlar: `is-up` (yeşil), `is-down` (kırmızı), `is-warning` (sarı), `is-analysis` (mavi), `is-opportunity` (mor), `is-forecast` (turkuaz). Bu suffix'ler tüm sekmelerde aynı semantikle kullanılır.

---

## 4. KPI KARTI STANDARDI

### 4.1 Sayı ve Yapı
- KPI bandı 4–6 kart arasında olmalıdır. 8+ kart bilişsel yük yaratır; alt sekmeye taşıyın.
- Her kart 3 alandan oluşur: `<span>` etiket, `<strong>` ana değer, `<small>` not.
- Ana değer 22–26px arası, Space Grotesk font, 800 weight; etiket 10px büyük harf 700 weight letter-spacing 0.08em.

### 4.2 İçerik
- Etiket bir KAVRAM olmalıdır (ör. "Marka Momentumu"), bir başlık değil.
- Ana değer SAYI veya KISA İFADE olmalıdır (formatNumber, formatSignedPct, formatDashboardPercent ile).
- Not değeri açıklama veya kıyaslamadır (ör. "Pazar +%4,2", "12 ay öncesine göre").
- Tahmin / forecast değerleri her zaman kaynaklı belirtilmelidir.

---

## 5. SAYFA-İÇİ SEKME ŞERİDİ (TAB STRIP)

### 5.1 Ne Zaman Kullanılır
Bir sayfa 4'ten fazla bağımsız anlatı katmanı içeriyorsa (ör. AI Öngörüler: brifing + rakip + forecast + sinyaller), sayfa-içi sekme şeridi ile bunlar bölünmelidir. Sonsuz scroll yerine **odaklı sekme**.

### 5.2 Şablon
```html
<section class="{prefix}-tab-strip">
  <button class="{prefix}-tab is-active" onclick="onPageTabChange('briefing')">
    <i class="fas fa-..."></i><span>Stratejik Brifing</span>
  </button>
  …
</section>
```

### 5.3 Davranış
- Aktif sekme `is-active` sınıfı ile öne çıkarılır (marka primary rengi dolgu veya kalın alt çizgi).
- Sekme değiştirme `state.tab = key` + sayfa yeniden render. State sayfaya özel modül-üst değişkende tutulur.
- Sekme arası geçişlerde kullanıcı seçtiği rakip/filtre kayıtlarını **kaybetmez**.

---

## 6. GRAFİK VE GÖRSELLEŞTİRME

### 6.1 Chart.js
- Tüm grafikler Chart.js ile çizilir; başka kütüphane eklenmez.
- Canvas yüksekliği `.{prefix}-chart-canvas` sınıfı ile sabitlenir (genelde 280–360px).
- Çoklu grafik aynı sayfada Chart instance'ı `_chartInstances` global haritasında tutulur ve sekme değişiminde `destroy` edilmelidir.

### 6.2 Renk
- Marka serisi her zaman **aktif markanın primary** rengi.
- Karşılaştırma rakibi varsa **rakip markanın primary** rengi.
- Sektör/pazar serisi gri (#94a3b8) veya mavi (#38bdf8).

### 6.3 Harita
- Türkiye haritası daima Leaflet + tr-cities-utf8 GeoJSON ile çizilir.
- `scrollWheelZoom: false`, `zoomControl: false`, `dragging: false` (kurumsal panolarda zoom kapalı tercih edilir).
- Choropleth dolgu yoğunluğu marka primary rengi üzerinden alpha kademeli (0.15 → 1.0).

---

## 7. VERİ ÇEKME VE HATA YÖNETİMİ

### 7.1 Paralel Çağrı
- Bir sekmede birden çok endpoint çağrılıyorsa **Promise.all + .catch** ile paralel toplanır:
  ```js
  const [a, b, c] = await Promise.all([
    API.getX(brandId).catch(() => null),
    API.getY(brandId).catch(() => []),
    API.getZ(brandId).catch(() => null)
  ]);
  ```
- Tek bir endpoint hatası tüm sayfayı bozmamalıdır; ilgili panel "veri yok / yakında" durumuna düşmelidir.

### 7.2 Empty State
- Boş veri durumunda kart tamamen gizlenmez; kısa, anlamlı bir empty-state gösterilir:
  - Simge (FA), tek cümle açıklama, gerekirse aksiyon butonu (örn. "Tarama başlat").

### 7.3 Hata Gösterimi
- Beklenmeyen hatalar `showError(err)` ile bildirilir.
- Servis bağımlılığı belirtilmesi gereken hatalar (n8n, bridge) Türkçe ve net olmalıdır: "Medya Takip servisi yanıt vermedi. n8n veya backend kontrol edilmeli."

---

## 8. GÜNCEL KALMA VE OTOMATİK TAZELEME

### 8.1 Polling
- Canlı veri içeren sekmeler (Medya Radarı, AI Öngörüler) 60 saniyede bir `loadXxx(true)` ile sessiz tazelenir.
- `setInterval` referansı `_xxxRefreshTimer` global'inde tutulur; sayfa terkinde `stopXxxAutoRefresh()` çağrılır.

### 8.2 navigateTo İçinde Temizlik
Her sayfa-spesifik kaynak (timer, harita instance, chart) navigasyon sırasında temizlenmelidir. `navigateTo` içine yeni sekme eklenirken aynı kuralla cleanup eklenmelidir.

---

## 9. AI / GROQ ENTEGRASYONU

- AI çağrıları `requestAiAnalysis(kind, payload, panelId)` üzerinden yapılır.
- Aktif marka bağlamı her AI çağrısının metadata'sına otomatik dahil edilir.
- AI brif paneli sayfanın altında veya sticky modal olarak açılır; ortadan inline yer kaplamaz.
- AI çıktıları Türkçe ve yönetim diline uygun olmalıdır; jargon yerine "açık hacim, baskı puanı, hamle" gibi pratik karar dilini kullanın.

---

## 10. METİN VE YAZIM KURALLARI

- Tüm kullanıcıya görünen metinler **doğru Türkçe karakterlerle** yazılır (ç, ğ, ı, ö, ş, ü). ASCII karşılıklar (c, g, i, o, s, u) yasak.
- Başlık: Title Case Türkçe (ör. "Stratejik Brifing", "Beyaz Alan Matrisi").
- KPI etiketi: BÜYÜK HARF + letter-spacing 0.08em.
- Tarih: `tr-TR` locale (`new Date().toLocaleDateString('tr-TR')`).
- Sayı: `formatNumber()` (binlik nokta).
- Yüzde: `%` işareti **rakamdan önce** (ör. "%4,2").

---

## 11. ERİŞİLEBİLİRLİK

- Tıklanabilir öğeler `<button>` veya `<a>` olmalıdır; `<div onclick>` kullanmayın.
- Renk tek başına anlam taşımamalıdır; renkli gösterge ikon ve metinle desteklenmelidir.
- Klavye kullanıcısı için sekme şeridi gezinilebilir olmalıdır.

---

## 12. PERFORMANS

- 30+ kayıt listelenen akışlarda virtualizasyon olmasa bile `.slice(0, 40)` gibi güvenli sınır konur.
- Aynı sayfada 6'dan fazla Chart oluşturmayın; sayfa-içi sekme ile bölün.
- Tablo/akış kartları içinde resim varsa lazy-load (`loading="lazy"`).

---

## 13. SAYFA EKLEME / DEĞİŞTİRME CHECKLISTİ

Yeni bir marka sekmesi eklerken veya mevcut sekmeyi yeniden tasarlarken:

- [ ] `index.html` sidebar menüsüne madde eklendi mi? (data-page, ikon, label)
- [ ] `app_v3.js` `pageLoaders` ve `PAGE_TITLES` map'lerine yeni `page` key eklendi mi?
- [ ] `PAGE_HERO_TITLES` map'inde sayfa için anlamlı başlık tanımlandı mı?
- [ ] `PAGES_WITH_FILTER` set'ine filtre paneli olan sayfalar eklendi mi?
- [ ] Marka seçici sayfa içinden kaldırıldı; banner tek kaynak mı?
- [ ] Sayfa CSS prefix'i benzersiz ve sınıflar `{prefix}-` ile ön ekli mi?
- [ ] Inline style yok, `dashboardSafe` her dinamik metinde kullanıldı mı?
- [ ] Boş veri / hata durumu için empty-state mevcut mu?
- [ ] Türkçe karakter doğrulaması yapıldı mı?
- [ ] `node --check public/app_v3.js` syntax doğrulaması geçti mi?
- [ ] Cache buster `index.html` içinde bir adım ileri alındı mı (`?v=...`)?
- [ ] Lokal `localhost:3002` üzerinde marka değişimi + alt-tab + boş veri + hata path'leri test edildi mi?

---

## 14. KAPSAM DIŞI BIRAKILAN

- TarmakBir, Abonelik, Ayarlar, Bildirim Paneli marka bağlamından bağımsızdır; bu anayasanın "marka değişimi otomatik yenileme" bölümü onlara uygulanmaz.
- Admin-only sayfalar (Model Görsel Yönetimi, Tarmakbir2) marka bağlamı yerine global yönetim bağlamı kullanır; banner gösterilebilir ama marka switcher gizlenebilir.

---

## SON SÖZ

Bir marka sekmesi açıldığında kullanıcının zihninde 3 saniyede şu yanıtlar oluşmalıdır:

1. **Hangi marka?** → Banner'dan
2. **Bu sekme nedir?** → Banner ortasındaki sayfa hero başlığı
3. **Şu an ne yapmalıyım?** → KPI bandı + üst memo / brifing

Sekme bu üç soruyu net cevaplayamıyorsa yeniden tasarlanmalıdır.
