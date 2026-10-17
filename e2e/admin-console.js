// Yönetim paneli (/admin) ve kurum sayfası (/kurum) tarayıcı denetimi.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... CHROMIUM_PATH=... npm run e2e:admin
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test', SERVE_MINIFIED: '1' } });
    const admin = await s.createUser({ role: 'admin' });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && !(r.status() === 401 && r.url().endsWith('/api/auth/me'))) errs.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.fill('#loginForm input[name=email]', admin.email);
    await page.fill('#loginForm input[name=password]', admin.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 }).catch(() => {});

    const brand = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 1')).rows[0];
    ok(!!brand, 'test markası var');

    for (const h of ['overview', 'orgs', 'users', 'staff', 'features', 'audit']) {
        await page.goto(`${s.baseUrl}/admin#/${h}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        const txt = await page.locator('main').innerText();
        ok(txt.trim().length > 20 && !/undefined|\[object Object\]|NaN/.test(txt), `#/${h} içerik doğru görünüyor`);
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-${h}.png`, fullPage: true });
    }

    // Kurum oluştur (UI üzerinden)
    await page.goto(`${s.baseUrl}/admin#/orgs`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Yeni kurum/i }).click();
    const dlg = page.locator('dialog[open]');
    await dlg.locator('[name=name]').fill('John Deere Türkiye');
    for (const n of ['brand_id', 'plan_slug']) {
        const opts = await dlg.locator(`select[name=${n}] option`).evaluateAll(os => os.map(o => o.value).filter(Boolean));
        await dlg.locator(`select[name=${n}]`).selectOption(opts[opts.length - 1]);
    }
    await dlg.locator('[name=seat_limit]').fill('20');
    await dlg.locator('[name=domains]').fill('deere.com');
    await dlg.locator('[name=contract_start]').fill('2026-01-01');
    await dlg.locator('[name=contract_end]').fill('2027-12-31');
    await dlg.locator('button[type=submit]').click();
    await page.waitForTimeout(1500);
    const org = (await s.pool.query(`SELECT o.id, o.seat_limit, d.domain FROM organizations o LEFT JOIN organization_domains d ON d.organization_id=o.id WHERE o.name='John Deere Türkiye'`)).rows[0];
    ok(org && org.seat_limit === 20 && org.domain === 'deere.com', 'UI ile kurum oluşturuldu (20 koltuk, deere.com): ' + JSON.stringify(org));

    if (org) {
        await page.goto(`${s.baseUrl}/admin#/orgs/${org.id}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-org-detail.png`, fullPage: true });
        for (const tab of await page.getByRole('tab').all()) {
            await tab.click(); await page.waitForTimeout(500);
            const name = (await tab.innerText()).trim();
            const txt = await page.locator('main').innerText();
            ok(!/undefined|\[object Object\]|NaN/.test(txt), `kurum sekmesi "${name}" temiz`);
            if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-org-tab-${name.replace(/[^a-z]/gi, '')}.png`, fullPage: true });
        }
    }
    await page.goto(`${s.baseUrl}/kurum`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    ok(/kuruma bağlı değilsiniz/i.test(await page.locator('main').innerText()), '/kurum: üyelik yoksa bilgi mesajı');

    // Mobil taşma
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${s.baseUrl}/admin#/orgs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 1, 'mobilde yatay taşma yok: ' + overflow);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-mobile.png`, fullPage: true });

    ok(errs.length === 0, 'konsol/API hatası yok' + (errs.length ? ': ' + [...new Set(errs)].join(' | ') : ''));
    await browser.close();
    await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
