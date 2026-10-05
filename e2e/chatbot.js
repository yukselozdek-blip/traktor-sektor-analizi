// AI Asistan sayfası: yardım yanıtı, öneri çipi, geçmişin sunucudan yüklenmesi, temizleme, CSP/konsol hatası, mobil taşma.
// Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:chatbot
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
    const s = await startServer({ env: { SERVE_MINIFIED: '1' } });
    const user = await s.createUser({ role: 'admin' });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|Failed to load resource|127\.0\.0\.1:3010/.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__csp = 0; document.addEventListener('securitypolicyviolation', () => { window.__csp++; }); });

    await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
    await page.fill('#loginForm input[name=email]', user.email);
    await page.fill('#loginForm input[name=password]', user.password);
    await page.click('#loginForm button[type=submit]');
    await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 15000 });
    await page.waitForTimeout(2500);

    ok(await page.locator('.menu-item[data-page="chatbot"]').count() === 1, 'menüde AI Asistan var');
    await page.evaluate(() => navigateTo('chatbot'));
    await page.waitForSelector('#chatbotStream', { timeout: 8000 });
    ok(await page.locator('.chatbot-suggestion-chip').count() === 6, '6 öneri çipi görünüyor');
    await page.screenshot({ path: '/tmp/qr/chatbot-desktop.png' });

    await page.fill('#chatbotInput', 'merhaba');
    await page.click('#chatbotSend');
    await page.waitForSelector('.chatbot-msg--bot', { timeout: 8000 });
    const txt = await page.textContent('.chatbot-msg--bot .chatbot-msg__text');
    ok(/Asistan/.test(txt), 'yardım yanıtı geldi');
    ok(await page.locator('.chatbot-msg--user').count() === 1, 'kullanıcı mesajı görünüyor');

    // XSS: yanıt/mesaj kaçışlanır
    await page.fill('#chatbotInput', '<img src=x onerror=window.__xss=1> merhaba');
    await page.click('#chatbotSend');
    await page.waitForFunction(() => document.querySelectorAll('.chatbot-msg--bot').length >= 2, null, { timeout: 8000 });
    ok(await page.evaluate(() => !window.__xss && !document.querySelector('.chatbot-msg__text img')), 'HTML enjeksiyonu çalışmadı (kaçışlı)');

    // Sayfa yenilenince geçmiş sunucudan gelir
    await page.evaluate(() => navigateTo('dashboard'));
    await page.waitForTimeout(1500);
    await page.evaluate(() => navigateTo('chatbot'));
    await page.waitForFunction(() => document.querySelectorAll('.chatbot-msg').length >= 4, null, { timeout: 8000 });
    ok(true, 'geçmiş sunucudan yüklendi');
    const act = await page.evaluate(() => [...document.querySelectorAll('.menu-item.active')].map(e => e.dataset.page));
    ok(act.length === 1 && act[0] === 'chatbot', 'menüde yalnızca AI Asistan etkin: ' + JSON.stringify(act));
    await page.screenshot({ path: '/tmp/qr/chatbot-chat.png' });

    page.once('dialog', d => d.accept());
    await page.click('#chatbotClear');
    await page.waitForSelector('.chatbot-empty', { timeout: 5000 });
    ok(true, 'geçmiş temizlendi');

    // Mobil: yatay taşma yok
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 1, 'mobilde yatay taşma yok (' + overflow + 'px)');
    await page.screenshot({ path: '/tmp/qr/chatbot-mobile.png' });

    const csp = await page.evaluate(() => window.__csp).catch(() => 0);
    ok(!csp, 'CSP ihlali yok');
    ok(errs.length === 0, 'konsol/sayfa hatası yok ' + JSON.stringify(errs.slice(0, 3)));
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
