'use strict';
// Ödemesiz abonelik aktivasyonu ve bank-info XSS regresyon testleri.
// Test sunucusu NODE_ENV=test (mock izinli) ile açılır; üretim davranışı NODE_ENV=production + ALLOW_MOCK_BILLING yok ile ayrıca denenir.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

async function noRedirect(url, headers = {}) {
    const r = await fetch(url, { redirect: 'manual', headers });
    return { status: r.status, location: r.headers.get('location') || '' };
}

describe('billing güvenliği (geliştirme/mock modu)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('/billing/success sorgu parametreleriyle (plan=enterprise) abonelik aktive ETMEZ', async () => {
        const u = await s.createUserWithToken();
        const r = await noRedirect(`${s.baseUrl}/billing/success?provider=stripe&plan=enterprise&period=yearly`, { Authorization: `Bearer ${u.token}` });
        assert.match(r.location, /billing=error/);
        const sub = await s.pool.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [u.id]);
        assert.equal(sub.rows.length, 0, 'abonelik oluşmamalı');
    });

    it('başkasının session_id\'si ile aktivasyon olmaz', async () => {
        const victim = await s.createUserWithToken();
        const attacker = await s.createUserWithToken();
        const plan = (await s.pool.query('SELECT slug FROM subscription_plans WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].slug;
        const co = await s.api('POST', '/api/billing/checkout', { token: victim.token, body: { plan_slug: plan, provider: 'stripe', period: 'monthly' } });
        assert.equal(co.status, 200, co.text);
        const sid = (await s.pool.query('SELECT provider_payment_id FROM payments WHERE user_id = $1', [victim.id])).rows[0].provider_payment_id;
        const r = await noRedirect(`${s.baseUrl}/billing/success?session_id=${sid}&plan=enterprise`, { Authorization: `Bearer ${attacker.token}` });
        assert.match(r.location, /billing=error/);
        const sub = await s.pool.query(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active'`, [attacker.id]);
        assert.equal(sub.rows.length, 0);
        const own = await s.pool.query(`SELECT status FROM subscriptions WHERE user_id = $1`, [victim.id]);
        assert.equal(own.rows[0].status, 'pending', 'kurbanın aboneliği de değişmemeli');
    });

    it('mock akışta kendi bekleyen ödemesi için aktivasyon çalışır; plan ödeme kaydından okunur', async () => {
        const u = await s.createUserWithToken();
        const plan = (await s.pool.query('SELECT slug FROM subscription_plans WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].slug;
        await s.api('POST', '/api/billing/checkout', { token: u.token, body: { plan_slug: plan, provider: 'stripe', period: 'monthly' } });
        const sid = (await s.pool.query('SELECT provider_payment_id FROM payments WHERE user_id = $1', [u.id])).rows[0].provider_payment_id;
        const r = await noRedirect(`${s.baseUrl}/billing/success?session_id=${sid}&plan=enterprise&period=yearly`, { Authorization: `Bearer ${u.token}` });
        assert.match(r.location, /billing=success/);
        const sub = await s.pool.query(`SELECT sp.slug, s.status FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.user_id = $1`, [u.id]);
        assert.equal(sub.rows[0].status, 'active');
        assert.equal(sub.rows[0].slug, plan, 'sorgudaki plan=enterprise yok sayılmalı');
    });

    it('/billing/bank-info parametreleri HTML\'e kaçışsız yazılmaz (XSS)', async () => {
        const r = await s.api('GET', '/billing/bank-info?plan=%3Cimg%20src=x%20onerror=alert(1)%3E&ref=%3Cscript%3Ealert(1)%3C/script%3E&period=monthly');
        assert.equal(r.status, 200);
        assert.doesNotMatch(r.text, /<img src=x/);
        assert.doesNotMatch(r.text, /<script>alert/);
        assert.match(r.text, /&lt;img src=x/);
    });
});

describe('billing güvenliği (üretim modu)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer({ env: { NODE_ENV: 'production', JWT_SECRET: 'test-secret-prod-1234567890' } }); });
    after(async () => { if (s) await s.stop(); });

    it('mock ödeme sağlayıcısı üretimde 503 verir (ücretsiz abonelik yok)', async () => {
        const u = await s.createUserWithToken();
        const plan = (await s.pool.query('SELECT slug FROM subscription_plans WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].slug;
        const r = await s.api('POST', '/api/billing/checkout', { token: u.token, body: { plan_slug: plan, provider: 'stripe', period: 'monthly' } });
        assert.equal(r.status, 503);
        const sub = await s.pool.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [u.id]);
        assert.equal(sub.rows.length, 0);
    });

    it('/billing/success üretimde hiçbir koşulda aktive etmez', async () => {
        const u = await s.createUserWithToken();
        const r = await noRedirect(`${s.baseUrl}/billing/success?provider=stripe&plan=enterprise&period=yearly`, { Authorization: `Bearer ${u.token}` });
        assert.match(r.location, /billing=processing/);
        const sub = await s.pool.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [u.id]);
        assert.equal(sub.rows.length, 0);
    });

    it('banka havalesi (mock olmayan) üretimde çalışır', async () => {
        const u = await s.createUserWithToken();
        const plan = (await s.pool.query('SELECT slug FROM subscription_plans WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].slug;
        const r = await s.api('POST', '/api/billing/checkout', { token: u.token, body: { plan_slug: plan, provider: 'bank_transfer', period: 'monthly' } });
        assert.equal(r.status, 200, r.text);
    });
});
