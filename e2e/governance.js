// Yönetişim paneli: yalnızca yönetici menüsü, üç sekme, denetim kaydı filtresi, marka kullanıcısına kapalı, CSP/konsol hatası, mobil taşma.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:governance
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
async function login(page, baseUrl, u) {
    await page.goto(baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.fill('#loginForm input[name=email]', u.email);
    await page.fill('#loginForm input[name=password]', u.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForURL(x => !x.pathname.includes('login'), { timeout: 15000 });
    await page.waitForTimeout(2500);
}
(async () => {
    const s = await startServer({ env: { SERVE_MINIFIED: '1' } });
    const admin = await s.createUser({ role: 'admin' });
    const brandUser = await s.createUser({ role: 'brand_user' });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const errs = [];
    const mk = async () => {
        const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
        page.on('pageerror', e => errs.push(e.message));
        page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|Failed to load resource|127\.0\.0\.1:3010/.test(m.text())) errs.push(m.text()); });
        await page.addInitScript(() => { window.__csp = 0; document.addEventListener('securitypolicyviolation', () => { window.__csp++; }); });
        return page;
    };

    const page = await mk();
    await login(page, s.baseUrl, admin);
    ok(await page.locator('.menu-item[data-page="governance"]').isVisible(), 'yönetici menüsünde Yönetişim görünüyor');
    await page.evaluate(() => navigateTo('governance'));
    await page.waitForSelector('#govTabBody .stat-card', { timeout: 10000 });
    ok(await page.locator('#govTabBody .stat-card').count() >= 8, 'özet kartları görünüyor');
    ok((await page.textContent('#govTabBody')).includes('YÖNETİCİ 2FA'), '2FA göstergesi var');
    await page.screenshot({ path: '/tmp/qr/gov-overview.png' });

    await page.click('#govTabs [data-tab="audit"]');
    await page.waitForSelector('#govAuditBody table', { timeout: 10000 });
    ok(await page.locator('#govAuditBody tbody tr').count() >= 1, 'denetim kaydı satırları var');
    const opts = await page.locator('#govAuditEvent option').count();
    ok(opts >= 2, 'olay filtresi seçenekleri var: ' + opts);
    await page.selectOption('#govAuditEvent', { index: 1 });
    await page.waitForTimeout(800);
    ok(await page.locator('#govAuditBody').count() === 1, 'filtre uygulandı');
    await page.screenshot({ path: '/tmp/qr/gov-audit.png' });

    await page.click('#govTabs [data-tab="health"]');
    await page.waitForSelector('#govHealthRefresh', { timeout: 10000 });
    ok((await page.textContent('#govTabBody')).includes('Sağlıklı'), 'sistem sağlığı: veritabanı sağlıklı');
    await page.screenshot({ path: '/tmp/qr/gov-health.png' });

    await page.setViewportSize({ width: 390, height: 800 });
    await page.click('#govTabs [data-tab="overview"]');
    await page.waitForSelector('#govTabBody .stat-card');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 1, 'mobilde yatay taşma yok (' + overflow + 'px)');
    await page.screenshot({ path: '/tmp/qr/gov-mobile.png' });

    const page2 = await mk();
    await login(page2, s.baseUrl, brandUser);
    ok(!(await page2.locator('.menu-item[data-page="governance"]').isVisible()), 'marka kullanıcısı menüde Yönetişim görmez');
    await page2.evaluate(() => navigateTo('governance'));
    await page2.waitForTimeout(1500);
    ok(await page2.locator('#govTabs').count() === 0, 'marka kullanıcısı sayfaya giremez');

    const csp = (await page.evaluate(() => window.__csp).catch(() => 0)) + (await page2.evaluate(() => window.__csp).catch(() => 0));
    ok(!csp, 'CSP ihlali yok');
    ok(errs.length === 0, 'konsol/sayfa hatası yok ' + JSON.stringify(errs.slice(0, 3)));
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
