'use strict';
// İki adımlı doğrulama (TOTP): birim + HTTP akışı. HTTP kısmı DB ister (TEST_DATABASE_URL/DATABASE_URL), yoksa atlanır.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/lib/totp');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('totp birim', () => {
    it('RFC 6238 test vektörü ve ±1 adım toleransı', () => {
        const s = totp.base32Encode(Buffer.from('12345678901234567890'));
        assert.equal(totp.verifyTotp(s, '287082', 59000), 1);
        assert.equal(totp.verifyTotp(s, '287082', 89000), 1); // bir sonraki adımda hâlâ kabul (tolerans)
        assert.equal(totp.verifyTotp(s, '287082', 200000), null);
        assert.equal(totp.verifyTotp(s, 'abcdef', 59000), null);
    });
    it('secret şifreleme gidiş-dönüş ve kurcalama tespiti', () => {
        const e = totp.encryptSecret('JBSWY3DPEHPK3PXP');
        assert.equal(totp.decryptSecret(e), 'JBSWY3DPEHPK3PXP');
        assert.throws(() => totp.decryptSecret(e.slice(0, -4) + 'AAAA'));
    });
    it('kurtarma kodu biçimi/hash eşleşmesi', () => {
        const { codes, hashes } = totp.generateRecoveryCodes(3);
        assert.equal(codes.length, 3);
        assert.match(codes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
        assert.equal(totp.hashRecovery(codes[0].toUpperCase()), hashes[0]);
    });
});

describe('2FA HTTP akışı', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, ip = 0;
    before(async () => { s = await startServer({ env: { REQUIRE_ADMIN_2FA: '1' } }); });
    after(async () => { if (s) await s.stop(); });
    const H = () => ({ 'X-Forwarded-For': `10.77.0.${++ip}` });
    const post = (path, body, token) => s.api('POST', path, { body, token, headers: H() });
    const login = u => post('/api/auth/login', { email: u.email, password: u.password });
    const codeFor = (secret, offsetSteps = 0) => totp.hotp(secret, totp.currentStep() + offsetSteps);

    async function enroll(u) {
        const l = await login(u);
        const token = l.json.token;
        const setup = await post('/api/auth/2fa/setup', {}, token);
        assert.equal(setup.status, 200, setup.text);
        const en = await post('/api/auth/2fa/enable', { code: codeFor(setup.json.secret) }, token);
        assert.equal(en.status, 200, en.text);
        return { secret: setup.json.secret, recovery: en.json.recovery_codes, token };
    }

    it('isteğe bağlı kurulum: yanlış kod reddedilir, doğru kod etkinleştirir, secret veritabanında şifreli', async () => {
        const u = await s.createUser();
        const l = await login(u);
        assert.ok(l.json.token);
        const setup = await post('/api/auth/2fa/setup', {}, l.json.token);
        assert.match(setup.json.otpauth_uri, /^otpauth:\/\/totp\//);
        const bad = await post('/api/auth/2fa/enable', { code: '000000' }, l.json.token);
        assert.equal(bad.status, 400);
        const ok = await post('/api/auth/2fa/enable', { code: codeFor(setup.json.secret) }, l.json.token);
        assert.equal(ok.status, 200);
        assert.equal(ok.json.recovery_codes.length, 10);
        const row = (await s.pool.query('SELECT totp_secret_enc, totp_recovery_hashes FROM users WHERE id = $1', [u.id])).rows[0];
        assert.ok(!row.totp_secret_enc.includes(setup.json.secret));
        assert.ok(!JSON.stringify(row.totp_recovery_hashes).includes(ok.json.recovery_codes[0]));
    });

    it('etkin kullanıcı girişte oturum değil mfa_token alır; kod doğrulanınca oturum verilir; aynı kod tekrar kullanılamaz', async () => {
        const u = await s.createUser();
        const { secret } = await enroll(u);
        const l = await login(u);
        assert.equal(l.json.mfa_required, true);
        assert.equal(l.json.token, undefined);
        assert.equal(l.headers.get('set-cookie'), null);
        // mfa_token oturum token'ı olarak kullanılamaz
        const misuse = await s.api('GET', '/api/auth/2fa/status', { token: l.json.mfa_token });
        assert.equal(misuse.status, 401);
        const wrong = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: '123456' });
        assert.equal(wrong.status, 401);
        // enroll sırasında kullanılan adım tüketildi: aynı adımdaki kod reddedilir, sonraki adımın kodu kabul edilir
        const replay = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: codeFor(secret) });
        assert.equal(replay.status, 401);
        const ok = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: codeFor(secret, 1) });
        assert.equal(ok.status, 200, ok.text);
        assert.ok(ok.json.token);
        const again = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: codeFor(secret, 1) });
        assert.equal(again.status, 401);
    });

    it('kurtarma kodu bir kez çalışır', async () => {
        const u = await s.createUser();
        const { recovery } = await enroll(u);
        const l1 = await login(u);
        const ok = await post('/api/auth/2fa/verify', { mfa_token: l1.json.mfa_token, code: recovery[0] });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.json.recovery_codes_remaining, 9);
        const l2 = await login(u);
        const reuse = await post('/api/auth/2fa/verify', { mfa_token: l2.json.mfa_token, code: recovery[0] });
        assert.equal(reuse.status, 401);
    });

    it('5 hatalı kodda hesap kilitlenir', async () => {
        const u = await s.createUser();
        const { secret } = await enroll(u);
        const l = await login(u);
        for (let i = 0; i < 5; i++) await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: '000001' });
        const blocked = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: codeFor(secret, 1) });
        assert.equal(blocked.status, 401);
        const pw = await login(u);
        assert.equal(pw.status, 401); // şifreli giriş de kilitli
    });

    it('kapatma şifre + kod ister; yanlış kodda kapanmaz', async () => {
        const u = await s.createUser();
        const { secret } = await enroll(u);
        const l = await login(u);
        const v = await post('/api/auth/2fa/verify', { mfa_token: l.json.mfa_token, code: codeFor(secret, 1) });
        const bad = await post('/api/auth/2fa/disable', { password: u.password, code: '111111' }, v.json.token);
        assert.equal(bad.status, 401);
        await s.pool.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [u.id]); // gerçekte yeni 30 sn adımı beklenir
        const ok = await post('/api/auth/2fa/disable', { password: u.password, code: codeFor(secret, 0) }, v.json.token);
        assert.equal(ok.status, 200, ok.text);
        const l2 = await login(u);
        assert.ok(l2.json.token); // artık ek adım yok
    });

    it('yönetici: kurulum zorunlu, kurulum token\'ıyla tamamlanır, oturum yalnızca sonra verilir; kapatılamaz', async () => {
        const a = await s.createUser({ role: 'admin' });
        const l = await login(a);
        assert.equal(l.json.mfa_setup_required, true);
        assert.equal(l.json.token, undefined);
        const setup = await post('/api/auth/2fa/setup', { mfa_token: l.json.mfa_token });
        assert.equal(setup.status, 200, setup.text);
        const en = await post('/api/auth/2fa/enable', { mfa_token: l.json.mfa_token, code: codeFor(setup.json.secret) });
        assert.equal(en.status, 200, en.text);
        assert.ok(en.json.token && en.json.user);
        // 'verify' amaçlı token ile kurulum yapılamaz
        const l2 = await login(a);
        assert.equal(l2.json.mfa_required, true);
        const wrongPurpose = await post('/api/auth/2fa/setup', { mfa_token: l2.json.mfa_token });
        assert.equal(wrongPurpose.status, 401);
        const dis = await post('/api/auth/2fa/disable', { password: a.password, code: codeFor(setup.json.secret, 1) }, en.json.token);
        assert.equal(dis.status, 403);
        const st = await s.api('GET', '/api/auth/2fa/status', { token: en.json.token });
        assert.deepEqual([st.json.enabled, st.json.required], [true, true]);
    });

    it('süper kullanıcı başkasının 2FA\'sını sıfırlar; sıradan yönetici ve kendi hesabı yapamaz', async () => {
        const target = await s.createUser();
        await enroll(target);
        const sup = await s.createUser({ email: 'super@test.local', role: 'admin' });
        await s.pool.query('UPDATE users SET totp_enabled = true WHERE id = $1', [sup.id]); // kapıyı geçmek için etkin say
        const ls = await login(sup);
        // süper kullanıcı için token almak: etkin ama secret yok → doğrudan oturum token'ı üretmek yerine kurulumla ilerle
        await s.pool.query('UPDATE users SET totp_enabled = false WHERE id = $1', [sup.id]);
        const sl = await login(sup);
        const setup = await post('/api/auth/2fa/setup', { mfa_token: sl.json.mfa_token });
        const en = await post('/api/auth/2fa/enable', { mfa_token: sl.json.mfa_token, code: codeFor(setup.json.secret) });
        void ls;
        const r = await post(`/api/admin/users/${target.id}/2fa-reset`, {}, en.json.token);
        assert.equal(r.status, 200, r.text);
        const after = await login(target);
        assert.ok(after.json.token);
        const self = await post(`/api/admin/users/${sup.id}/2fa-reset`, {}, en.json.token);
        assert.equal(self.status, 400);
        const plainAdmin = await s.createUser({ role: 'admin' });
        const pa = await login(plainAdmin);
        const pset = await post('/api/auth/2fa/setup', { mfa_token: pa.json.mfa_token });
        const pen = await post('/api/auth/2fa/enable', { mfa_token: pa.json.mfa_token, code: codeFor(pset.json.secret) });
        const denied = await post(`/api/admin/users/${target.id}/2fa-reset`, {}, pen.json.token);
        assert.equal(denied.status, 403);
    });
});
