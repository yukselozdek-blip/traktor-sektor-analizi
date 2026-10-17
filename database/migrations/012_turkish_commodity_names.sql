-- 012: Emtia adları Türkçe karakterle (commodity_prices.commodity_name).
-- Anahtar commodity_code'dur; ad yalnızca görünen metindir. Seed tablo boşken eklediği için
-- mevcut satırlar burada güncellenir. Idempotent.
UPDATE commodity_prices SET commodity_name = 'Buğday' WHERE commodity_code = 'WHEAT' AND commodity_name = 'Bugday';
UPDATE commodity_prices SET commodity_name = 'Mısır' WHERE commodity_code = 'CORN' AND commodity_name = 'Misir';
UPDATE commodity_prices SET commodity_name = 'Ayçiçeği' WHERE commodity_code = 'SUNFLOWER' AND commodity_name = 'Aycicegi';
UPDATE commodity_prices SET commodity_name = 'Şeker Pancarı' WHERE commodity_code = 'SUGAR_BEET' AND commodity_name = 'Seker Pancari';
