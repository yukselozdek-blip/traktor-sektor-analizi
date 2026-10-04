// Tarayıcı (Chromium) uçtan uca denetimi. Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:<ad>
// CHROMIUM_PATH tanımlıysa o tarayıcı kullanılır (yoksa playwright'ın kendi tarayıcısı).
const { chromium } = require('playwright-core');
const AxeBuilder = require('@axe-core/playwright').default;
const jwt = require('jsonwebtoken');
const { startServer, JWT_SECRET } = require('../tests/helpers');
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test' } });
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source) SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands) b,(SELECT id FROM provinces ORDER BY id LIMIT 12) p, generate_series(1,6) m(month)`);
    const brands = (await s.pool.query('SELECT id, name, primary_color FROM brands ORDER BY id')).rows;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const pairs = {}; let scans = 0;
    for (const b of brands) {
        const u = await s.createUser({ role: 'brand_user' });
        await s.pool.query('UPDATE users SET brand_id = $1 WHERE id = $2', [b.id, u.id]);
        const token = jwt.sign({ id: u.id, email: u.email, role: 'brand_user', brand_id: b.id }, JWT_SECRET, { expiresIn: '1h' });
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await ctx.addCookies([{ name: 'tk_session', value: token, url: s.baseUrl }]);
        const page = await ctx.newPage();
        await page.goto(s.baseUrl + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(2500);
        for (const pg of (process.env.PAGES || 'brand-hub,dashboard,sales,historical').split(',')) {
            await page.evaluate(p => { location.hash = '#/' + p; }, pg); await page.waitForTimeout(1300);
            const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze(); scans++;
            for (const v of r.violations) for (const n of v.nodes) {
                const d = n.any[0]?.data || {};
                const k = `${d.fgColor} on ${d.bgColor} (${d.contrastRatio})`;
                pairs[k] = pairs[k] || { n: 0, brands: new Set(), sel: n.target.join(' ').slice(0, 70), pages: new Set() };
                pairs[k].n++; pairs[k].brands.add(b.name); pairs[k].pages.add(pg);
            }
        }
        await ctx.close();
    }
    console.log('taramalar:', scans, '| benzersiz ihlal çifti:', Object.keys(pairs).length);
    Object.entries(pairs).sort((a, b) => b[1].n - a[1].n).slice(0, 40).forEach(([k, v]) => console.log(`${String(v.n).padStart(3)}x ${k} | markalar=${v.brands.size} (${[...v.brands].slice(0,3).join(',')}) | ${[...v.pages].join('/')} | ${v.sel}`));
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
