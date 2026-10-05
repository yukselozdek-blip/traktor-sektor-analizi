// Tarayıcı (Chromium) uçtan uca denetimi. Çalıştırma: TEST_DATABASE_URL=postgresql://... npm run e2e:<ad>
// CHROMIUM_PATH tanımlıysa o tarayıcı kullanılır (yoksa playwright'ın kendi tarayıcısı).
const { chromium } = require('playwright-core');
const { startServer } = require('../tests/helpers');
const PAGES = ['brand-hub','dashboard','sales','province','map','weather','models','model-intel','competitors','brand-compare','benchmark','historical','brand-summary','hp-top','hp-top-il','hp-top-model','hp-brand-matrix','obt-hp','regional-index','total-market','tarmakbir','tarmakbir2','media-watch','ai-insights','settings','subscription','model-images-admin','model-region','prov-top-brand','brand-hp','hp-segment','hp-top-il-cat'];
(async () => {
    const s = await startServer({ env: { NODE_ENV: 'test' } });
    const P = tag => `<img src=x onerror=__xss='${tag}'>`.slice(0, 60); const S = tag => `<b onclick=1>${tag}`.slice(0,18);
    const admin = await s.createUser({ role: 'admin' });
    const bu = await s.createUser({ role: 'brand_user' });
    await s.pool.query(`UPDATE users SET full_name=$2, company_name=$3, job_title=$4, phone=$5, city=$6 WHERE id=$1`,
        [bu.id, P('full_name'), P('company'), P('job'), 'x<i>'+1, 'y<i>'+2]);
    await s.pool.query(`UPDATE users SET full_name=$2, company_name=$3 WHERE id=$1`, [admin.id, P('admin_name'), P('admin_company')]);
    await s.pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
      SELECT b.id, p.id, 2025, m.month, 5+(b.id+p.id+m.month)%20,'Tarla','Kabinli','4WD','70-90 HP','12+12','x' FROM (SELECT id FROM brands ORDER BY id LIMIT 4) b,(SELECT id FROM provinces ORDER BY id LIMIT 10) p, generate_series(1,6) m(month)`);

    const X = t => `<img src=x onerror=__xss='${t}'>`;
    const brandRows = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 6')).rows;
    for (const [i, b] of brandRows.entries()) {
        await s.pool.query(`INSERT INTO media_watch_items (brand_id, channel_type, item_type, source_url, title, summary, content_text, ai_summary, source_name, source_domain, platform_name, author_name, model_name, language, published_at, country_code, dedupe_hash, severity_score, relevance_score, sentiment_label)
            VALUES ($1,'news','launch',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'tr',NOW(),'TR',$12,80,90,'positive')`,
            [b.id, 'javascript:__xss="url_'+i+'"', X('title'), X('summary'), X('content'), X('ai'), X('source'), X('domain'), X('platform'), X('author'), X('model'), 'hx'+i]);
        await s.pool.query(`INSERT INTO media_watch_alerts (brand_id, alert_type, severity, title, message, is_active) VALUES ($1,'x','high',$2,$3,true)`, [b.id, X('alert_title'), X('alert_msg')]).catch(e => {});
    }
    await s.pool.query(`UPDATE brands SET name = name WHERE id = -1`);
    const m = await s.pool.query(`SELECT id FROM tractor_models LIMIT 1`).catch(() => ({rows: []}));

    // Senaryo B: görünen ad alanlarını zehirle (marka/il/model adları ve portal alanları)
    const tbl = async (t, cols, extra='') => { for (const c of cols) { await s.pool.query(`UPDATE ${t} SET ${c} = LEFT('<img src=x onerror=__xss=''${t}.${c}''>', 150) || id::text ${extra}`).catch(e => console.log('poison skip', t, c, e.message.slice(0,60))); } };
    await tbl('brands', ['name']);
    await tbl('provinces', ['name']);
    await tbl('tractor_models', ['model_name']);
    const cols = (await s.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='brand_portal_profiles' AND data_type IN ('character varying','text')`)).rows.map(r => r.column_name).filter(c => /url|tagline|summary|description|headline|story|slogan|about|mission|vision|address|city|name|contact|title/.test(c));
    console.log('portal sütunları:', cols.join(','));
    for (const c of cols) await s.pool.query(`UPDATE brand_portal_profiles SET ${c} = LEFT('<img src=x onerror=__xss=''portal.${c}''>', 250)`).catch(() => {});
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    let total = 0;
    for (const u of [bu, admin]) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        page.on('dialog', d => d.dismiss());
        await page.goto(s.baseUrl + '/login.html', { waitUntil: 'networkidle' });
        await page.fill('#loginForm input[name=email]', u.email);
        await page.fill('#loginForm input[name=password]', u.password);
        await page.click('#loginForm button[type=submit]');
        await page.waitForTimeout(3500);
        for (const pg of PAGES) {
            await page.evaluate(p => { window.__xss = null; location.hash = '#/' + p; }, pg);
            await page.waitForTimeout(900);
            const x = await page.evaluate(() => window.__xss);
            if (x) { total++; console.log(`XSS! rol=${u.role} sayfa=${pg} alan=${x}`); }
        }
        // profil/ayarlar paneli
        await page.evaluate(() => { window.__xss = null; });
        await ctx.close();
    }
    console.log('Toplam XSS tetiklenmesi:', total);
    await browser.close(); await s.stop();
})().catch(e => { console.error(e); process.exit(1); });
