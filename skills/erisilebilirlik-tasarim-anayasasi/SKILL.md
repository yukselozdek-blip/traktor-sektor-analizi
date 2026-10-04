---
name: Erişilebilirlik ve Tasarım Anayasası
description: Traktör Sektör Analizi ön yüzünün erişilebilirlik (WCAG 2 AA), renk kontrastı, marka renkli zeminde okunur yazı (--on-brand, applyReadableBrandText), --text-muted, klavye erişimi, odak göstergesi, skip link, başlık hiyerarşisi, reduced-motion ve mobil (390 px yatay taşma yok) kuralları için tek doğru kaynak. public/ altında HTML/CSS/JS, yeni sayfa/kart/form/buton/tablo/modal, marka teması (brand_experience.js), mobil düzen veya renk değiştirilirken; ayrıca axe, kontrast, mobil taşma ve XSS tarayıcı denetimleri (e2e/) çalıştırılırken bu doküman okunur.
---

# ERİŞİLEBİLİRLİK VE TASARIM ANAYASASI

> Hedef: **WCAG 2 AA** (A + AA, 2.0/2.1 etiketleri). Ekim 2026 çalışmasında axe taraması masaüstü ve mobilde 0 ihlale, 24 markanın tamamı kontrast taramasında temiz sonuca getirildi (PR #24). Aşağıdaki kurallar bu durumun bozulmasını önler.

İlgili eş anayasalar:
- `../traktor_anayasasi/SKILL.md` (frontend dosya yapısı, CSS prefix kuralları)
- `../marka-sekme-deneyim-anayasasi/SKILL.md` (marka sekme deneyimi)
- `../turkce-karakter-anayasasi/SKILL.md` (görünür metin)
- `../guvenlik-anayasasi/SKILL.md` (XSS/kaçış, CSP, satır içi olay yöneticisi yasağı)
- `../kalite-ve-ajan-koordinasyon-anayasasi/SKILL.md` (test ve doğrulama)

---

## 1. RENK VE KONTRAST

### 1.1 Eşikler
- Normal metin ≥ **4.5:1**, büyük metin ve arayüz bileşenleri ≥ 3:1.
- Marka renkli zeminlerde pratik hedef **5.2:1** (yarı saydam yüzeylerde kalan pay için, bkz. §2).

### 1.2 `--text-muted` kuralı
`public/style.css` `:root` (doğrulanan değerler):

| Değişken | Değer | Koyu zeminde kontrast (`#0f172a` / `#1e293b` / `#273548`) |
|----------|-------|--------------------------------------------------------|
| `--text-primary` | `#f1f5f9` | yüksek |
| `--text-secondary` | `#a5b4c8` | 8.47 / 6.94 / 5.90 |
| `--text-muted` | `#8f9fb7` | 6.64 / 5.44 / 4.62 |

- Eskiden `--text-muted` `#64748b` idi ve AA'yı geçmiyordu (`#1e293b` üzerinde 3.07). **`--text-muted`'ı bu değerden daha koyu/soluk yapma**; metin için `#64748b` ve daha soluk renkler KULLANILMAZ.
- Yeni metin rengi koyu kart (`--bg-card` `#1e293b`) ve hover (`--bg-card-hover` `#273548`) üzerinde ≥ 4.5:1 olmalıdır.
- Renk tek başına anlam taşımaz (artış/azalış için ▲/▼ veya metin de kullanılır).
- Sabit hex renk yazmak yerine mevcut CSS değişkenleri kullanılır.

---

## 2. MARKA RENKLİ ZEMİNDE OKUNUR YAZI

Her marka kendi `primary_color`'ını taşır (24 marka); açık renkli markada beyaz yazı okunmaz. Kural: **marka renkli zemin (`var(--brand-primary)` arka planı) üzerindeki yazı sabit beyaz/siyah YAZILMAZ; `--on-brand` ailesi kullanılır.**

`public/app_v3.js` → `applyReadableBrandText()` (marka teması uygulandıktan sonra `applyBrandTheme` içinde çağrılır):
- `--brand-primary`'ye göre beyaz (`255,255,255`) ya da koyu (`11,18,32`) seçer. **Eşik 5.2**: beyazın kontrastı ≥ 5.2 ise veya koyudan yüksekse beyaz.
- Yazdığı değişkenler: `--on-brand` (düz renk), `--on-brand-soft` (düz renk; saydamlık kontrastı düşürdüğü için), `--on-brand-line` (`rgba(on, 0.30)`, çizgi/kenarlık).
- **`--brand-text` override:** marka temasından gelen `--brand-text` marka zemininde 4.5:1'in altındaysa `--on-brand` ile değiştirilir.
- CSS'te marka zemini üzerindeki yazı: `color: var(--on-brand, #fff)` (yedek değer ile). Marka banner'ında küçük yazılar yarı saydam DEĞİL, düz renktir (kontrast ≥ 4.5 düzeltmesi).
- Yeni "marka renkli" bileşen: `background: var(--brand-primary)` + `color: var(--on-brand, #fff)`; `color:#fff` ve `rgba(255,255,255,.x)` yazma. Zeminde gradient/görsel varsa en kötü noktadaki kontrast denetlenir.
- Eşiği veya `--on-brand` hesabını değiştirmek **koordinatör onayı** ve `npm run e2e:contrast` (24 marka) gerektirir.

---

## 3. `public/a11y.js` — NE YAPAR / NE YAPMAZ

Dinamik üretilen arayüzde **eksik erişilebilirlik bilgisini tamamlayan** katmandır (MutationObserver ile). Tüm sayfalarda yüklenir (`tests/html-quality.test.js` bunu denetler).

Yapar:
- İsimsiz ikon butonlarına `aria-label` verir (Font Awesome sınıfından, ör. `fa-sign-out-alt` → "Çıkış yap"); isimsiz `<select>`'lere id/ad ipucundan etiket verir; hemen önündeki ilişkisiz `<label>`'i alana bağlar; `placeholder`/ad ile isimsiz input'lara `aria-label` verir.
- `onclick` olup doğal olarak odaklanamayan öğelere `tabindex="0"` + `role="button"` ekler; `Enter`/`Space` ile `click()` tetikler.
- Kaydırılabilir kapların klavyeyle kaydırılabilmesi için `tabindex="0"` verir.
- Atlanan başlık seviyelerini `aria-level` ile düzeltir (yalnızca erişilebilirlik ağacı; görünüm değişmez).

Yapmaz:
- Görünür etiket/metin yazmaz, renk/kontrast düzeltmez, odak sırasını yeniden düzenlemez, modal odak tuzağı kurmaz.
- **Yeni kodda a11y.js'e güvenme:** doğru HTML (gerçek `<button>`, `<label for>`, `aria-label`) ilk günden yazılır; a11y.js yalnızca ağ (safety net)'dır.
- Not: ikon etiket haritasında olmayan ikon için `aria-label` açıkça yazılmalıdır. Betik belge yazılırken `onclick` özniteliğine dayanıyordu (`[onclick]` seçicisi, `role=button`/Enter-Space davranışı); satır içi olay yöneticileri `addEventListener`/`data-on-*` modeline taşındıkça bu bağımlılık değişir (**koordinatör bu maddeyi taşıma sonrası güncelleyecek**). Tıklanabilir öğeler için gerçek `<button>` kullanımı her durumda doğrudur.

---

## 4. KLAVYE, ODAK VE HAREKET

`public/style.css` sonunda "Erişilebilirlik" bloğu:
- **Odak:** `:focus-visible { outline: 3px solid var(--brand-accent, #60a5fa); outline-offset: 2px; }`. `outline: none` YAZILMAZ; özel odak stili gerekiyorsa görünür ve ≥ 3:1 olmalıdır.
- **Skip link:** `public/index.html` ilk öğe `<a class="skip-link" href="#mainContent">İçeriğe geç</a>`; odaklanınca görünür (`.skip-link:focus { top: 12px }`). `#mainContent` korunur.
- **`.sr-only`:** yalnızca ekran okuyucuya görünen metin için.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` tüm animasyon/geçişi fiilen kapatır. Yeni animasyon bu bloğu bozmaz; zorunlu bilgi animasyona bağlanmaz.
- **Klavye:** her etkileşimli öğe Tab ile ulaşılır, Enter/Space ile çalışır; `div onclick` yerine `<button>`/`<a href>`. Tıklanabilir kart gerekiyorsa gerçek `<button>`/`<a>` içerir.
- **Etiketler:** her form alanında görünür `<label for>` (placeholder etiket DEĞİLDİR; şifre alanları dahil). Yalnızca ikonlu butonda `aria-label`. Görsellerde anlamlı `alt` (süs görselde `alt=""`).
- Dil: `<html lang="tr">`, `viewport` meta (zoom'u engelleme yok), `<main>` işareti (landmark) her sayfada (`tests/html-quality.test.js`).

---

## 5. BAŞLIK HİYERARŞİSİ

- SPA'da sayfa başlığı görünür üst çubukta durur; erişilebilirlik için `public/index.html`'de gizli **`<h1 id="pageTitleSr" class="sr-only">Panel</h1>`** bulunur ve `public/app_v3.js` sayfa değişiminde içeriğini günceller (`navigateTo`).
- Sayfa içi bölümler `h2` ile başlar; seviye atlanmaz (h2 → h4 yok). `a11y.js` atlananı `aria-level` ile düzeltir ama doğru seviye yazılmalıdır.
- `#pageTitleSr` kaldırılmaz/yeniden adlandırılmaz (hem `a11y.js` hem `app_v3.js` kullanır).
- Giriş/kayıt/sıfırlama sayfalarında sayfa başına tek `h1`.

---

## 6. MOBİL KURALLARI (390 px)

- **390 px genişlikte yatay sayfa taşması YOKTUR** (`document.documentElement.scrollWidth <= innerWidth`). Geniş tablo/grafik kendi kabında `overflow-x:auto` ile kayar; sayfayı genişletmez.
- `.main-content { min-width: 0 }` korunur (içerik, flex/grid kabını yatayda büyütmesin; `public/style.css`).
- **Grid sütunları `minmax(0, 1fr)`** ile yazılır (`repeat(N, minmax(0, 1fr))`); düz `1fr` içerik min-genişliği yüzünden taşar.
- **Giriş sayfasında `position: sticky` yalnızca masaüstünde** (`@media (min-width: 1081px) { .auth-hero { position: sticky; ... } }` — `public/login.html`). Mobilde sticky, dokunma/kaydırma sorununa yol açmıştı; geri getirme.
- Dokunma hedefleri ≥ 24×24 CSS px (tercihen 44); sabit genişlikli (`width: 600px` gibi) öğeler mobilde `max-width: 100%`.
- Yeni sayfa eklenince 390 px'te elle ve `npm run e2e:mobile` ile denetlenir.

---

## 7. MARKA TEMA SİSTEMİ İLE İLİŞKİ

- Tema kaynağı `public/brand_experience.js` → `BrandExperience.applyTheme(root, brand, 'brand')`; `--brand-primary`, `--brand-secondary`, `--brand-accent`, `--brand-text` (marka metin rengi) ve `-rgb` varyantlarını `:root`'a yazar. Marka başına `primary_color`/`text_color` DB'den (`brands`) gelir.
- `applyBrandTheme` (app_v3.js) tema uygulandıktan sonra **mutlaka** `applyReadableBrandText()` çağırır; yeni bir tema uygulama yolu eklenirse (ör. marka değiştirme/önizleme) bu çağrı atlanmaz.
- Marka rengi dekoratif vurgu için serbesttir; **yazı rengi kararı** `--on-brand`'dedir. Marka renginin üzerine kendi renk hesabını yazma.
- Yeni marka eklendiğinde `npm run e2e:contrast` ile 24+ marka taraması çalıştırılır.
- Logo `<img>` `alt` metni marka adıdır; `src` `safeHref` ile basılır.

---

## 8. YENİ UI ÖĞESİ KONTROL LİSTESİ

- [ ] Renkler değişkenlerden mi? Metin kontrastı ≥ 4.5:1 (koyu kart ve hover dahil); `--text-muted` yerine daha soluk renk yok mu?
- [ ] Marka zemini üzerindeki yazı `var(--on-brand, ...)` mi (sabit beyaz değil)?
- [ ] Etkileşimli öğeler gerçek `<button>`/`<a href>`/`<input>` mi; Tab ile gelip Enter/Space ile çalışıyor mu?
- [ ] Odak göstergesi görünür mü (`outline:none` yok)?
- [ ] Her alanın görünür `<label for>`'ü var mı; ikon butonlarında `aria-label`; görsellerde `alt`?
- [ ] Başlık seviyeleri sıralı mı; sayfa başlığı `pageTitleSr` ile güncelleniyor mu?
- [ ] Animasyon `prefers-reduced-motion` altında kapanıyor mu; bilgi yalnızca animasyonla verilmiyor mu?
- [ ] 390 px'te yatay taşma yok mu (`minmax(0,1fr)`, tablo kabı `overflow-x:auto`)? Sticky yalnızca masaüstünde mi?
- [ ] Kullanıcı/DB verisi `escapeHtml`/`safeHref` ile basılıyor mu; yeni satır içi `onclick` yazılmadı mı (bkz. güvenlik anayasası)?
- [ ] Görünür metin düzgün Türkçe karakterli mi (`turkce-karakter-anayasasi`)?
- [ ] Yeni sayfa için `npm run e2e:a11y`, `npm run e2e:mobile`, `npm run e2e:xss` temiz mi? Marka renkleri/tema dokunulduysa `npm run e2e:contrast` temiz mi?

---

## 9. DENETİM ARAÇLARI

Tarayıcı (Chromium + playwright-core) denetimleri; yerel Postgres (`TEST_DATABASE_URL`) gerekir, **CI'da yoktur** (tarayıcı kurulumu ağır). Büyük arayüz değişikliğinden önce/sonra elle çalıştırılır. `CHROMIUM_PATH` ile tarayıcı yolu verilebilir. Ayrıntı: `../../e2e/README.md`.

| Komut | Dosya | Ne denetler |
|-------|-------|-------------|
| `npm run e2e:a11y` | `e2e/a11y.js` | axe-core (wcag2a/aa, 2.1 a/aa, best-practice): giriş/kayıt/sıfırlama sayfaları + panel sayfaları, masaüstü (1440) ve mobil (390); yatay taşma |
| `npm run e2e:contrast` | `e2e/brand-contrast.js` | Her marka için marka kullanıcısıyla panel sayfalarında axe `color-contrast` |
| `npm run e2e:mobile` | `e2e/mobile-overflow.js` | 390 px'te yatay taşma yapan öğeler |
| `npm run e2e:xss` | `e2e/xss-crawl.js` | Zehirli veriyle (marka/il/model/portal/medya) tüm sayfaları gezer; betik çalışırsa hata |
| `node e2e/click-through.js` | `e2e/click-through.js` | Tıklama turu + CSP ihlali denetimi (npm komutu yok, bkz. aşağıdaki not) |
| `npm run e2e:auth` | `e2e/auth-flow.js` | Giriş akışı, httpOnly çerez, localStorage'da anahtar yok, yenileme, çıkış |

Örnek: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run e2e:a11y`

- `e2e/click-through.js` (tıklama turu: giriş etkileşimleri, tüm menü sayfaları, filtre `<select>`'leri, admin düğmeleri, bildirim paneli; CSP ihlali ve bozulan etkileşim denetler) belge yazılırken depoda mevcuttu ama `package.json`'da npm komutu **yoktu**; çalıştırma: `TEST_DATABASE_URL=postgresql://... [CHROMIUM_PATH=...] [SERVE_MINIFIED=1] node e2e/click-through.js`. Satır içi olay yöneticileri `addEventListener`/`data-on-*` modeline taşındığında davranışın bozulmadığını doğrulamak için kullanılır. (Koordinatör: npm komutu/README eklendiyse bu satırı güncelleyin.)
- Tarayıcısız statik kontrol: `tests/html-quality.test.js` (lang, viewport, main, a11y.js, etiketsiz şifre alanı yok) `npm test` içinde çalışır.
- Üretimle aynı davranış için denetimler minify modunda da çalıştırılabilir (`SERVE_MINIFIED=1`; `e2e/auth-flow.js` böyle başlar).
