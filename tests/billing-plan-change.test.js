'use strict';
// Plan değişikliği: entitled (active/trialing) abonelik ödeme onaylanana kadar ESKİ planla sürer;
// bekleyen değişiklik yalnızca payments kaydında tutulur. Entitled olmayanlar pending abonelik alır.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

async function noRedirect(url, headers = {}) {
    const r = await fetch(url, { redirect: 'manual', headers });
    return { status: r.status, location: r.headers.get('location') || '' };
}

describe('billing plan değişikliği (entitled kullanıcı erişimini korur)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, starterId, growthId;
    before(async () => {
        s = await startServer();
        const mk = async (slug, ai) => (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, plan_limits, feature_keys)
             VALUES ($1, $1, 10, 100, $2::jsonb, $3::jsonb) RETURNING id`,
            [slug, JSON.stringify({ max_rivals: 2, history_months: 12, ai_queries_monthly: ai, export_rows_monthly: 10, api_requests_monthly: 0, whatsapp_phones: 1 }),
             JSON.stringify(['ai_insights'])])).rows[0].id;
        starterId = await mk('pc-starter', 5);
        growthId = await mk('pc-growth', 50);
    });
    after(async () => { if (s) await s.stop(); });

    async function mkUser(opts = {}) {
        const u = await s.createUser(opts);
        await s.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [u.id]);
        const res = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        if (res.status !== 200 || !res.json?.token) throw new Error(`Login başarısız (${res.status}): ${res.text}`);
        return { ...u, token: res.json.token };
    }
    async function userWithSub(status, periodEndSql = `NOW() + INTERVAL '10 days'`) {
        const u = await mkUser({ role: 'brand_user' });
        const id = (await s.pool.query(
            `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
             VALUES ($1, $2, $3, 'test', NOW(), ${periodEndSql}) RETURNING id`, [u.id, starterId, status])).rows[0].id;
        return { ...u, subId: id };
    }
    const checkout = (u, plan, provider = 'stripe', period = 'monthly') =>
        s.api('POST', '/api/billing/checkout', { token: u.token, body: { plan_slug: plan, provider, period } });
    const subRow = async u => (await s.pool.query(
        `SELECT s.id, s.status, sp.slug FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.user_id = $1 ORDER BY s.id`, [u.id])).rows;
    const usage = u => s.api('GET', '/api/billing/usage', { token: u.token });
    const success = (u, sid) => noRedirect(`${s.baseUrl}/billing/success?session_id=${sid}&provider=stripe&plan=pc-starter`, { Authorization: `Bearer ${u.token}` });

    it('active starter growth için checkout başlatır: abonelik/erişim starter ile sürer, payments pending', async () => {
        const u = await userWithSub('active');
        const co = await checkout(u, 'pc-growth', 'stripe', 'yearly');
        assert.equal(co.status, 200, co.text);
        const rows = await subRow(u);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'active');
        assert.equal(rows[0].slug, 'pc-starter');
        const us = await usage(u);
        assert.equal(us.json.limits.ai_queries_monthly, 5, 'erişim eski planla sürmeli');
        assert.equal((await s.api('GET', '/api/insights', { token: u.token })).status !== 402, true, 'özellik kapısı açık kalmalı');
        const pay = await s.pool.query(`SELECT status, metadata FROM payments WHERE user_id = $1`, [u.id]);
        assert.equal(pay.rows.length, 1);
        assert.equal(pay.rows[0].status, 'pending');
        assert.equal(pay.rows[0].metadata.plan_slug, 'pc-growth');
        assert.equal(pay.rows[0].metadata.period, 'yearly');
        const api = await s.api('GET', '/api/subscription', { token: u.token });
        assert.equal(api.json.plan_slug, 'pc-starter');
        assert.equal(api.json.is_entitled, true);
        assert.deepEqual(api.json.pending_change, { plan_slug: 'pc-growth', period: 'yearly' });
    });

    it('change-plan da entitled aboneliği değiştirmez; mock onay sonrası plan growth olur', async () => {
        const u = await userWithSub('active');
        const r = await s.api('POST', '/api/billing/change-plan', { token: u.token, body: { plan_slug: 'pc-growth', provider: 'stripe', period: 'monthly' } });
        assert.equal(r.status, 200, r.text);
        assert.equal((await subRow(u))[0].slug, 'pc-starter');
        const sid = (await s.pool.query(`SELECT provider_payment_id FROM payments WHERE user_id = $1`, [u.id])).rows[0].provider_payment_id;
        // sorgudaki plan=pc-starter yok sayılır, plan ödeme kaydından okunur
        const ok = await success(u, sid);
        assert.match(ok.location, /billing=success/);
        const rows = await subRow(u);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'active');
        assert.equal(rows[0].slug, 'pc-growth');
        assert.equal((await usage(u)).json.limits.ai_queries_monthly, 50);
        assert.equal((await s.pool.query(`SELECT status FROM payments WHERE user_id = $1`, [u.id])).rows[0].status, 'completed');
        assert.equal((await s.api('GET', '/api/subscription', { token: u.token })).json.pending_change, null);
    });

    it('entitled olmayan kullanıcıda checkout pending abonelik oluşturur, limitler 0', async () => {
        const fresh = await mkUser({ role: 'brand_user' });
        assert.equal((await checkout(fresh, 'pc-growth')).status, 200);
        let rows = await subRow(fresh);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].slug, 'pc-growth');
        assert.equal((await usage(fresh)).json.limits.ai_queries_monthly, 0);
        assert.equal((await s.api('GET', '/api/insights', { token: fresh.token })).status, 402);

        // süresi dolmuş active: entitled değil -> pending akışı
        const expired = await userWithSub('active', `NOW() - INTERVAL '1 day'`);
        assert.equal((await checkout(expired, 'pc-growth')).status, 200);
        rows = await subRow(expired);
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].slug, 'pc-growth');
        assert.equal((await usage(expired)).json.limits.ai_queries_monthly, 0);
    });

    it('iki bekleyen ödemeden yalnızca onaylananın planı uygulanır', async () => {
        const u = await userWithSub('active');
        await checkout(u, 'pc-growth', 'stripe', 'monthly');
        await checkout(u, 'pc-starter', 'stripe', 'yearly');
        const pays = (await s.pool.query(`SELECT id, provider_payment_id, metadata FROM payments WHERE user_id = $1 ORDER BY id`, [u.id])).rows;
        assert.equal(pays.length, 2);
        assert.equal((await subRow(u))[0].slug, 'pc-starter');
        // growth olanı onayla (ilk kayıt); ikincisi (starter/yearly) pending kalmalı
        const ok = await success(u, pays[0].provider_payment_id);
        assert.match(ok.location, /billing=success/);
        assert.equal((await subRow(u))[0].slug, 'pc-growth');
        const after = (await s.pool.query(`SELECT id, status FROM payments WHERE user_id = $1 ORDER BY id`, [u.id])).rows;
        assert.equal(after[0].status, 'completed');
        assert.equal(after[1].status, 'pending');
    });

    it('banka onayı: referanslı bekleyen ödemenin planı uygulanır, diğer bekleyen ödeme etkilenmez', async () => {
        const u = await userWithSub('active');
        const a = await checkout(u, 'pc-growth', 'bank_transfer', 'monthly');
        assert.equal(a.status, 200, a.text);
        const ref = a.json.bank_reference;
        await checkout(u, 'pc-starter', 'bank_transfer', 'yearly');
        const admin = await mkUser({ role: 'admin' });
        const r = await s.api('POST', '/api/billing/bank-confirm', { token: admin.token, body: { reference: ref, user_id: u.id, plan_slug: 'pc-starter', period: 'yearly' } });
        assert.equal(r.status, 200, r.text);
        assert.equal((await subRow(u))[0].slug, 'pc-growth', 'plan ödeme kaydından okunmalı');
        const pays = (await s.pool.query(`SELECT status FROM payments WHERE user_id = $1 ORDER BY id`, [u.id])).rows;
        assert.deepEqual(pays.map(p => p.status), ['completed', 'pending']);
    });
});
