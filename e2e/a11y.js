// Tarayıcı (Chromium) uçtan uca denetimi. Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:<ad>
// CHROMIUM_PATH tanımlıysa o tarayıcı kullanılır (yoksa playwright'ın kendi tarayıcısı).
const { chromium } = require('playwright-core');
const AxeBuilder = require('@axe-core/playwright').default;
const { startServer } = require('../tests/helpers');
const PAGES = ['brand-hub','dashboard','sales','map','models','competitors','settings','subscription'];
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test' } });
    const user = await s.createUser({ role: 'admin' });
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
      SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands ORDER BY id LIMIT 6) b,(SELECT id FROM provinces ORDER BY id LIMIT 20) p, generate_series(1,6) m(month)`);
    await s.pool.query(`INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet) SELECT b.name,'M1',2025,m.month,p.id,p.name,2025,4 FROM (SELECT name FROM brands ORDER BY id LIMIT 6) b,(SELECT id,name FROM provinces ORDER BY id LIMIT 20) p, generate_series(1,6) m(month)`);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const agg = {};
    const run = async (label, page) => {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice']).analyze();
        for (const v of r.violations) {
            const k = `${v.impact}|${v.id}`;
            agg[k] = agg[k] || { help: v.help, pages: new Set(), nodes: 0, sample: v.nodes[0]?.html?.slice(0,110) };
            agg[k].pages.add(label); agg[k].nodes += v.nodes.length;
        }
    };
    for (const [vpName, vp] of [['desktop', { width: 1440, height: 900 }], ['mobil', { width: 390, height: 844 }]]) {
        const ctx = await browser.newContext({ viewport: vp });
        const page = await ctx.newPage();
        for (const pg of ['/login.html', '/signup.html', '/reset-password.html?token=' + 'a'.repeat(64)]) {
            await page.goto(s.baseUrl + pg, { waitUntil: 'networkidle' }); await page.waitForTimeout(600);
            await run(`${vpName}:${pg.split('?')[0]}`, page);
            const sw = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
            if (sw) console.log(`YATAY TAŞMA ${vpName} ${pg}`);
        }
        await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
        await page.fill('#loginForm input[name=email]', user.email); await page.fill('#loginForm input[name=password]', user.password);
        await page.click('#loginForm button[type=submit]'); await page.waitForTimeout(3500);
        for (const pg of PAGES) {
            await page.evaluate(p => { location.hash = '#/' + p; }, pg); await page.waitForTimeout(1500);
            await run(`${vpName}:#/${pg}`, page);
            const sw = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
            if (sw) console.log(`YATAY TAŞMA ${vpName} #/${pg}`);
        }
        if (vpName === 'mobil') await page.screenshot({ path: 'mobil.png' });
        await ctx.close();
    }
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    Object.entries(agg).sort((a, b) => order[a[0].split('|')[0]] - order[b[0].split('|')[0]] || b[1].nodes - a[1].nodes)
        .forEach(([k, v]) => console.log(`${k.padEnd(34)} düğüm=${String(v.nodes).padEnd(5)} sayfa=${v.pages.size}  ${v.help}\n     örnek: ${v.sample}`));
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
