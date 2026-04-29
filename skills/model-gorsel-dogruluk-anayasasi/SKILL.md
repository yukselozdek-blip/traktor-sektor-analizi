---
name: traktor-model-gorsel-dogruluk-anayasasi
description: Traktör Sektör Analizi uygulamasında model fotoğrafları, galeri kaynakları, n8n görsel taraması ve ürün görseli yayınlama kuralları. Kullanıcıya görünen hiçbir model fotoğrafı marka/seri/benzer model tahminiyle yayınlanamaz; yalnızca tam model eşleşmesi doğrulanmış ve onaylanmış görseller ana galeride gösterilir.
---

# Model Görsel Doğruluk Anayasası

Bu skill, Model Röntgeni ve benzeri ekranlarda yanlış traktör fotoğrafı yayınlanmasını engellemek için zorunlu kalite kuralıdır.

## Ana Kural

Yanlış görsel göstermek, görsel göstermemekten daha kötüdür.

Bir model fotoğrafı kullanıcıya ana ürün görseli veya galeri fotoğrafı olarak gösterilebilmesi için aynı anda şu koşulları sağlamalıdır:

- `review_status = approved`
- `model_match_level` değerlerinden biri: `exact_product_page`, `exact_model`, `manual_verified`
- `verification_status` değerlerinden biri: `official_product_page`, `manual_approved`, `manual_verified`, `exact_model`
- `confidence_score >= 0.85`

Bu koşullardan biri eksikse görsel yalnızca adaydır; ana galeride gösterilmez.

## Yasaklar

- Marka temsil görselini model fotoğrafı gibi göstermek yasaktır.
- Seri temsil görselini model fotoğrafı gibi göstermek yasaktır.
- Benzer HP, benzer kasa veya aynı marka traktörü model fotoğrafı gibi göstermek yasaktır.
- Pazar yeri, ilan veya sosyal medya görseli otomatik olarak onaylı kabul edilemez.
- `alt`, başlık, URL veya kaynak sayfa model adıyla net eşleşmiyorsa görsel yayınlanamaz.
- n8n veya scraper çıktısı doğrudan kullanıcıya yayınlanamaz; önce aday olarak kaydedilir.

## Kaynak Önceliği

1. Resmi marka ürün sayfası ve aynı sayfadaki model adıyla eşleşen görsel.
2. Resmi katalog/PDF içindeki açık model etiketi olan görsel.
3. Marka sahibi veya admin tarafından manuel onaylanmış görsel.
4. Yetkili bayi ürün sayfası ancak manuel onaydan sonra.

## Uygulama Kuralı

- `model_image_gallery` tablosu aday ve onaylı görselleri birlikte tutabilir.
- Kullanıcı ekranına yalnızca yayınlanabilir kalite kapısından geçen görseller döner.
- Aday sayısı API içinde izlenebilir, fakat aday görseller ana galeride gösterilmez.
- Emin olunmayan durumda boş/uyarı durumu gösterilir: `Doğrulanmış model fotoğrafı yok`.

## n8n Kuralı

n8n akışı görsel bulabilir, fakat dönen görseller varsayılan olarak `candidate` kabul edilir.

n8n yalnızca şu alanları kanıtlayabiliyorsa `approved` döndürebilir:

- Görselin kaynak sayfası resmi ürün sayfasıdır.
- Kaynak sayfada ürün/model adı açıkça aynı modeldir.
- Görsel `alt`, yakın başlık, JSON-LD veya katalog bağlamında aynı modele bağlıdır.

Şüphe varsa `review_status = candidate` kalır.

## Son Söz

Model görseli ticari güven unsurudur. Bir marka sahibi kendi ürününde veya rakip üründe yanlış fotoğraf görürse uygulamaya güvenmez. Bu nedenle görsel doğruluğu, görsel doluluk oranından daha önemlidir.
