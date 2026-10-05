// Tarayıcı (Chromium) uçtan uca denetimi. Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:<ad>
// CHROMIUM_PATH tanımlıysa o tarayıcı kullanılır (yoksa playwright'ın kendi tarayıcısı).
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test', SERVE_MINIFIED: '1' } });
    const user = await s.createUser({ role: 'admin' });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    let navs = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });

    // 1) yanlış şifre -> mesaj görünür, sayfa yenilenmez
    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    const before = navs;
    await page.fill('#loginForm input[name=email]', user.email);
    await page.fill('#loginForm input[name=password]', 'yanlis-Parola-9');
    await page.click('#loginForm button[type=submit]');
    await page.waitForTimeout(1500);
    const errVisible = await page.locator('text=/geçersiz|hatalı|yanlış|başarısız|Email veya şifre/i').first().isVisible().catch(() => false);
    ok(errVisible, 'yanlış şifrede hata mesajı görünüyor');
    ok(navs === before, 'yanlış şifrede sayfa yeniden yönlenmedi');

    // 2) doğru giriş
    await page.fill('#loginForm input[name=password]', user.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    ok(new URL(page.url()).pathname === '/', 'giriş sonrası panele yönlendi: ' + page.url());
    const ls = await page.evaluate(() => ({ token: localStorage.getItem('auth_token'), cookie: document.cookie }));
    ok(ls.token === null, 'localStorage içinde auth_token YOK');
    ok(!/tk_session/.test(ls.cookie), 'oturum çerezi JS tarafından okunamıyor (httpOnly)');
    const cookies = await ctx.cookies();
    const c = cookies.find(x => x.name === 'tk_session');
    ok(c && c.httpOnly && c.sameSite === 'Lax', 'tarayıcıda tk_session httpOnly + Lax');
    ok(await page.locator('.sidebar, nav, #app, main').first().isVisible().catch(() => false), 'panel arayüzü görünüyor');

    // 3) yenileme sonrası oturum sürer
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    ok(new URL(page.url()).pathname === '/', 'yenilemeden sonra hâlâ giriş yapılmış');

    // 4) giriş sayfası oturum varken panele atar (döngü yok)
    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    ok(new URL(page.url()).pathname === '/', 'oturum varken login.html panele yönlendiriyor');

    // 5) çıkış
    await page.evaluate(() => API.logout());
    await page.waitForTimeout(2500);
    ok(/login|giris/.test(page.url()), 'çıkış sonrası giriş sayfası: ' + page.url());
    const after = (await ctx.cookies()).find(x => x.name === 'tk_session');
    ok(!after, 'çıkış sonrası çerez silindi');
    await page.goto(s.baseUrl + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    ok(/login|giris/.test(page.url()), 'çıkıştan sonra panel erişimi girişe atıyor');

    console.log('Konsol/sayfa hataları:', errs.length); errs.slice(0, 10).forEach(e => console.log('  -', e.slice(0, 200)));
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
