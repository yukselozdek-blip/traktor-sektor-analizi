// Açılış verisi dayanıklılığı: /api/provinces (veya /api/brands) hata verirse diğeri dolu kalmalı;
// Marka Merkezi (admin) marka listesi yüklenemediyse DOĞRU mesajı göstermeli ve "Tekrar Dene" çalışmalı.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... [CHROMIUM_PATH=...] node e2e/ref-data-resilience.js
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };

(async () => {
    const s = await startServer({ env: { REF_CACHE_TTL_MS: '0', RESPONSE_CACHE_TTL_MS: '0' } });
    const admin = await s.createUserWithToken({ role: 'admin' });
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
      SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands ORDER BY id LIMIT 3) b,(SELECT id FROM provinces ORDER BY id LIMIT 10) p, generate_series(1,5) m(month)`);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const newPage = async (block) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await ctx.addCookies([{ name: 'tk_session', value: admin.token, url: s.baseUrl }]);
        await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
        const state = { block: new Set(block) };
        await ctx.route(/\/api\/(brands|provinces)(\?|$)/, r => {
            const kind = /\/api\/brands/.test(r.request().url()) ? 'brands' : 'provinces';
            if (state.block.has(kind)) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Sunucu hatası"}' });
            return r.continue();
        });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(e.message));
        return { page, state, pageErrors, ctx };
    };
    const text = page => page.evaluate(() => document.getElementById('pageContent')?.innerText || '');

    // 1) Yalnızca /api/provinces düşerse: markalar yine yüklenir, Marka Merkezi açılır
    {
        const { page, state, pageErrors, ctx } = await newPage(['provinces']);
        await page.goto(s.baseUrl + '/#brand-hub', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const t = await text(page);
        ok(!/Marka seçimi bulunamadı|Markalar yüklenemedi/.test(t), 'il listesi hatalıyken Marka Merkezi marka listesiyle açılıyor');
        ok(await page.evaluate(() => allBrands.length > 0 && allProvinces.length === 0), 'allBrands dolu, allProvinces boş (bağımsız yükleme)');
        ok(pageErrors.length === 0, 'sayfa hatası yok' + (pageErrors.length ? ' -> ' + pageErrors[0] : ''));
        await ctx.close();
    }

    // 2) Her iki liste de düşerse: doğru mesaj + "Tekrar Dene" (API düzelince) çalışır
    {
        const { page, state, pageErrors, ctx } = await newPage(['brands', 'provinces']);
        await page.goto(s.baseUrl + '/#brand-hub', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        let t = await text(page);
        ok(/Markalar yüklenemedi, sayfayı yenileyin/.test(t), 'marka listesi yüklenemeyince doğru mesaj gösteriliyor');
        ok(!/marka atanmış olmalı/.test(t), 'yanıltıcı "marka atanmış olmalı" mesajı yok');
        ok(await page.locator('#pageContent button:has-text("Tekrar Dene")').count() === 1, '"Tekrar Dene" düğmesi var');
        state.block.clear(); // sunucu düzeldi
        await page.click('#pageContent button:has-text("Tekrar Dene")');
        await page.waitForTimeout(2500);
        t = await text(page);
        ok(!/Markalar yüklenemedi/.test(t) && /TESCİL|Tescil|PAZAR/i.test(t), '"Tekrar Dene" sonrası Marka Merkezi yüklendi');
        ok(await page.evaluate(() => allBrands.length > 0 && allProvinces.length > 0), 'yeniden denemede iki liste de dolduruldu');
        ok(pageErrors.length === 0, 'sayfa hatası yok' + (pageErrors.length ? ' -> ' + pageErrors[0] : ''));
        await ctx.close();
    }

    // 3) Hata ekranındaki "Tekrar Dene" (showError) çalışır: model-bölge 500 -> düzelince yeniden yüklenir
    {
        const { page, ctx } = await newPage([]);
        let fail = true;
        await ctx.route(/\/api\/sales\/model-region/, r => fail
            ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Sunucu hatası"}' }) : r.continue());
        await page.goto(s.baseUrl + '/#model-region', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        ok(/Bir hata oluştu/.test(await text(page)), 'model-bölge 500 -> hata ekranı');
        fail = false;
        await page.click('#pageContent button:has-text("Tekrar Dene")');
        await page.waitForTimeout(2500);
        ok(!/Bir hata oluştu/.test(await text(page)), 'hata ekranındaki "Tekrar Dene" sayfayı yeniden yükledi');
        await ctx.close();
    }

    await browser.close();
    await s.stop();
    console.log(fails ? `\n${fails} kontrol BAŞARISIZ` : '\nTüm kontroller geçti');
})().catch(e => { console.error(e); process.exit(1); });
