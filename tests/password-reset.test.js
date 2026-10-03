'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');

const NEW_PASSWORD = 'Yeni-Sifre-456!';
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('password reset', { skip: SKIP_DB && SKIP_REASON }, () => {
    let srv, tmp, outbox;
    let ipN = 0;
    const ipHeader = () => ({ 'X-Forwarded-For': `10.77.0.${++ipN}` });

    function mails() {
        if (!fs.existsSync(outbox)) return [];
        return fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    }
    function mailsTo(email) { return mails().filter(m => m.to === email); }
    function tokenFrom(mail) {
        const m = /reset-password\.html\?token=([0-9a-f]{64})/.exec(mail.text);
        assert.ok(m, 'mailde token bulunamadı');
        return m[1];
    }
    async function requestReset(email, headers) {
        return srv.api('POST', '/api/auth/forgot-password', { body: { email }, headers: headers || ipHeader() });
    }
    async function freshToken(email) {
        const before = mailsTo(email).length;
        const r = await requestReset(email);
        assert.equal(r.status, 200);
        const list = mailsTo(email);
        for (let i = 0; i < 20 && list.length <= before; i++) { await sleep(50); list.splice(0, list.length, ...mailsTo(email)); }
        assert.equal(list.length, before + 1);
        return tokenFrom(list[list.length - 1]);
    }
    const reset = (token, password, headers) => srv.api('POST', '/api/auth/reset-password', { body: { token, password }, headers: headers || ipHeader() });
    const login = (email, password) => srv.api('POST', '/api/auth/login', { body: { email, password }, headers: ipHeader() });

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
        outbox = path.join(tmp, 'outbox.jsonl');
        srv = await startServer({ env: { MAIL_OUTBOX_FILE: outbox } });
    });
    after(async () => {
        if (srv) await srv.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('unknown and known email get identical 200 body', async () => {
        const u = await srv.createUser();
        const a = await requestReset('nobody-' + crypto.randomBytes(4).toString('hex') + '@test.local');
        const b = await requestReset(u.email);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(a.text, b.text);
        await sleep(200);
        assert.equal(mailsTo(u.email).length, 1);
        // pasif kullanıcı da aynı yanıt, mail yok
        const inactive = await srv.createUser({ active: false });
        const c = await requestReset(inactive.email);
        assert.equal(c.text, a.text);
        await sleep(200);
        assert.equal(mailsTo(inactive.email).length, 0);
    });

    it('token is stored hashed only', async () => {
        const u = await srv.createUser();
        const token = await freshToken(u.email);
        const rows = (await srv.pool.query('SELECT * FROM password_reset_tokens WHERE user_id=$1', [u.id])).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
        assert.ok(!JSON.stringify(rows[0]).includes(token));
        const ttl = new Date(rows[0].expires_at) - Date.now();
        assert.ok(ttl > 28 * 60000 && ttl <= 30 * 60000 + 5000);
    });

    it('validate endpoint', async () => {
        const u = await srv.createUser();
        const token = await freshToken(u.email);
        const ok = await srv.api('GET', `/api/auth/reset-password/validate?token=${token}`, { headers: ipHeader() });
        assert.deepEqual(ok.json, { valid: true });
        const bad = await srv.api('GET', `/api/auth/reset-password/validate?token=${'0'.repeat(64)}`, { headers: ipHeader() });
        assert.deepEqual(bad.json, { valid: false });
    });

    it('token resets password; single use; old password rejected; JWT issued before reset is rejected', async () => {
        const u = await srv.createUserWithToken();
        const oldJwt = u.token;
        assert.equal((await srv.api('GET', '/api/auth/me', { token: oldJwt })).status, 200);
        const token = await freshToken(u.email);
        await sleep(1100); // JWT iat saniye çözünürlüklü
        const r = await reset(token, NEW_PASSWORD);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { ok: true });

        const second = await reset(token, 'Baska-Sifre-789!');
        assert.equal(second.status, 400);

        assert.equal((await login(u.email, TEST_PASSWORD)).status, 401);
        const nl = await login(u.email, NEW_PASSWORD);
        assert.equal(nl.status, 200);

        assert.equal((await srv.api('GET', '/api/auth/me', { token: oldJwt })).status, 401);
        assert.equal((await srv.api('GET', '/api/auth/me', { token: nl.json.token })).status, 200);
    });

    it('expired and invalid tokens -> 400', async () => {
        const u = await srv.createUser();
        const token = await freshToken(u.email);
        await srv.pool.query(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id=$1`, [u.id]);
        const v = await srv.api('GET', `/api/auth/reset-password/validate?token=${token}`, { headers: ipHeader() });
        assert.deepEqual(v.json, { valid: false });
        assert.equal((await reset(token, NEW_PASSWORD)).status, 400);
        assert.equal((await reset(crypto.randomBytes(32).toString('hex'), NEW_PASSWORD)).status, 400);
        assert.equal((await reset('garbage', NEW_PASSWORD)).status, 400);
        assert.equal((await reset(undefined, NEW_PASSWORD)).status, 400);
    });

    it('weak password -> 400 and token is not consumed', async () => {
        const u = await srv.createUser();
        const token = await freshToken(u.email);
        const w = await reset(token, 'zayif');
        assert.equal(w.status, 400);
        assert.match(w.json.error, /Şifre en az 10 karakter/);
        const row = (await srv.pool.query('SELECT used_at FROM password_reset_tokens WHERE user_id=$1', [u.id])).rows[0];
        assert.equal(row.used_at, null);
        assert.equal((await reset(token, NEW_PASSWORD)).status, 200);
    });

    it('reset clears lockout and works for password-less (Google) accounts', async () => {
        const u = await srv.createUser();
        await srv.pool.query(`UPDATE users SET failed_login_count=5, locked_until=NOW()+INTERVAL '15 minutes' WHERE id=$1`, [u.id]);
        assert.equal((await login(u.email, TEST_PASSWORD)).status, 423);
        const token = await freshToken(u.email);
        assert.equal((await reset(token, NEW_PASSWORD)).status, 200);
        const row = (await srv.pool.query('SELECT failed_login_count, locked_until, password_changed_at FROM users WHERE id=$1', [u.id])).rows[0];
        assert.equal(row.failed_login_count, 0);
        assert.equal(row.locked_until, null);
        assert.ok(row.password_changed_at);
        assert.equal((await login(u.email, NEW_PASSWORD)).status, 200);

        const g = await srv.createUser();
        await srv.pool.query(`UPDATE users SET password_hash = '' WHERE id=$1`, [g.id]);
        const t2 = await freshToken(g.email);
        assert.equal((await reset(t2, NEW_PASSWORD)).status, 200);
        assert.equal((await login(g.email, NEW_PASSWORD)).status, 200);
    });

    it('new request invalidates previous unused tokens; completing a reset invalidates the rest', async () => {
        const u = await srv.createUser();
        const t1 = await freshToken(u.email);
        const t2 = await freshToken(u.email);
        assert.equal((await reset(t1, NEW_PASSWORD)).status, 400);
        assert.equal((await reset(t2, NEW_PASSWORD)).status, 200);
        const open = await srv.pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL', [u.id]);
        assert.equal(open.rows.length, 0);
    });

    it('per-email throttle: 4th request within an hour sends no 4th email but still 200', async () => {
        const u = await srv.createUser();
        let last;
        for (let i = 0; i < 4; i++) { last = await requestReset(u.email); assert.equal(last.status, 200); await sleep(100); }
        await sleep(300);
        assert.equal(mailsTo(u.email).length, 3);
        const unknown = await requestReset('x-' + crypto.randomBytes(4).toString('hex') + '@test.local');
        assert.equal(unknown.text, last.text);
    });

    it('forgot-password IP rate limiter returns 429 after 5 requests/hour', async () => {
        const h = { 'X-Forwarded-For': '10.99.99.99' };
        let status;
        for (let i = 0; i < 6; i++) status = (await requestReset('rl@test.local', h)).status;
        assert.equal(status, 429);
    });

    it('audit log records request and completion', async () => {
        const u = await srv.createUser();
        const t = await freshToken(u.email);
        await reset(t, NEW_PASSWORD);
        const ev = (await srv.pool.query('SELECT event FROM auth_audit WHERE user_id=$1', [u.id])).rows.map(r => r.event);
        assert.ok(ev.includes('password_reset_requested'));
        assert.ok(ev.includes('password_reset_completed'));
    });
});

describe('signup verification mail', { skip: SKIP_DB && SKIP_REASON }, () => {
    it('signup sends verification link and still succeeds without SMTP', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
        const outbox = path.join(tmp, 'o.jsonl');
        const srv = await startServer({ env: { MAIL_OUTBOX_FILE: outbox } });
        try {
            const brand = (await srv.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('B','b-${Date.now()}',true) RETURNING id`)).rows[0];
            const email = `s_${crypto.randomBytes(4).toString('hex')}@test.local`;
            const r = await srv.api('POST', '/api/auth/signup', {
                headers: { 'X-Forwarded-For': '10.88.0.1' },
                body: { email, password: TEST_PASSWORD, full_name: 'A B', brand_id: brand.id, company_name: 'C', job_title: 'J' }
            });
            assert.equal(r.status, 201, r.text);
            await sleep(300);
            const m = JSON.parse(fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean)[0]);
            assert.equal(m.to, email);
            assert.ok(m.text.includes(`/api/auth/verify-email?token=${r.json.verify_token_dev}`));
        } finally { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
    });
});
