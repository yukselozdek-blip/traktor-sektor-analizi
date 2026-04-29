# Veri Sozlugu

## Kaynaklar

- `data/TuikRapor.xlsx`
  - `TeknikVeri`: kullanici tarafindan marka ve model bazinda internetten derlenen teknik ozellikler ve fiyatlar
  - `TuikVeri`: TUIK kurumundan alinan orijinal ham satis/tescil kayitlari
- `import-tuik.js`: Excel sayfalarini `teknik_veri`, `tuik_veri` ve oradan `sales_data` tablosuna tasir
- `database/schema.sql`: kalici tablo tanimlari
- `server.js`: hangi sorguda hangi tabloyu kullanmak gerektigine dair canli is kurallari

## TeknikVeri Tablosu

Bu tablo marka ve model bazinda teknik ozellikleri tutar. Bircok alan elle derlenmis oldugu icin isimlendirme ve format tutarliligi kritiktir.

| Alan | Icerik | Format / Kural |
| --- | --- | --- |
| `Marka` | Basak, Case, Deutz, Erkunt gibi traktör markasi | Metin |
| `Model` | Markanin orijinal model adi | Metin |
| `TuikModelAdi` | TUIK raporunda yazildigi sekliyle model adi | Metin, join anahtari |
| `FiyatUSD` | Guncel fiyatin ortalama USD karsiligi | Sayi, USD, ortalama deger |
| `CekisTipi` | Tek ceker veya cift ceker bilgisi | Sadece `2wd` veya `4wd` |
| `Koruma` | Guvenlik yapisi | Sadece `Kabin` veya `Rops` |
| `VitesSayisi` | Sanziman vites konfigrasyonu | `12+12`, `8+8`, `24+24` gibi |
| `Mensei` | Uretim / ithalat bilgisi | Sadece `ithal` veya `yerli` |
| `KullanimAlani` | Kullanim sinifi | `Bahce`, `Tarla`, ikisi birden ise `Hibrit` |
| `MotorMarka` | Traktörde kullanilan motor markasi | Metin; emisyon fazina gore degisebilir |
| `EmisyonSeviyesi` | Motor emisyon fazi | Sadece `Faz2`, `Faz3A`, `Faz3B`, `Faz5` |
| `SilindirSayisi` | Motor silindir adedi | Sadece rakam |
| `MotorGucuHP` | Motor gucu | Sadece rakam, HP |
| `MotorDevriRPM` | Beygir gucunun elde edildigi motor devri | Sadece rakam, RPM |
| `MaksimumTork` | Maksimum tork degeri | Sayi; mumkunse Nm anlamiyla tutulur |
| `DepoHacmiLT` | Yakit deposu kapasitesi | Sadece rakam, litre |
| `HidrolikKaldirma` | Hidrolik kaldirma kapasitesi | Sadece rakam, kg |
| `Agirlik` | Traktor agirligi | Sadece rakam, kg |
| `DingilMesafesi` | Iki dingil arasi mesafe | Sadece rakam, mm |
| `Uzunluk` | Traktor uzunlugu | Sadece rakam, mm |
| `Yukseklik` | Traktor yuksekligi | Sadece rakam, mm |
| `Genislik` | Traktor genisligi | Sadece rakam, mm |
| `ModelYillari` | Teknik satirin gecerli oldugu model yillari | Metin; bir veya cok yil icerebilir |

## TeknikVeri Icin Dikkat Edilecek Noktalar

- `FiyatUSD` ham fiyat alani degil, guncel ortalama temsil fiyatidir.
- Ayni modelin farkli emisyon seviyeleri veya farkli motor markalari olabilir; veri satiri bu farki korumali, gereksiz birlestirme yapilmaz.
- `KullanimAlani` raw tabloda `Hibrit` olabilir. Mevcut `sales_data.category` yapisi sadece `tarla` ve `bahce` kullandigi icin bu alanla ilgili donusum yaparken etkisini kontrol et.
- Kullanici notunda `Agirlik` icin milimetre ifadesi gecse de bu alan agirlik alanidir; kg olarak yorumlanmalidir.

## TuikVeri Tablosu

Bu tablo TUIK tarafindan yayinlanan orijinal satis/tescil kayitlarini ham haliyle tutar. Model bazli satis raporlarinda birincil kaynaktir.

| Alan | Icerik | Format / Kural |
| --- | --- | --- |
| `Marka` | Basak, Case, Deutz, Erkunt gibi traktör markasi | Metin |
| `TuikModelAdi` | TUIK raporunda yazildigi sekliyle model adi | Metin, join anahtari |
| `TescilYil` | Traktorun tescil edildigi yil | Sadece rakam |
| `TescilAy` | Tescil edilen ay; TUIK raporlari ayliktir | Sadece rakam, 1-12 |
| `SehirKodu` | Turkiye illerinin plaka kodlari | Sadece rakam |
| `SehirAdi` | Il adi | Metin; gerekirse normalize edilir |
| `ModelYili` | Traktorun uretildigi model yili | Sadece rakam |
| `MotorHacmiCC` | Motor hacmi | Sayi/metin; cc degeri |
| `Renk` | Traktor rengi | Metin |
| `SatisAdet` | Ilgili marka-model satirinin satis adedi | Sadece rakam; temel KPI |

## TuikVeri Icin Dikkat Edilecek Noktalar

- `SatisAdet` neredeyse tum raporlarin merkezindeki ana metriktir.
- Raporlama iki farkli zaman ekseninde yapilabilir:
  - `TescilYil` + `TescilAy`: kaydin yayinlandigi / tescil edildigi donem
  - `ModelYili`: traktörün uretim/model yili
- Model bazli satis siralamalari ve model-toplamlari icin `tuik_veri` kullan; `sales_view` model adini tutmaz.
- Marka ve model eslestirmesi yapildiginda kisa model gostermek icin `COALESCE(teknik_veri.model, tuik_veri.tuik_model_adi)` deseni tercih edilebilir.

## Eslestirme Kurallari

`TuikVeri` ile `TeknikVeri` tablolari su iki alan uzerinden eslestirilir:

- `Marka`
- `TuikModelAdi`

Zorunlu kurallar:

1. Join anahtari `UPPER(tv.marka) = UPPER(tk.marka)` ve `UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi)` olmalidir.
2. `teknik_veri.model` gosterim alanidir; join anahtari degildir.
3. Teknik ozellikler ve fiyatlar `teknik_veri` tablosundan alinir.
4. Satis adetleri ve tescil bilgileri `tuik_veri` tablosundan alinir.
5. Ozet pazar, segment, marka ve il analizleri icin normalize katmanda `sales_view` veya `sales_data` kullanilir.

Ornek join:

```sql
SELECT
  tv.marka,
  COALESCE(tk.model, tv.tuik_model_adi) AS model,
  SUM(tv.satis_adet) AS toplam_satis,
  AVG(tk.fiyat_usd) AS ortalama_fiyat_usd
FROM tuik_veri tv
LEFT JOIN teknik_veri tk
  ON UPPER(tv.marka) = UPPER(tk.marka)
 AND UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi)
GROUP BY tv.marka, COALESCE(tk.model, tv.tuik_model_adi);
```

## Hangi Veriyi Nereden Al

- Teknik ozellik karsilastirmasi: `teknik_veri`
- Model bazli satis adedi: `tuik_veri`
- Tescil tarihi bazli trend: `tuik_veri`
- Model yili filtresiyle normalizasyon gerektiren dashboard analizi: `sales_view`
- Fiyat veya ciro: temel kaynak `teknik_veri.fiyat_usd`
- Marka bazli toplam pazar ve segment analizi: `sales_view` veya `sales_data`

## Sehir Adi Normalizasyonu

Sehir adlarinda tutarsizlik varsa asagidaki donusumleri uygula:

| Ham Deger | Normalize Deger |
| --- | --- |
| `ÇANKIRI` | `Cankiri` |
| `K.MARAŞ` | `Kahramanmaras` |
| `KAHRAMANMARAŞ` | `Kahramanmaras` |
| `Ş.URFA` | `Sanliurfa` |
| `ŞANLIURFA` | `Sanliurfa` |
| `İÇEL` | `Mersin` |
| `MERSİN` | `Mersin` |
| `AFYONKARAHİSAR` | `Afyonkarahisar` |
| `AFYONKARAHİSA` | `Afyonkarahisar` |

## Uygulama Ici Veri Akisi

1. Kullanici ham Excel'i `data/TuikRapor.xlsx` icine koyar.
2. `import-tuik.js` `TeknikVeri` sayfasini `teknik_veri` tablosuna yazar.
3. Ayni script `TuikVeri` sayfasini `tuik_veri` tablosuna yazar.
4. Script, `TuikVeri` kayitlarini `TeknikVeri` ile eslestirerek uygulamanin analitik katmani icin `sales_data` tablosunu doldurur.
5. Uygulama ekranlari ihtiyaca gore ham veya normalize tablolardan beslenir.
