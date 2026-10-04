'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');

describe('e-posta doğrulaması zorunlu', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, brandId;
    before(async () => {
        s = await startServer();
        brandId = (await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('B','b-ev',true) RETURNING id`)).rows[0].id;
    });
    after(async () => { if (s) await s.stop(); });

    it('kayıt oturum/çerez/token vermez; doğrulanana kadar giriş 403, sonra 200 ve link tek kullanımlık', async () => {
        const inv = await s.createInvite({ brandId });
        const email = `v_${crypto.randomBytes(4).toString('hex')}@test.local`;
        const r = await s.api('POST', '/api/auth/signup', {
            headers: { 'X-Web-Session': '1' },
            body: { email, password: TEST_PASSWORD, full_name: 'A B', company_name: 'C', job_title: 'J', invite_code: inv.code, brand_id: brandId }
        });
        assert.equal(r.status, 201, r.text);
        assert.equal(r.json.email_verify_required, true);
        assert.ok(r.json.message);
        assert.equal(r.json.token, undefined);
        assert.equal(r.json.user, undefined);
        assert.equal(r.headers.get('set-cookie'), null);

        const row = (await s.pool.query('SELECT email_verified, email_verify_token, email_verify_expires FROM users WHERE email = $1', [email])).rows[0];
        assert.equal(row.email_verified, false);
        assert.equal(row.email_verify_token, r.json.verify_token_dev);
        const hrs = (new Date(row.email_verify_expires) - Date.now()) / 3600000;
        assert.ok(hrs > 23 && hrs <= 24.01, 'token ~24 saat geçerli: ' + hrs);

        const bad = await s.api('POST', '/api/auth/login', { body: { email, password: 'Yanlis-Parola-9!' } });
        assert.equal(bad.status, 401); // yanlış şifrede genel 401: numaralandırma yok
        const blocked = await s.api('POST', '/api/auth/login', { body: { email, password: TEST_PASSWORD } });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.code, 'EMAIL_NOT_VERIFIED');
        assert.match(blocked.json.error, /doğrulayın/);
        assert.equal(blocked.json.token, undefined);

        const v = await fetch(`${s.baseUrl}/api/auth/verify-email?token=${row.email_verify_token}`, { redirect: 'manual' });
        assert.equal(v.status, 302);
        assert.equal(v.headers.get('location'), '/login.html?verified=1');
        const v2 = await fetch(`${s.baseUrl}/api/auth/verify-email?token=${row.email_verify_token}`, { redirect: 'manual' });
        assert.equal(v2.headers.get('location'), '/login.html?verified=0'); // tek kullanımlık

        const ok = await s.api('POST', '/api/auth/login', { body: { email, password: TEST_PASSWORD } });
        assert.equal(ok.status, 200, ok.text);
        assert.ok(ok.json.token);
    });

    it('süresi dolmuş doğrulama bağlantısı reddedilir', async () => {
        const u = await s.createUser({ verified: false });
        await s.pool.query(`UPDATE users SET email_verify_token = $1, email_verify_expires = NOW() - INTERVAL '1 minute' WHERE id = $2`, ['a'.repeat(48), u.id]);
        const v = await fetch(`${s.baseUrl}/api/auth/verify-email?token=${'a'.repeat(48)}`, { redirect: 'manual' });
        assert.equal(v.headers.get('location'), '/login.html?verified=0');
        assert.equal((await s.pool.query('SELECT email_verified FROM users WHERE id = $1', [u.id])).rows[0].email_verified, false);
    });

    it('doğrulanmamış kullanıcı yanlış şifreyle 401 alır (403 sızıntısı yok); süper kullanıcı e-postası muaf', async () => {
        const u = await s.createUser({ verified: false });
        const r = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Yanlis-Parola-9!' } });
        assert.equal(r.status, 401);
        const sup = await s.createUser({ email: 'super@test.local', verified: false });
        const ok = await s.api('POST', '/api/auth/login', { body: { email: sup.email, password: sup.password } });
        assert.equal(ok.status, 200, ok.text);
    });

    it('resend-verification: her zaman aynı genel yanıt; yalnızca doğrulanmamış hesaba yeni token', async () => {
        const unv = await s.createUser({ verified: false });
        await s.pool.query(`UPDATE users SET email_verify_token = $1, email_verify_expires = NOW() + INTERVAL '1 hour' WHERE id = $2`, ['b'.repeat(48), unv.id]);
        const ver = await s.createUser({ verified: true });
        const call = email => s.api('POST', '/api/auth/resend-verification', { body: { email } });
        const a = await call(unv.email);
        const b = await call(ver.email);
        const c = await call('yok_' + crypto.randomBytes(3).toString('hex') + '@test.local');
        for (const r of [a, b, c]) assert.equal(r.status, 200);
        assert.deepEqual(a.json, b.json);
        assert.deepEqual(a.json, c.json);
        const row = (await s.pool.query('SELECT email_verify_token, email_verify_expires FROM users WHERE id = $1', [unv.id])).rows[0];
        assert.notEqual(row.email_verify_token, 'b'.repeat(48));
        assert.ok(new Date(row.email_verify_expires) - Date.now() > 23 * 3600000);
        assert.equal((await s.pool.query('SELECT email_verify_token FROM users WHERE id = $1', [ver.id])).rows[0].email_verify_token, null);
    });

    it('resend-verification saatte 5 ile sınırlı', async () => {
        const hdr = { 'X-Forwarded-For': '10.99.0.9' };
        const codes = [];
        for (let i = 0; i < 6; i++) codes.push((await s.api('POST', '/api/auth/resend-verification', { headers: hdr, body: { email: 'x@test.local' } })).status);
        assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    });
});
