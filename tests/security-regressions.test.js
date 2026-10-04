'use strict';
// Güvenlik denetimi bulguları için regresyon testleri (IDOR, webhook, üretim tespiti, yönetici kullanıcı oluşturma).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');
const { isProduction } = require('../src/lib/env');

describe('isProduction', () => {
    const keys = ['NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID'];
    const saved = {};
    before(() => keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; }));
    after(() => keys.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
    it('NODE_ENV=production ya da Railway ortam değişkenleri üretimdir; aksi geliştirme', () => {
        assert.equal(isProduction(), false);
        process.env.NODE_ENV = 'production'; assert.equal(isProduction(), true); delete process.env.NODE_ENV;
        process.env.RAILWAY_ENVIRONMENT = 'production'; assert.equal(isProduction(), true); delete process.env.RAILWAY_ENVIRONMENT;
        process.env.RAILWAY_PROJECT_ID = 'abc'; assert.equal(isProduction(), true); delete process.env.RAILWAY_PROJECT_ID;
        assert.equal(isProduction(), false);
    });
});

describe('yetki ve webhook regresyonları', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brands, entPlanId;
    before(async () => {
        s = await startServer({ env: { WHATSAPP_VERIFY_TOKEN: '', MEDIA_WATCH_WEBHOOK_KEY: 'mw-key-123' } });
        brands = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 2')).rows.map(r => r.id);
        entPlanId = (await s.pool.query(`SELECT id FROM subscription_plans WHERE slug = 'enterprise'`)).rows[0].id;
    });
    after(async () => { if (s) await s.stop(); });

    async function enterpriseUser(brandId) {
        const u = await s.createUserWithToken({ role: 'brand_user' });
        await s.pool.query('UPDATE users SET brand_id = $1 WHERE id = $2', [brandId, u.id]);
        await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                            VALUES ($1, $2, 'active', 'test', NOW(), NOW() + INTERVAL '30 days')`, [u.id, entPlanId]);
        return u;
    }

    it('WhatsApp GET doğrulaması: boş yapılandırılmış token boş istekle eşleşmez (403)', async () => {
        const r = await s.api('GET', '/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=123');
        assert.equal(r.status, 403);
    });

    it('media-watch/coverage: marka kullanıcısı başka markanın brand_id\'sini isteyemez', async () => {
        const [mine, other] = brands;
        await s.pool.query(`INSERT INTO media_watch_items (brand_id, channel_type, item_type, source_url, title, language, published_at, country_code, dedupe_hash) VALUES ($1,'news','news','http://x/1','benim','tr',NOW(),'TR','h1'), ($2,'news','news','http://x/2','baskasi','tr',NOW(),'DE','h2'), ($2,'news','news','http://x/3','baskasi2','tr',NOW(),'DE','h3')`, [mine, other]);
        const u = await enterpriseUser(mine);
        const own = await s.api('GET', `/api/media-watch/coverage?brand_id=${other}`, { token: u.token });
        assert.equal(own.status, 200, own.text);
        const total = JSON.stringify(own.json);
        assert.doesNotMatch(total, /"DE"/, 'başka markanın ülke verisi görünmemeli');
    });

    it('media-watch/translate: başkasının kaydı 404 (okuma/yazma IDOR kapalı)', async () => {
        const [mine, other] = brands;
        const item = (await s.pool.query(`INSERT INTO media_watch_items (brand_id, channel_type, item_type, source_url, title, language, published_at, dedupe_hash) VALUES ($1,'news','news','http://x/9','yabanci','en',NOW(),'h9') RETURNING id`, [other])).rows[0].id;
        const u = await enterpriseUser(mine);
        const r = await s.api('POST', '/api/media-watch/translate', { token: u.token, body: { item_id: item } });
        assert.equal(r.status, 404, r.text);
    });

    it('yönetici kullanıcı oluşturma: zayıf şifre, geçersiz rol ve zararlı e-posta reddedilir', async () => {
        const admin = await s.createUserWithToken({ role: 'admin' });
        const base = { email: 'yeni@test.local', password_hash: TEST_PASSWORD, full_name: 'Yeni', role: 'brand_user', brand_id: brands[0] };
        const weak = await s.api('POST', '/api/admin/users', { token: admin.token, body: { ...base, password_hash: 'abc' } });
        assert.equal(weak.status, 400);
        const role = await s.api('POST', '/api/admin/users', { token: admin.token, body: { ...base, role: 'superadmin' } });
        assert.equal(role.status, 400);
        const mail = await s.api('POST', '/api/admin/users', { token: admin.token, body: { ...base, email: '<svg/onload=1>@x.co' } });
        assert.equal(mail.status, 400);
        const ok = await s.api('POST', '/api/admin/users', { token: admin.token, body: { ...base, email: 'Yeni.Kullanici@Test.Local' } });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.json.email, 'yeni.kullanici@test.local', 'e-posta küçük harfe çevrilmeli');
    });

    it('giriş yanıtı kalan deneme sayısını sızdırmaz', async () => {
        const u = await s.createUser({ role: 'brand_user' });
        const r = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Yanlis-Parola-1!' } });
        assert.equal(r.status, 401);
        assert.equal(r.json.attempts_left, undefined);
    });
});

describe('üretim modu: WhatsApp webhook imza anahtarı yoksa reddedilir', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer({ env: { NODE_ENV: 'production', JWT_SECRET: 'prod-secret-1234567890abcdef', WHATSAPP_VERIFY_TOKEN: 'v-token' } }); });
    after(async () => { if (s) await s.stop(); });
    it('POST 503; GET doğrulaması doğru token ile düz metin challenge döner', async () => {
        const post = await s.api('POST', '/api/public/whatsapp/webhook', { body: { entry: [] } });
        assert.equal(post.status, 503);
        const ok = await s.api('GET', '/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=v-token&hub.challenge=%3Cscript%3E1');
        assert.equal(ok.status, 200);
        assert.match(ok.headers.get('content-type'), /text\/plain/);
    });
});
