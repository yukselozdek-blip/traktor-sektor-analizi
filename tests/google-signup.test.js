'use strict';
// Google ile kayıt/giriş: davet kodu zorunluluğu, marka koddan gelir, kod tüketimi, mevcut kullanıcı girişi.
// Google tokeninfo uç noktası sahte bir yerel sunucuyla değiştirilir (GOOGLE_TOKENINFO_URL, yalnızca üretim dışı).
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const GENERIC = 'Davet kodu geçersiz, süresi dolmuş veya kullanılmış';
let ipSeq = 0;
const nextIp = () => `10.88.0.${++ipSeq}`;

describe('Google ile kayıt (davet kodu akışı)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, fake, brandA, brandB, planSlug;
    // id_token = base64url(JSON profil); sahte sunucu bunu tokeninfo biçiminde geri verir
    const tokenFor = (email, over = {}) => Buffer.from(JSON.stringify({
        email, email_verified: 'true', aud: CLIENT_ID, sub: 'g_' + crypto.randomBytes(6).toString('hex'), name: 'Google Kullanıcı', ...over
    })).toString('base64url');
    const google = (email, body = {}, over = {}) => s.api('POST', '/api/auth/google', {
        headers: { 'X-Forwarded-For': nextIp() },
        body: { id_token: tokenFor(email, over), ...body }
    });
    const newEmail = () => `g_${crypto.randomBytes(5).toString('hex')}@test.local`;

    before(async () => {
        fake = http.createServer((req, res) => {
            try {
                const tok = new URL(req.url, 'http://x').searchParams.get('id_token') || '';
                const data = JSON.parse(Buffer.from(tok, 'base64url').toString());
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
            } catch (_) { res.statusCode = 400; res.end('{}'); }
        });
        await new Promise(r => fake.listen(0, '127.0.0.1', r));
        s = await startServer({ env: { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${fake.address().port}/tokeninfo` } });
        brandA = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('G Marka A','g-marka-a',true) RETURNING id`)).rows[0].id;
        brandB = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('G Marka B','g-marka-b',true) RETURNING id`)).rows[0].id;
        planSlug = (await s.pool.query(
            `INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, plan_limits, feature_keys)
             VALUES ('gp','gp-plan',1,1,'{}'::jsonb,'[]'::jsonb) RETURNING slug`)).rows[0].slug;
    });
    after(async () => { if (s) await s.stop(); if (fake) fake.close(); });

    it('geçersiz client ID (aud) reddedilir', async () => {
        const r = await google(newEmail(), {}, { aud: 'baska-istemci' });
        assert.equal(r.status, 401);
    });

    it('yeni kullanıcı davet kodu/profil vermezse 202 GOOGLE_NEEDS_PROFILE; kullanıcı oluşmaz', async () => {
        const email = newEmail();
        const r = await google(email, {});
        assert.equal(r.status, 202);
        assert.equal(r.json.code, 'GOOGLE_NEEDS_PROFILE');
        const n = (await s.pool.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [email])).rows[0].n;
        assert.equal(n, 0);
    });

    it('geçersiz davet kodu: genel hata, kullanıcı oluşmaz', async () => {
        const email = newEmail();
        const r = await google(email, { invite_code: 'TSA-AAAA-BBBB-CCCC', company_name: 'Firma', job_title: 'Müdür' });
        assert.equal(r.status, 400);
        assert.equal(r.json.error, GENERIC);
        assert.equal((await s.pool.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [email])).rows[0].n, 0);
    });

    it('geçerli kod: marka koddan gelir, uyuşmayan marka genel hata verir ve kodu harcamaz, kod bir kez kullanılır', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        // marka uyuşmazlığı: genel hata ve kod HARCANMAZ
        const mism = await google(newEmail(), { invite_code: inv.code, brand_id: brandB, company_name: 'Firma', job_title: 'Müdür' });
        assert.equal(mism.status, 400);
        assert.equal(mism.json.error, GENERIC);
        assert.equal((await s.pool.query('SELECT used_count FROM invite_codes WHERE id = $1', [inv.id])).rows[0].used_count, 0);

        const email = newEmail();
        const ok = await google(email, { invite_code: inv.code, plan_slug: planSlug, company_name: 'Firma', job_title: 'Müdür' });
        assert.equal(ok.status, 201, ok.text);
        assert.equal(ok.json.is_new, true);
        assert.ok(ok.json.token);
        const u = (await s.pool.query('SELECT brand_id, role, email_verified, auth_provider FROM users WHERE email = $1', [email])).rows[0];
        assert.equal(u.brand_id, brandA);
        assert.equal(u.role, 'brand_user');
        assert.equal(u.email_verified, true);
        assert.equal(u.auth_provider, 'google');
        assert.equal((await s.pool.query('SELECT used_count FROM invite_codes WHERE id = $1', [inv.id])).rows[0].used_count, 1);

        const again = await google(newEmail(), { invite_code: inv.code, company_name: 'Firma', job_title: 'Müdür' });
        assert.equal(again.status, 400);
        assert.equal(again.json.error, GENERIC);
    });

    it('mevcut kullanıcı kodsuz Google ile giriş yapar (is_new=false)', async () => {
        const inv = await s.createInvite({ brandId: brandA });
        const email = newEmail();
        const first = await google(email, { invite_code: inv.code, company_name: 'Firma', job_title: 'Müdür' });
        assert.equal(first.status, 201, first.text);
        const second = await google(email, {}, { sub: first.json.user?.google_id });
        assert.equal(second.status, 200, second.text);
        assert.equal(second.json.is_new, false);
        assert.ok(second.json.token);
    });
});
