---
name: traktor-turkce-karakter-anayasasi
description: Traktör Sektör Analizi uygulamasında kullanıcıya görünen tüm UI, rapor, dashboard, seed, backend yanıtı ve dokümantasyon metinlerinde Türkçe karakter bütünlüğünü koruma kuralları. Görünen kopya ekleyen veya değiştiren her ajan bu skill'i kullanmalı; iç sistem anahtarlarını, enumları, slugları ve veritabanı alanlarını ise güvenli biçimde ASCII bırakmalıdır.
---

# Türkçe Karakter Anayasası

Bu skill, projede kullanıcıya görünen hiçbir metnin `goreli`, `ayni`, `bahce`, `Dagilim`, `Iklim`, `Il`, `satis`, `portfoy`, `yonetim` gibi ASCII Türkçe ile kalmaması için zorunlu çalışma kuralıdır.

## Ana Kural

Kullanıcıya görünen her metin doğal Türkçe karakterlerle yazılır:

- `göreli`, `aynı`, `bahçe`, `Dağılım`, `İklim`, `İl`
- `satış`, `portföy`, `yönetim`, `bağlantı`, `ürün`
- `TÜİK`, `Türkiye`, `Traktör`, `Bölgesel`, `Karşılaştırma`

ASCII Türkçe yalnızca sistemin çalışması için teknik değer olduğunda korunur.

## ASCII Kalabilecek Teknik Alanlar

Aşağıdaki alanlarda Türkçe karaktere çevrim yapılmaz:

- API path, query param, route, slug ve cache key değerleri
- JS obje anahtarı, CSS class/id, HTML data attribute adı
- Veritabanı tablo/sütun adları
- Enum/internal değerler: `bahce`, `tarla`, `kabinli`, `rollbar`, `2WD`, `4WD`
- Dosya adları ve import/export yolları
- Ham kaynak verinin orijinal kolon adları

Bu değerler ekranda gösterilecekse ayrı bir görüntü etiketi kullanılmalıdır. Örnek: internal `bahce`, UI etiketi `Bahçe`.

## Zorunlu İş Akışı

1. Görünen metin eklemeden önce metnin hangi katmanda üretildiğini bul:
   `public/app_v3.js`, `public/index.html`, `public/brand_experience.js`, `public/report_registry.js`, `server.js`, seed dosyaları veya rapor üreticileri.
2. Yeni görünen metni doğrudan Türkçe karakterli yaz.
3. Backend veya seed kaynaklı metinler UI'a geliyorsa kaynak metni de düzelt; sadece frontend makyajına güvenme.
4. Internal enum gösterilecekse `translateLabel`, kategori etiketi veya ilgili görüntü helper'ı üzerinden göster.
5. Değişiklikten sonra en az şu kontrolleri çalıştır:
   - `node --check server.js`
   - `node --check public/app_v3.js`
   - `npm run check:ui-copy`
6. Ekran etkisi varsa `http://localhost:3002` üzerinde ilgili sekmeyi yenileyip Türkçe karakter turu yap.

## Kaynak Kod Kuralı

Yeni kopyada şunları yazmak yasaktır:

| Yanlış | Doğru |
| --- | --- |
| `goreli` | `göreli` |
| `ayni` | `aynı` |
| `bahce` | `bahçe` |
| `pazar payi` | `pazar payı` |
| `Dagilim` | `Dağılım` |
| `Siralama` | `Sıralama` |
| `Portfoy` | `Portföy` |
| `Bolgesel` | `Bölgesel` |
| `Canli` | `Canlı` |
| `baglanti` | `bağlantı` |
| `urun` | `ürün` |
| `yonetim` | `yönetim` |
| `Iklim` | `İklim` |
| `Il` | `İl` |

## Runtime Koruma Katmanı

`public/app_v3.js` içindeki Türkçe kopya koruması yalnızca DOM text node'larını düzeltir. Bu katman:

- Eski backend yanıtlarından veya seed verilerinden gelen görünür ASCII Türkçe metni ekranda düzeltir.
- `script`, `style`, `code`, `pre`, `textarea`, `input` içeriklerine dokunmaz.
- CSS class, id, data attribute, route, enum ve URL değerlerini değiştirmez.

Bu katman emniyet ağıdır; kaynak metinleri Türkçe karakterli yazma zorunluluğunu kaldırmaz.

## Denetim Kuralı

`scripts/check-ui-copy.js`, görünür kopyada kalması yasak örnekleri yakalamalıdır. Yeni bir ASCII Türkçe problemi yakalanırsa:

1. Kaynak metin düzeltilir.
2. Aynı kelime/kalıp `scripts/check-ui-copy.js` denetimine eklenir.
3. Bu skill gerekiyorsa yeni örnekle güncellenir.

## Son Söz

Bu projede Türkçe karakter bir kozmetik detay değil, ürün kalitesi kuralıdır. Kullanıcıya görünen her sekme, kart, grafik etiketi, rapor metni ve boş durum doğal Türkçe ile görünmelidir.
