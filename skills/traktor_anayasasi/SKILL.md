---
name: Traktor Sektor Analizi - Sistem Anayasasi
description: Türkiye Traktör Sektör Analizi uygulamasına (Node.js, PostgreSQL, Vanilla JS) ait temel mimari kurallar, veritabanı ilişkileri, TUIK veri entegrasyonu ve sunucu (Railway/Docker) dağıtım prensipleri. Herhangi bir yapay zeka asistanı bu projede geliştirme yapmadan önce MUTLAKA bu kılavuzu okumalı ve kurallara uymalıdır.
---

# 🚜 TRAKTÖR SEKTÖR ANALİZİ - SİSTEM ANAYASASI ("YAPAY ZEKA KURALLARI")
Bu doküman, Traktör Sektör Analizi uygulamasının mimarisini, veri hiyerarşisini ve kodlama ilkelerini belirler. Projeye dahil olan tüm yapay zeka asistanlarının (ve geliştiricilerin), projede kod yazmadan veya değişiklik yapmadan önce bu "Anayasa" kurallarını benimsemesi **ZORUNLUDUR.**

## 1. MİMARİ VE TEKNOLOJİ YIĞINI (TECH STACK)
- **Backend:** Node.js (v20+), Express.js
- **Veritabanı:** PostgreSQL (v15+)
- **Frontend:** Vanilla JavaScript (ES6+), Vanilla CSS, HTML5. (React, Vue, Angular GİBİ MODERN FRAMEWORK'LER YOKTUR! SADECE DOM MANİPÜLASYONU VE FETCH API)
- **Veri Görselleştirme:** Chart.js
- **Yapay Zeka ve Otomasyon:** Groq API (Llama 3), n8n (Harici workflow entegrasyonu için)
- **Sunucu ve Dağıtım:** Docker, Railway Cloud (Hem PostgreSQL hem Node.js Docker üzerinden Railway'de canlıda host edilir).

## 2. VERİTABANI VE VERİ AKIŞI HİYERARŞİSİ (AŞIRI KRİTİK)
Tüm analitik göstergeler (Dashboard, Marka Pazar Payları, TarmakBir, Harita) doğrudan PostgreSQL hesaplamalarına dayanır. Veritabanının kalbinde 2 ana katman vardır:

### A) Kaynak Katman (Ham Veri)
Sistem beslemesini TUIK (Türkiye İstatistik Kurumu) formatındaki kapalı Excel raporundan alır (`data/TuikRapor.xlsx`).
- **`tuik_veri`:** Tractörlerin pazar kaydını ifade eder (TescilYil, TescilAy, ModelYili, Marka, Model vb.) ve doğrudan Excel'in aynasıdır.
- **`teknik_veri`:** Traktörlerin sınır değerlerini (MotorGucuHP, VitesSayisi, CekisTipi) gösteren Excel aynasıdır.

### B) Platform Katmanı (Normalize Veri)
Dashboard'un hızlı çalışabilmesi için kaynak katmandaki veriler, platform katmanına dinamik olarak dönüştürülür:
- **`brands` ve `provinces`**: Markalar ve İller indeks tablosudur. UI bu tabloların `id` değerlerini kullanarak filtreleme yapar.
- **`sales_data` (EN ÖNEMLİ TABLO):** Uygulamadaki hemen hemen TÜM API endpoint'leri (`/api/sales/...`) veriyi buradan çeker. 
  - `year`: (Tescil Yılı / Satış Yılı)
  - `model_year`: (Traktörün Üretim Yılı)
  - `quantity`: (Satış Adedi)
  - Uygulama, `tuik_veri`'yi analiz ederken, traktör markası `brands` tablosundaki id ile eşleştirilip, HP si ve Kategorisi `teknik_veri`'den bakılıp, son olarak `sales_data` içerisine aktarılır.
  
**💡 KURAL 1:** **VERİ GÜNCELLEMELERİ ÇİFT YÖNLÜDÜR.** Eğer sisteme manuel bir TUIK Excel dosyası yüklenecekse, DAİMA `import-tuik.js` scripti kullanılmalıdır. Sistem önce `tuik_veri`'yi ezer, ardından `sales_data` platformunu bu yeni verilere göre günceller (Map eder). Veritabanına elle rastgele insert ATILMAMALIDIR.

## 3. FRONTEND KODLAMA STANDARTLARI (SPA)
1. **Routing:** Sayfalar sayfalar-arası yüklenmez (Single Page Application). Navigasyonlar `public/app.js` içerisindeki `navMap` üzerinden yönetilir. 
2. **Page Loaders:** Her sekmenin kendine ait bir render tetikleyicisi vardır (Örn: `loadDashboard`, `loadTarmakBirPage`). Bu fonksiyonlar API'ye istek (`fetch`) atar ve dönen JSON sonucunu manipüle ederek HTML'i günceller.
3. **Servis Çağrıları:** Bütün API istekleri `public/api.js` dosyasında `API` objesi içinde tanımlanıp oradan dışarı aktarılmıştır. `app.js` dosyası istek atmak için bu servisi okur.
4. **Stil ve Tasarım:** Bütün stiller `public/style.css` içindedir. Yeni bir sayfa eklendiğinde `.page-container`, `.card`, `.table-container` gibi mevcut dark-mode konseptine uygun classlar kullanılmalıdır. Ad-hoc (Tailwind veya inline css) yasaktır.

## 4. BACKEND API STANDARTLARI (`server.js`)
1. **Klasör Yapısı:** Bütün endpointler karmaşıklığın artmasına rağmen merkezî olarak `server.js` dosyasındadır.
2. **Güvenlik Çemberi:** `/api/sales/...` gibi endpoint'lerin başına muhakkak `authMiddleware` eklenmelidir. Yetkisiz girişlere JSON ile `{ error: "Yetkisiz erişim" }` yanıtı döndürülür.
3. **Analitik İşlemler Merkezi:** Postgres tarafında yük bindirmemek için; Mümkünse gruplamalar (`GROUP BY`) ve toplamlar (`SUM()`), Node.js (Backend) seviyesinde FOR döngüleri ile DEĞİL, doğrudan **SQL sorgularının içinde** yapılmalıdır. SQL'in aggregasyon fonksiyonlarına güvenilmelidir.
4. **Endpoint Tasarımı:**
   - Filtreler daima URL Query (`req.query.brand`, `req.query.year`) üzerinden alınır.
   - Her analitik uç nokta kendi içinde PostgreSQL'e bir parametrik sorgu atar; format daima `$1, $2, ANY($3)` şeklindedir (SQL Injection güvencesi).

## 5. DAĞITIM VE DEPLOYMENT (RAILWAY CLOUD)
Yazılım Railway üzerinde CI/CD olarak entegredir. Uygulamanın veri alışverişi:
1. `git push` ile ana branch olan `master` güncellenir.
2. Railway otomatik olarak hook aracıyla kaynak kodu çeker.
3. Kodları `Dockerfile` üzerinden Docker Network'üne taşır. `npm ci --omit=dev` çalıştırarak kurulumu tamamlar.
4. Railway Network içerisinde bir Postgres DB (İç haberleşmeli) bulunur. Uygulama `process.env.DATABASE_URL` okuyarak direkt bu PostgreSQL'e internal bağlanır. `DATABASE_URL` railway tarafından otomatik enjekte edilir, kod içi sabit yazılamaz.
5. **Veri Değişiklikleri / Operasyon:** Railway canlıda iken yerel (local) bilgisayarınızdaki `postgresql://localhost` geçerli DEĞİLDİR. Eğer Railway'in tablosunu uzaktan yenilemek veya scripti tazelemek gerekirse; `/api/admin/trigger-import` POST endpoint'i kullanılır ki bu endpoint `import-tuik.js` modülünü izole şekilde direkt Railway Container'ı içinde çalıştırabilsin. O dosya ise `data/TuikRapor.xlsx` konumunu okur.

## 6. MEVCUT SEKME DETAYLARI
Projede hali hazırda aşağıdaki kritik modüller inşaa edilmiştir. Yeni bir şey eklenirken bu hiyerarşi devam ettirilmelidir:
- **TarmakBir:** Kayıt Yılına ve Model Yılına (Production Year) göre aylık sektör kıyası (Örn: 2023 yılında, 2023 modelyılı traktörlerin 1-12 ay dağılımı vs 2022 modelyılı)
- **Top 10 Analizleri:** HP'ye göre, Markaya göre, İle göre matris dashboardları.
- **Suni Zeka (AI Öngörüler):** Groq/Llama3 entegreli, satışlara bakarak akıllı yazılı yorum çıkaran motor.

---
**ÖNEMLİ BİR YAPAY ZEKA GÖREVİ ALDIĞINDA BU DOSYAYI (Anayasa) FARK EDERSEN İLK YAPACAĞIN ŞEY BURADAKİ YAPININ BOZULMAMASINA DİKKAT ETMEK OLMALIDIR.** Bütün yazılım mimarisi katı ve güvenli şekilde oluşturulmuştur, bir yeri kırarsan bütün analitik sorgular (SQL) bozulabilir.
