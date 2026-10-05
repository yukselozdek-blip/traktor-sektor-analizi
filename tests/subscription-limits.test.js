'use strict';
// Plan limitleri/özellik kapıları yalnızca ödemesi onaylanmış (active/trialing) ve dönemi
// dolmamış abonelikte geçerlidir; abonelik sayfası pending'i göstermeye devam eder.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('abonelik limitleri (pending/active/süresi dolmuş)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, planId, brands;
    before(async () => {
        s = await startServer();
        planId = (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys)
             VALUES ('Limit Test', 'limit-test', 0, $1::jsonb, $2::jsonb) RETURNING id`,
            [JSON.stringify({ max_rivals: 2, history_months: 12, ai_queries_monthly: 5, export_rows_monthly: 10, api_requests_monthly: 0, whatsapp_phones: 1 }),
             JSON.stringify(['ai_insights'])]
        )).rows[0].id;
        brands = (await s.pool.query('SELECT id FROM brands ORDER BY id LIMIT 5')).rows.map(r => r.id);
    });

    // E-posta doğrulaması zorunlu olabilir: kullanıcıyı doğrulanmış oluşturup giriş yap
    async function mkUser(opts = {}) {
        const u = await s.createUser(opts);
        await s.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [u.id]);
        const res = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        if (res.status !== 200 || !res.json?.token) throw new Error(`Login başarısız (${res.status}): ${res.text}`);
        return { ...u, token: res.json.token };
    }
    after(async () => { if (s) await s.stop(); });

    async function userWithSub(status, periodEndSql, brandId = null) {
        const u = await mkUser({ role: 'brand_user' });
        if (brandId) await s.pool.query('UPDATE users SET brand_id = $1 WHERE id = $2', [brandId, u.id]);
        if (status) {
            await s.pool.query(
                `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
                 VALUES ($1, $2, $3, 'test', NOW(), ${periodEndSql})`, [u.id, planId, status]);
        }
        return u;
    }
    const usage = u => s.api('GET', '/api/billing/usage', { token: u.token });
    const insights = u => s.api('GET', '/api/insights', { token: u.token });

    it('pending abonelik: tüm limitler 0, özellik kapısı kapalı', async () => {
        const u = await userWithSub('pending', 'NULL');
        const r = await usage(u);
        assert.equal(r.status, 200, r.text);
        for (const k of ['max_rivals', 'history_months', 'ai_queries_monthly', 'export_rows_monthly', 'whatsapp_phones']) {
            assert.equal(r.json.limits[k], 0, k);
        }
        const f = await insights(u);
        assert.equal(f.status, 402);
        assert.equal(f.json.code, 'NO_ACTIVE_SUBSCRIPTION');
    });

    it('active abonelik: plan limitleri ve özellik kapısı açık', async () => {
        const u = await userWithSub('active', `NOW() + INTERVAL '10 days'`);
        const r = await usage(u);
        assert.equal(r.json.limits.ai_queries_monthly, 5);
        assert.equal(r.json.limits.max_rivals, 2);
        assert.equal((await insights(u)).status, 200);
    });

    it('active + current_period_end NULL kırılmaz', async () => {
        const u = await userWithSub('active', 'NULL');
        assert.equal((await usage(u)).json.limits.max_rivals, 2);
        assert.equal((await insights(u)).status, 200);
    });

    it('trialing abonelik geçerli', async () => {
        const u = await userWithSub('trialing', `NOW() + INTERVAL '3 days'`);
        assert.equal((await insights(u)).status, 200);
    });

    it('süresi dolmuş active: limitler 0, özellik kapısı kapalı', async () => {
        const u = await userWithSub('active', `NOW() - INTERVAL '1 day'`);
        assert.equal((await usage(u)).json.limits.ai_queries_monthly, 0);
        assert.equal((await insights(u)).status, 402);
    });

    it('cancelled/past_due: limitler 0', async () => {
        for (const st of ['cancelled', 'past_due']) {
            const u = await userWithSub(st, `NOW() + INTERVAL '10 days'`);
            assert.equal((await usage(u)).json.limits.ai_queries_monthly, 0, st);
            assert.equal((await insights(u)).status, 402, st);
        }
    });

    it('abonelik sayfası verisi pending aboneliği hâlâ gösterir', async () => {
        const u = await userWithSub('pending', 'NULL');
        const sub = await s.api('GET', '/api/subscription', { token: u.token });
        assert.equal(sub.status, 200);
        assert.equal(sub.json.status, 'pending');
        assert.equal(sub.json.plan_slug, 'limit-test');
        assert.equal(sub.json.is_entitled, false);
        assert.equal(sub.json.payment_pending, true);
        const me = await s.api('GET', '/api/me/features', { token: u.token });
        assert.equal(me.json.status, 'pending');
        assert.equal(me.json.has_active_subscription, false);
        assert.equal(me.json.payment_pending, true);
        assert.deepEqual(me.json.feature_keys, []);
        // pending abonelik iptal edilebilir (yönetim yolu)
        const c = await s.api('POST', '/api/billing/cancel', { token: u.token, body: {} });
        assert.equal(c.status, 200, c.text);
        // active kullanıcıda is_entitled true
        const a = await userWithSub('active', `NOW() + INTERVAL '5 days'`);
        const asub = await s.api('GET', '/api/subscription', { token: a.token });
        assert.equal(asub.json.is_entitled, true);
        assert.deepEqual((await s.api('GET', '/api/me/features', { token: a.token })).json.feature_keys, ['ai_insights']);
    });

    describe('PUT /api/billing/rivals', () => {
        const put = (u, ids) => s.api('PUT', '/api/billing/rivals', { token: u.token, body: { rival_brand_ids: ids } });

        it('pending abonelikte rakip seçimi yapılamaz (404)', async () => {
            const u = await userWithSub('pending', 'NULL', brands[0]);
            assert.equal((await put(u, [brands[1]])).status, 404);
        });

        it('geçerli seçim kaydedilir; "3" gibi tamsayı metni sayıya çevrilir', async () => {
            const u = await userWithSub('active', `NOW() + INTERVAL '10 days'`, brands[0]);
            const r = await put(u, [brands[1], String(brands[2])]);
            assert.equal(r.status, 200, r.text);
            assert.deepEqual(r.json.selected, [brands[1], brands[2]]);
            const g = await s.api('GET', '/api/billing/rivals', { token: u.token });
            assert.deepEqual(g.json.selected, [brands[1], brands[2]]);
        });

        it('geçersiz id türleri, tekrar, olmayan/pasif marka, kendi marka, limit aşımı reddedilir', async () => {
            const u = await userWithSub('active', `NOW() + INTERVAL '10 days'`, brands[0]);
            for (const bad of [['abc'], [1.5], [null], [{}], [-1], [0], [NaN], [true], ['1e3']]) {
                assert.equal((await put(u, bad)).status, 400, JSON.stringify(bad));
            }
            assert.equal((await put(u, [brands[1], brands[1]])).status, 400, 'tekrar');
            assert.equal((await put(u, [999999])).status, 400, 'olmayan marka');
            assert.equal((await put(u, [brands[0]])).status, 400, 'kendi marka');
            assert.equal((await put(u, [brands[1], brands[2], brands[3]])).status, 400, 'limit (2) aşımı');
            await s.pool.query('UPDATE brands SET is_active = false WHERE id = $1', [brands[4]]);
            assert.equal((await put(u, [brands[4]])).status, 400, 'pasif marka');
            await s.pool.query('UPDATE brands SET is_active = true WHERE id = $1', [brands[4]]);
            assert.equal((await s.api('PUT', '/api/billing/rivals', { token: u.token, body: { rival_brand_ids: 'x' } })).status, 400);
        });

        it('max_rivals tanımsız plan: sınır 0 uygulanır; -1 sınırsız', async () => {
            const noLimit = (await s.pool.query(
                `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys) VALUES ('NL','nl-test',0,'{}'::jsonb,'[]'::jsonb) RETURNING id`)).rows[0].id;
            const unl = (await s.pool.query(
                `INSERT INTO subscription_plans (name, slug, price_monthly, plan_limits, feature_keys) VALUES ('UL','ul-test',0,'{"max_rivals":-1}'::jsonb,'[]'::jsonb) RETURNING id`)).rows[0].id;
            const mk = async pid => {
                const u = await mkUser({ role: 'brand_user' });
                await s.pool.query('UPDATE users SET brand_id = $1 WHERE id = $2', [brands[0], u.id]);
                await s.pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start) VALUES ($1,$2,'active','test',NOW())`, [u.id, pid]);
                return u;
            };
            const a = await mk(noLimit);
            assert.equal((await put(a, [brands[1]])).status, 400);
            assert.equal((await put(a, [])).status, 200);
            const b = await mk(unl);
            assert.equal((await put(b, [brands[1], brands[2], brands[3], brands[4]])).status, 200);
        });
    });
});
