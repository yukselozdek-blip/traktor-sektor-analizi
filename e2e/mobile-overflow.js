// Tarayıcı (Chromium) uçtan uca denetimi. Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:<ad>
// CHROMIUM_PATH tanımlıysa o tarayıcı kullanılır (yoksa playwright'ın kendi tarayıcısı).
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const { startServer, JWT_SECRET } = require('../tests/helpers');
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test' } });
    const u = await s.createUser({ role: 'admin' });
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source) SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands LIMIT 6) b,(SELECT id FROM provinces ORDER BY id LIMIT 20) p, generate_series(1,6) m(month)`);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: 'tk_session', value: jwt.sign({ id: u.id, email: u.email, role: 'admin' }, JWT_SECRET), url: s.baseUrl }]);
    const page = await ctx.newPage();
    const probe = () => page.evaluate(() => {
        const W = window.innerWidth, out = [];
        document.querySelectorAll('body *').forEach(e => {
            const r = e.getBoundingClientRect();
            if (r.width > 0 && r.right > W + 2 && getComputedStyle(e).position !== 'fixed') {
                // üst atası taşma kapsamı (overflow hidden/auto) içindeyse yoksay
                let p = e.parentElement, clipped = false;
                while (p && p !== document.body) { const o = getComputedStyle(p); if (/(hidden|auto|scroll)/.test(o.overflowX)) { clipped = true; break; } p = p.parentElement; }
                if (!clipped) out.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ').slice(0,2).join('.')} sağ=${Math.round(r.right)} gen=${Math.round(r.width)}`);
            }
        });
        return { scrollW: document.documentElement.scrollWidth, W, out: out.slice(0, 8) };
    });
    for (const pg of ['/login.html', '/signup.html', '/#/map', '/#/competitors']) {
        await page.goto(s.baseUrl + pg, { waitUntil: 'networkidle' }); await page.waitForTimeout(2500);
        console.log(pg, JSON.stringify(await probe()));
    }
    await browser.close(); await s.stop();
})();
