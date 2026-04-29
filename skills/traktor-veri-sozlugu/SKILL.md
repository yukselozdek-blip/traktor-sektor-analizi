---
name: traktor-veri-sozlugu
description: TeknikVeri, TuikVeri, sales_data, sales_view ve tractor_models alanlarini dogru kaynaktan kullanma; marka + tuik_model_adi eslestirmesi yapma; fiyat ve teknik ozellikleri teknik_veri'den, model bazli satislari tuik_veri'den, ozet analitikleri sales_view'dan alma. Use when Codex needs to build SQL, imports, joins, charts, filters, or data cleaning for this tractor sector analysis project.
---

# Traktor Veri Sozlugu

Bu skill, projedeki ham ve normalize traktör verilerini karistirmadan kullanmak icin referans gorevi gorur.

## Izlenecek Yol

1. Teknik ozellik, motor, koruma, cekis, vites ve fiyat gerekiyorsa `references/veri-sozlugu.md` icindeki `TeknikVeri` alanlarini esas al.
2. Model bazli satis, tescil tarihi, model yili, sehir ve adet gerekiyorsa `TuikVeri` alanlarini esas al.
3. `teknik_veri` ile `tuik_veri` arasinda eslestirme yaparken daima `marka + tuik_model_adi` kullan.
4. Kisa model adi gostermek gerekiyorsa `teknik_veri.model` kullan; ancak join anahtari olarak bunu kullanma.
5. Ozet dashboard ve segment analizi icin `sales_view` veya `sales_data` kullan; model bazli satis listelerinde dogrudan `tuik_veri` kullan.

## Temel Kurallar

- Ham kaynak Excel dosyasi `data/TuikRapor.xlsx` icindeki `TeknikVeri` ve `TuikVeri` sayfalaridir.
- Ham verilerin veritabanina aktarim mantigi `import-tuik.js` dosyasinda tanimlidir.
- Kalici tablo semasi `database/schema.sql` icinde yer alir.
- Projede daha genis mimari kurallar gerekiyorsa `skills/traktor_anayasasi/SKILL.md` dosyasini da oku.
- Sehir adlariyla ilgili tutarsizliklarda referanstaki normalizasyon tablosunu uygula.
- `FiyatUSD` guncel ortalama USD degeri olarak ele alinmali; tekil ilan fiyati gibi degil, temsil edici ortalama deger olarak yazilmalidir.
- `EmisyonSeviyesi` icin sadece `Faz2`, `Faz3A`, `Faz3B`, `Faz5` kullan; `Stage` veya `Tier` ifadelerini raw veri icine yazma.
- `CekisTipi` raw `teknik_veri` seviyesinde `2wd` veya `4wd` olarak tutulur; normalize alanlara aktarirken uygulamanin bekledigi formati koru.

## Referans

Detayli alan sozlugu, raporlama kurallari ve eslestirme ornekleri icin `references/veri-sozlugu.md` dosyasini oku.
