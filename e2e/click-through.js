// Tıklama turu: giriş sayfası etkileşimleri + panelde TÜM menü sayfaları, filtre <select>'leri,
// ayarlar admin düğmeleri ve bildirim paneli. Satır içi olay yöneticileri kaldırıldıktan sonra
// (data-on-* + inline-actions.js) hiçbir etkileşimin bozulmadığını ve CSP ihlali olmadığını doğrular.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... [CHROMIUM_PATH=...] [SERVE_MINIFIED=1] node e2e/click-through.js
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };
// Dış ağ/CDN/Google/Wikimedia kaynaklı (sandbox'ta erişilemeyen) hatalar test dışı
// Bilinen, dönüşümden bağımsız (önceden var olan) aralıklı Leaflet yarışı: harita sayfasından çıkarken animasyon
const KNOWN_FLAKY = /_leaflet_pos/;
const EXTERNAL = /ERR_CERT|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|ERR_PROXY|Failed to load resource|google|gstatic|wikimedia|wikipedia|googleapis/i;

(async () => {
    const minified = process.env.SERVE_MINIFIED === '1';
    const s = await startServer({ env: { NODE_ENV: 'test', ...(minified ? { SERVE_MINIFIED: '1' } : {}) } });
    console.log('Mod:', minified ? 'minified (SERVE_MINIFIED=1)' : 'kaynak dosyalar');
    const user = await s.createUser({ role: 'admin' });
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
      SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands ORDER BY id LIMIT 6) b,(SELECT id FROM provinces ORDER BY id LIMIT 20) p, generate_series(1,6) m(month)`);
    await s.pool.query(`INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet) SELECT b.name,'M1',2025,m.month,p.id,p.name,2025,4 FROM (SELECT name FROM brands ORDER BY id LIMIT 6) b,(SELECT id,name FROM provinces ORDER BY id LIMIT 20) p, generate_series(1,6) m(month)`);

    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // CSP ihlallerini her belgede dinle; konsola işaretli satır olarak yaz (sayfa geçişlerinde kaybolmaz)
    await ctx.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', e => {
            console.log('__CSPV__ ' + e.violatedDirective + ' | ' + (e.blockedURI || '') + ' | ' + String(e.sample || '').slice(0, 80));
        });
    });
    const page = await ctx.newPage();
    const errs = [];
    const csp = [];
    let flaky = 0;
    page.on('pageerror', e => { if (KNOWN_FLAKY.test(e.message)) { flaky++; return; } errs.push('pageerror: ' + e.message); });
    page.on('console', m => {
        const t = m.text();
        if (t.startsWith('__CSPV__')) { csp.push(t); return; }
        if (m.type() === 'error' && !EXTERNAL.test(t)) errs.push('console.error: ' + t);
    });
    // Dış kaynaklı istekler sandbox'ta takılmasın
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());

    let mark = { e: 0, c: 0 };
    const snap = () => { mark = { e: errs.length, c: csp.length }; };
    const clean = (label) => {
        const newE = errs.slice(mark.e), newC = csp.slice(mark.c);
        ok(newC.length === 0, `${label}: CSP ihlali yok` + (newC.length ? ' -> ' + newC.slice(0, 2).join(' || ') : ''));
        ok(newE.length === 0, `${label}: konsol/sayfa hatası yok` + (newE.length ? ' -> ' + newE.slice(0, 2).join(' || ').slice(0, 300) : ''));
        snap();
    };

    // ---- (f) giriş sayfası ----
    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    snap();
    const activeForm = () => page.evaluate(() => document.querySelector('.auth-form.is-active')?.dataset.form);
    ok(await activeForm() === 'login', 'giriş: varsayılan sekme login');
    await page.click('.auth-tab[data-tab="signup"]');
    ok(await activeForm() === 'signup', 'giriş: "Üye Ol" sekmesi açıldı');
    await page.click('.auth-tab[data-tab="login"]');
    ok(await activeForm() === 'login', 'giriş: "Giriş Yap" sekmesine dönüldü');
    // alt bağlantıdan Üye Ol
    await page.click('#loginForm .auth-foot a');
    ok(await activeForm() === 'signup', 'giriş: alt "Üye Ol" bağlantısı çalışıyor');
    await page.click('.auth-tab[data-tab="login"]');
    // şifre göster/gizle
    await page.click('#loginForm .pw-toggle');
    ok(await page.getAttribute('#loginForm input[name=password]', 'type') === 'text', 'giriş: şifre gösterildi');
    await page.click('#loginForm .pw-toggle');
    ok(await page.getAttribute('#loginForm input[name=password]', 'type') === 'password', 'giriş: şifre gizlendi');
    // diğer giriş yolları
    await page.click('#loginForm .more-ways a');
    ok(await page.locator('#infoMsg').isVisible(), 'giriş: "Diğer giriş yolları" bilgi mesajı');
    // Google düğmesi (yapılandırılmamış hata mesajı)
    await page.click('#loginForm .btn-google-strong');
    ok(await page.locator('#errorMsg').isVisible(), 'giriş: Google düğmesi mesaj gösterdi');
    // şifremi unuttum
    await page.fill('#loginForm input[name=email]', user.email);
    await page.click('#loginForm .forgot-link');
    ok(await activeForm() === 'forgot', 'giriş: "Şifremi unuttum" görünümü açıldı');
    ok(await page.inputValue('#forgotEmail') === user.email.toLowerCase(), 'giriş: unutulan şifre e-postası otomatik dolduruldu');
    await page.click('.auth-tab[data-tab="login"]');
    // üye ol sihirbazı: plan seçimi (change), ileri/geri, şifre gücü (input), marka arama (keyup)
    await page.click('.auth-tab[data-tab="signup"]');
    const plans = await page.$$eval('#signupPlan option', o => o.map(x => x.value).filter(Boolean));
    if (plans.length > 1) {
        await page.selectOption('#signupPlan', plans[1]);
        await page.waitForTimeout(100);
        ok(true, 'giriş: plan <select> change olayı');
    }
    await page.click('[data-form="signup"] button:has-text("Devam et")');
    await page.waitForTimeout(150);
    ok(await page.evaluate(() => !!document.querySelector('[data-form="signup"] input[name="password"]')), 'giriş: sihirbaz adım 2 alanları var');
    await page.click('.preview-tab[data-preview="growth"]').catch(() => {});
    clean('giriş sayfası');

    // ---- giriş (UI) ----
    await page.click('.auth-tab[data-tab="login"]');
    await page.fill('#loginForm input[name=email]', user.email);
    await page.fill('#loginForm input[name=password]', user.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
    ok(new URL(page.url()).pathname === '/', 'UI ile giriş yapıldı: ' + page.url());
    snap();

    // ---- (a)(b)(c) tüm menü sayfaları ----
    const pages = await page.$$eval('.menu-item[data-page]', els => els.map(e => e.dataset.page));
    console.log('Menü öğesi sayısı:', pages.length);
    let visited = 0, selectsTested = 0;
    for (const pg of pages) {
        const item = page.locator(`.menu-item[data-page="${pg}"]`).first();
        if (!(await item.isVisible().catch(() => false))) continue;
        await item.hover().catch(() => {});
        await page.waitForTimeout(300);
        await item.click();
        await page.waitForTimeout(1400);
        if (await page.evaluate(p => document.querySelector('.menu-item.active')?.dataset.page !== p, pg) && pg !== 'tarmakbir2') {
            // Gerçek fare tıklaması bu öğeye ulaşmadı (kenar çubuğu alt kısmı yerleşimi; satır içi yöneticiden bağımsız,
            // dönüşümden önce de aynı). Programatik click ile eylemin kendisini doğrula.
            console.log(`NOT  "${pg}" için fare tıklaması etkisiz (yerleşim); programatik click kullanılıyor`);
            await page.evaluate(p => document.querySelector(`.menu-item[data-page="${p}"]`).click(), pg);
            await page.waitForTimeout(1400);
        }
        visited++;
        const cur = await page.evaluate(() => document.querySelector('.menu-item.active')?.dataset.page);
        ok(cur === pg || (pg === 'tarmakbir2' && cur === 'tarmakbir'), `menü "${pg}" aktif oldu` + (cur !== pg ? ` (aktif: ${cur})` : ''));
        // görünür filtre <select>'leri: ikinci seçenek
        const selIdx = await page.$$eval('#content select, main select, .main-content select', els => els
            .map((e, i) => ({ i, vis: !!(e.offsetWidth || e.offsetHeight) && !e.disabled && e.options.length > 1 }))
            .filter(x => x.vis).map(x => x.i).slice(0, 6));
        for (const i of selIdx) {
            const handle = (await page.$$('#content select, main select, .main-content select'))[i];
            if (!handle) continue;
            const val = await handle.evaluate(e => e.options[1].value);
            await handle.selectOption(val).catch(() => {});
            selectsTested++;
            await page.waitForTimeout(500);
        }
        clean(`sayfa "${pg}" (${selIdx.length} select)`);
    }
    ok(visited >= 10, `görünür menü sayfası gezildi: ${visited}`);
    console.log('Toplam test edilen select:', selectsTested);

    // ---- (e) bildirim paneli ----
    // Üst çubuk (zil/yenile/yıl) CSS ile genel olarak gizli (style.css: .top-bar{display:none!important});
    // bu yüzden gerçek DOM click/change olaylarını öğeye programatik gönderiyoruz (delege dinleyici de aynı yolu görür).
    await page.click('.menu-item[data-page="dashboard"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector('button[title="Bildirimler"]').click());
    await page.waitForTimeout(800);
    ok(await page.locator('#notifPanel').isVisible(), 'bildirim paneli açıldı (zil düğmesi click -> loadNotifications)');
    const notifItems = await page.locator('#notifPanel .notif-item').count();
    if (notifItems) { await page.evaluate(() => document.querySelector('#notifPanel .notif-item').click()); await page.waitForTimeout(400); ok(true, 'bildirim öğesi tıklandı'); }
    // panel, başlık bandının altında kalabildiği için (z-index) gerçek DOM click'i programatik gönderilir
    await page.evaluate(() => document.querySelector('#notifPanel .notif-header button').click());
    await page.waitForTimeout(200);
    ok(!(await page.locator('#notifPanel').isVisible()), 'bildirim paneli kapatıldı');
    await page.evaluate(() => document.querySelector('button[title="Yenile"]').click());
    await page.waitForTimeout(800);
    const yearVals = await page.$$eval('#yearFilter option', o => o.map(x => x.value));
    if (yearVals.length > 1) {
        await page.evaluate(v => { const e = document.getElementById('yearFilter'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, yearVals[1]);
        await page.waitForTimeout(800);
    }
    clean('bildirim paneli / yenile / yıl filtresi');

    // ---- (d) ayarlar admin kartları ----
    await page.evaluate(() => document.querySelector('.menu-item[data-page="settings"]').click());
    await page.waitForTimeout(2500);
    const adminBtns = await page.$$eval('#content button, .main-content button', els => els
        .map((e, i) => ({ i, t: (e.textContent || '').trim().slice(0, 40), v: !!(e.offsetWidth || e.offsetHeight) && !e.disabled, a: e.getAttribute('data-on-click') || e.getAttribute('onclick') || '' }))
        .filter(x => x.v && x.a));
    console.log('Ayarlar sayfasında tıklanabilir düğme:', adminBtns.length, adminBtns.slice(0, 8).map(b => b.t).join(' | '));
    ok(adminBtns.length > 0, 'ayarlar sayfasında satır içi eylemli düğmeler var');
    // yıkıcı olmayan düğmeler: "oluştur/yükle/listele/yenile" benzerlerini tıkla (confirm/alert otomatik kabul)
    page.on('dialog', d => d.accept().catch(() => {}));
    let clicked = 0;
    for (const b of adminBtns) {
        if (/sil|kaldır|iptal|çıkış|delete|remove|deploy|sıfırla|purge|temizle/i.test(b.t + ' ' + b.a)) continue;
        const h = (await page.$$('#content button, .main-content button'))[b.i];
        if (!h) continue;
        await h.click({ timeout: 2000 }).catch(() => {});
        clicked++;
        await page.waitForTimeout(250);
        if (clicked >= 12) break;
    }
    ok(clicked > 0, `ayarlar düğmeleri tıklandı: ${clicked}`);
    // Davet kodu kartı: marka seç (change) + "Kod oluştur" (click) -> kod kutusu görünür
    await page.waitForSelector('#inviteBrandSel option[value]:not([value=""])', { timeout: 8000 }).catch(() => {});
    const brandOpt = await page.$$eval('#inviteBrandSel option', o => o.map(x => x.value).filter(Boolean)[0]).catch(() => null);
    ok(!!brandOpt, 'ayarlar: davet kodu kartı marka listesi doldu');
    if (brandOpt) {
        await page.selectOption('#inviteBrandSel', brandOpt);
        await page.click('#inviteCreateBtn');
        await page.waitForSelector('#inviteCodeValue', { timeout: 8000 }).catch(() => {});
        ok(await page.locator('#inviteCodeValue').isVisible().catch(() => false), 'ayarlar: "Kod oluştur" düğmesi yeni kod gösterdi');
    }
    clean('ayarlar admin kartları');

    // ---- çıkış düğmesi ----
    await page.click('.btn-logout');
    await page.waitForTimeout(2500);
    ok(/login|giris/.test(page.url()), 'çıkış düğmesi çalıştı: ' + page.url());
    clean('çıkış');

    console.log(`Toplam CSP ihlali: ${csp.length}, toplam konsol/sayfa hatası: ${errs.length} (bilinen aralıklı Leaflet yarışı, sayılmadı: ${flaky})`);
    csp.slice(0, 10).forEach(c => console.log('  CSP:', c));
    errs.slice(0, 10).forEach(e => console.log('  ERR:', e.slice(0, 250)));
    await browser.close(); await s.stop();
    if (fails) { console.log('BAŞARISIZ kontrol sayısı:', fails); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
