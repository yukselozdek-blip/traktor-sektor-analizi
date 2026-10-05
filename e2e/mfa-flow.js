// İki adımlı doğrulama tarayıcı akışı: yönetici zorunlu kurulum → kurtarma kodları → panel → çıkış → kodla giriş → ayarlar kartı.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:mfa
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const totp = require('../src/lib/totp');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
    const s = await startServer({ env: { REQUIRE_ADMIN_2FA: '1', SERVE_MINIFIED: '1' } });
    const user = await s.createUser({ role: 'admin' });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|Failed to load resource|127\.0\.0\.1:3010/.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__csp = 0; document.addEventListener('securitypolicyviolation', () => { window.__csp++; }); });

    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.fill('#loginForm input[name=email]', user.email);
    await page.fill('#loginForm input[name=password]', user.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#mfaForm.is-active', { timeout: 8000 }).catch(async e => { console.log('DEBUG', await page.locator('#errorMsg').textContent(), JSON.stringify(errs)); throw e; });
    ok(await page.locator('#mfaSetupBox').isVisible(), 'yönetici için zorunlu kurulum ekranı geldi');
    await page.waitForFunction(() => document.getElementById('mfaSecret').textContent.length > 10);
    const secret = (await page.textContent('#mfaSecret')).trim();
    ok(await page.locator('#mfaQr svg').count() === 1, 'QR kod çizildi');
    await page.locator('#mfaQr').screenshot({ path: '/tmp/qr/mfa-qr.png' });
    ok(new URL(page.url()).pathname.includes('login'), 'kurulum bitmeden panele geçilmedi');

    await page.fill('#mfaCode', '000000');
    await page.click('#mfaSubmit');
    await page.waitForTimeout(800);
    ok(await page.locator('#errorMsg').isVisible(), 'yanlış kodda hata gösterildi');

    await page.fill('#mfaCode', totp.hotp(secret, totp.currentStep()));
    await page.click('#mfaSubmit');
    await page.waitForSelector('#mfaRecoveryBox', { state: 'visible', timeout: 8000 });
    const codes = (await page.textContent('#mfaRecoveryList')).trim().split('\n');
    ok(codes.length === 10, 'kurtarma kodları gösterildi: ' + codes.length);
    await page.click('#mfaContinue');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 });
    await page.waitForTimeout(2500);
    ok(new URL(page.url()).pathname === '/', 'kurulum sonrası panele geçildi');

    // Ayarlar kartı
    await page.evaluate(() => navigateTo('settings'));
    await page.waitForSelector('#mfaCardHost .card', { timeout: 8000 });
    const cardText = await page.textContent('#mfaCardHost');
    ok(/Etkin/.test(cardText) && /zorunludur/.test(cardText) && !/Kapat/.test(cardText), 'ayarlar kartı: etkin + yönetici için kapatma yok');

    // Çıkış ve kodla giriş
    await page.evaluate(() => API.logout());
    await page.waitForTimeout(2500);
    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.fill('#loginForm input[name=email]', user.email);
    await page.fill('#loginForm input[name=password]', user.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#mfaForm.is-active', { timeout: 8000 });
    ok(!(await page.locator('#mfaSetupBox').isVisible()), 'ikinci girişte kurulum değil kod isteniyor');
    await page.fill('#mfaCode', codes[0]); // kurtarma kodu (TOTP adımı kurulumda tüketildi)
    await page.click('#mfaSubmit');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 });
    ok(true, 'kurtarma koduyla giriş yapıldı');

    const csp = await page.evaluate(() => window.__csp).catch(() => 0);
    ok(errs.length === 0, 'konsol/sayfa hatası yok ' + JSON.stringify(errs.slice(0, 3)));
    ok(!csp, 'CSP ihlali yok');
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
