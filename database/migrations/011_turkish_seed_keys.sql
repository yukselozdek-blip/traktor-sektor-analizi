-- 011: Türkçe karakterli kayıt anahtarları (brand_portal_items / brand_portal_contacts).
--
-- Neden: marka portalı kayıtları (başlık, etiket, şehir) ON CONFLICT anahtarıdır
-- (items: brand_id, item_type, title; contacts: brand_id, contact_type, label, city).
-- database/brand-portal-seed.js bu değerleri ASCII'den Türkçeye çevirdi.
-- Seed her açılışta çalıştığı için, yalnızca seed dosyasını değiştirmek yeni satır
-- ekler ve eski ASCII satır kalır (çift kayıt). Bu migration mevcut satırları
-- yerinde yeniden adlandırır. Yeni anahtar zaten varsa (örn. yeni seed önceden
-- çalıştıysa) eski satır silinir.
--
-- Eşleşme başlık/etiket/şehir üzerinden yapılır; marka kapsamı NOT EXISTS ile
-- (aynı brand_id) korunur. Yabancı anahtar yoktur (brand_portal_* tablolarına
-- referans veren tablo yok). Idempotent: ikinci çalıştırma etkisizdir.
-- Transaction migrate.js tarafından sarılır; burada BEGIN/COMMIT yok.

-- ---------- brand_portal_items (title) ----------
-- COSIAS Konsorsiyumu TUMOSANi Konya ve Istanbulda ziyaret etti  ->  COSIAS Konsorsiyumu TÜMOSAN'ı Konya ve İstanbul'da ziyaret etti
UPDATE brand_portal_items i SET title = 'COSIAS Konsorsiyumu TÜMOSAN''ı Konya ve İstanbul''da ziyaret etti'
WHERE i.title = 'COSIAS Konsorsiyumu TUMOSANi Konya ve Istanbulda ziyaret etti' AND i.item_type = 'news'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'COSIAS Konsorsiyumu TÜMOSAN''ı Konya ve İstanbul''da ziyaret etti');
DELETE FROM brand_portal_items i
WHERE i.title = 'COSIAS Konsorsiyumu TUMOSANi Konya ve Istanbulda ziyaret etti' AND i.item_type = 'news'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'COSIAS Konsorsiyumu TÜMOSAN''ı Konya ve İstanbul''da ziyaret etti');

-- ULAQ platformunda TUMOSAN imzali yerli marin motoru devrede  ->  ULAQ platformunda TÜMOSAN imzalı yerli marin motoru devrede
UPDATE brand_portal_items i SET title = 'ULAQ platformunda TÜMOSAN imzalı yerli marin motoru devrede'
WHERE i.title = 'ULAQ platformunda TUMOSAN imzali yerli marin motoru devrede' AND i.item_type = 'news'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'ULAQ platformunda TÜMOSAN imzalı yerli marin motoru devrede');
DELETE FROM brand_portal_items i
WHERE i.title = 'ULAQ platformunda TUMOSAN imzali yerli marin motoru devrede' AND i.item_type = 'news'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'ULAQ platformunda TÜMOSAN imzalı yerli marin motoru devrede');

-- 542 noktalik bayi ve servis haritasi  ->  542 noktalık bayi ve servis haritası
UPDATE brand_portal_items i SET title = '542 noktalık bayi ve servis haritası'
WHERE i.title = '542 noktalik bayi ve servis haritasi' AND i.item_type = 'network'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = '542 noktalık bayi ve servis haritası');
DELETE FROM brand_portal_items i
WHERE i.title = '542 noktalik bayi ve servis haritasi' AND i.item_type = 'network'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = '542 noktalık bayi ve servis haritası');

-- Tarla ve bahce icin seri bazli urun kurgusu  ->  Tarla ve bahçe için seri bazlı ürün kurgusu
UPDATE brand_portal_items i SET title = 'Tarla ve bahçe için seri bazlı ürün kurgusu'
WHERE i.title = 'Tarla ve bahce icin seri bazli urun kurgusu' AND i.item_type = 'product'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Tarla ve bahçe için seri bazlı ürün kurgusu');
DELETE FROM brand_portal_items i
WHERE i.title = 'Tarla ve bahce icin seri bazli urun kurgusu' AND i.item_type = 'product'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Tarla ve bahçe için seri bazlı ürün kurgusu');

-- BASAK Traktor Konya Tarim Fuarinda ziyaretcileriyle bulusuyor  ->  BAŞAK Traktör Konya Tarım Fuarında ziyaretçileriyle buluşuyor
UPDATE brand_portal_items i SET title = 'BAŞAK Traktör Konya Tarım Fuarında ziyaretçileriyle buluşuyor'
WHERE i.title = 'BASAK Traktor Konya Tarim Fuarinda ziyaretcileriyle bulusuyor' AND i.item_type = 'news'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'BAŞAK Traktör Konya Tarım Fuarında ziyaretçileriyle buluşuyor');
DELETE FROM brand_portal_items i
WHERE i.title = 'BASAK Traktor Konya Tarim Fuarinda ziyaretcileriyle bulusuyor' AND i.item_type = 'news'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'BAŞAK Traktör Konya Tarım Fuarında ziyaretçileriyle buluşuyor');

-- BASAK Traktor AGROEXPO Izmirde yeni modellerini sergiledi  ->  BAŞAK Traktör AGROEXPO İzmir'de yeni modellerini sergiledi
UPDATE brand_portal_items i SET title = 'BAŞAK Traktör AGROEXPO İzmir''de yeni modellerini sergiledi'
WHERE i.title = 'BASAK Traktor AGROEXPO Izmirde yeni modellerini sergiledi' AND i.item_type = 'news'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'BAŞAK Traktör AGROEXPO İzmir''de yeni modellerini sergiledi');
DELETE FROM brand_portal_items i
WHERE i.title = 'BASAK Traktor AGROEXPO Izmirde yeni modellerini sergiledi' AND i.item_type = 'news'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'BAŞAK Traktör AGROEXPO İzmir''de yeni modellerini sergiledi');

-- Red Power serisi yuksek gorunurlukte konumlaniyor  ->  Red Power serisi yüksek görünürlükte konumlanıyor
UPDATE brand_portal_items i SET title = 'Red Power serisi yüksek görünürlükte konumlanıyor'
WHERE i.title = 'Red Power serisi yuksek gorunurlukte konumlaniyor' AND i.item_type = 'product'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Red Power serisi yüksek görünürlükte konumlanıyor');
DELETE FROM brand_portal_items i
WHERE i.title = 'Red Power serisi yuksek gorunurlukte konumlaniyor' AND i.item_type = 'product'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Red Power serisi yüksek görünürlükte konumlanıyor');

-- Bayi, servis ve yedek parca agi tek merkezde  ->  Bayi, servis ve yedek parça ağı tek merkezde
UPDATE brand_portal_items i SET title = 'Bayi, servis ve yedek parça ağı tek merkezde'
WHERE i.title = 'Bayi, servis ve yedek parca agi tek merkezde' AND i.item_type = 'network'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Bayi, servis ve yedek parça ağı tek merkezde');
DELETE FROM brand_portal_items i
WHERE i.title = 'Bayi, servis ve yedek parca agi tek merkezde' AND i.item_type = 'network'
  AND EXISTS (SELECT 1 FROM brand_portal_items x WHERE x.brand_id = i.brand_id AND x.item_type = i.item_type AND x.title = 'Bayi, servis ve yedek parça ağı tek merkezde');

-- ---------- brand_portal_contacts (label, city) ----------
-- Merkez ofis / Istanbul  ->  Merkez ofis / İstanbul
UPDATE brand_portal_contacts c SET label = 'Merkez ofis', city = 'İstanbul'
WHERE c.label = 'Merkez ofis' AND c.city = 'Istanbul' AND c.contact_type = 'hq'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Merkez ofis' AND x.city = 'İstanbul');
DELETE FROM brand_portal_contacts c
WHERE c.label = 'Merkez ofis' AND c.city = 'Istanbul' AND c.contact_type = 'hq'
  AND EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Merkez ofis' AND x.city = 'İstanbul');

-- Konya fabrikasi / Konya  ->  Konya fabrikası / Konya
UPDATE brand_portal_contacts c SET label = 'Konya fabrikası', city = 'Konya'
WHERE c.label = 'Konya fabrikasi' AND c.city = 'Konya' AND c.contact_type = 'factory'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Konya fabrikası' AND x.city = 'Konya');
DELETE FROM brand_portal_contacts c
WHERE c.label = 'Konya fabrikasi' AND c.city = 'Konya' AND c.contact_type = 'factory'
  AND EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Konya fabrikası' AND x.city = 'Konya');

-- Bayi ve servis haritasi / Turkiye  ->  Bayi ve servis haritası / Türkiye
UPDATE brand_portal_contacts c SET label = 'Bayi ve servis haritası', city = 'Türkiye'
WHERE c.label = 'Bayi ve servis haritasi' AND c.city = 'Turkiye' AND c.contact_type = 'network'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Bayi ve servis haritası' AND x.city = 'Türkiye');
DELETE FROM brand_portal_contacts c
WHERE c.label = 'Bayi ve servis haritasi' AND c.city = 'Turkiye' AND c.contact_type = 'network'
  AND EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Bayi ve servis haritası' AND x.city = 'Türkiye');

-- Yurt ici bayi agi / Turkiye  ->  Yurt içi bayi ağı / Türkiye
UPDATE brand_portal_contacts c SET label = 'Yurt içi bayi ağı', city = 'Türkiye'
WHERE c.label = 'Yurt ici bayi agi' AND c.city = 'Turkiye' AND c.contact_type = 'network'
  AND NOT EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Yurt içi bayi ağı' AND x.city = 'Türkiye');
DELETE FROM brand_portal_contacts c
WHERE c.label = 'Yurt ici bayi agi' AND c.city = 'Turkiye' AND c.contact_type = 'network'
  AND EXISTS (SELECT 1 FROM brand_portal_contacts x WHERE x.brand_id = c.brand_id AND x.contact_type = c.contact_type AND x.label = 'Yurt içi bayi ağı' AND x.city = 'Türkiye');
