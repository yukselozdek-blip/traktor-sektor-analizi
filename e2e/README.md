# Tarayıcı (uçtan uca) denetimleri

Gerçek Chromium ile çalışır; yerel Postgres (`TEST_DATABASE_URL`) gerektirir. CI'ya konmadı (tarayıcı kurulumu ağır);
büyük arayüz değişikliklerinden önce/sonra elle çalıştırın. `CHROMIUM_PATH` ile tarayıcı yolu verilebilir
(`npx playwright-core install chromium` ile de indirilebilir).

| Komut | Ne yapar |
|---|---|
| `npm run e2e:auth` | Giriş (yanlış/doğru şifre), httpOnly çerez, localStorage'da anahtar olmaması, yenileme, çıkış |
| `npm run e2e:xss` | Marka/il/model/portal/medya alanlarına zararlı HTML koyup tüm sayfaları gezer; betik çalışırsa hata |
| `npm run e2e:a11y` | axe-core (WCAG 2 A/AA) taraması: giriş sayfaları + panel, masaüstü ve mobil; yatay taşma kontrolü |
| `npm run e2e:contrast` | 24 markanın her biri için renk kontrastı (marka renkli zeminlerde okunur yazı) |
| `npm run e2e:mobile` | 390 px genişlikte yatay taşma denetimi |
