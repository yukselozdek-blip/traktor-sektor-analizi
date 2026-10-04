'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON, TEST_PASSWORD } = require('./helpers');

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const cookieOf = res => {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const line = sc.find(c => c.startsWith('tk_session='));
    return { line, value: line ? line.split(';')[0] : null };
};

describe('httpOnly oturum çerezi + CSRF', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, user;
    before(async () => { s = await startServer(); user = await s.createUser({ role: 'brand_user' }); });
    after(async () => { if (s) await s.stop(); });
    const login = (headers = {}) => s.api('POST', '/api/auth/login', { body: { email: user.email, password: TEST_PASSWORD }, headers });

    it('giriş: çerez httpOnly + SameSite=Lax; API istemcisi token\'ı gövdede almaya devam eder', async () => {
        const r = await login();
        assert.equal(r.status, 200);
        assert.ok(r.json.token, 'API istemcisi için token gövdede kalmalı');
        const c = cookieOf(r);
        assert.match(c.line, /HttpOnly/);
        assert.match(c.line, /SameSite=Lax/);
        assert.match(c.line, /Path=\//);
        assert.match(c.line, /Max-Age=604800/);
    });

    it('web istemcisi (X-Web-Session) token\'ı gövdede görmez, yalnızca çerez alır', async () => {
        const r = await login({ 'X-Web-Session': '1', ...XHR });
        assert.equal(r.status, 200);
        assert.equal(r.json.token, undefined);
        assert.equal(r.json.session, true);
        assert.ok(cookieOf(r).value);
    });

    it('başarısız giriş çerez vermez', async () => {
        const r = await s.api('POST', '/api/auth/login', { body: { email: user.email, password: 'yanlis-Parola-1' }, headers: { 'X-Web-Session': '1' } });
        assert.ok(r.status >= 400);
        assert.equal(cookieOf(r).value, null);
    });

    it('çerezle GET çalışır; çerezsiz 401', async () => {
        const ck = cookieOf(await login({ 'X-Web-Session': '1', ...XHR })).value;
        assert.equal((await s.api('GET', '/api/auth/me', { headers: { Cookie: ck } })).status, 200);
        assert.equal((await s.api('GET', '/api/auth/me')).status, 401);
    });

    it('CSRF: çerezle değiştirici istek X-Requested-With olmadan 403, ile birlikte geçer', async () => {
        const ck = cookieOf(await login({ 'X-Web-Session': '1', ...XHR })).value;
        const noHeader = await s.api('POST', '/api/auth/preview-plan', { headers: { Cookie: ck }, body: { plan_slug: 'x' } });
        assert.equal(noHeader.status, 403);
        const withHeader = await s.api('POST', '/api/auth/preview-plan', { headers: { Cookie: ck, ...XHR }, body: { plan_slug: 'x' } });
        assert.doesNotMatch(withHeader.text, /CSRF/, 'başlıkla CSRF engeline takılmamalı (rota kendi kuralıyla yanıt verebilir)');
        assert.match(noHeader.text, /CSRF/);
    });

    it('CSRF: yabancı Origin ile gelen çerezli değiştirici istek reddedilir', async () => {
        const ck = cookieOf(await login({ 'X-Web-Session': '1', ...XHR })).value;
        const r = await s.api('POST', '/api/auth/preview-plan', { headers: { Cookie: ck, ...XHR, Origin: 'https://evil.example' }, body: { plan_slug: 'x' } });
        assert.equal(r.status, 403);
        assert.match(r.text, /CSRF/);
    });

    it('Bearer ile gelen istekler CSRF başlığı gerektirmez (API istemcileri)', async () => {
        const r = await login();
        const p = await s.api('POST', '/api/auth/preview-plan', { token: r.json.token, body: { plan_slug: 'x' } });
        assert.doesNotMatch(p.text, /CSRF/);
        assert.notEqual(p.status, 401);
    });

    it('çıkış çerezi siler', async () => {
        const r = await s.api('POST', '/api/auth/logout', { headers: XHR });
        assert.equal(r.status, 200);
        const sc = r.headers.getSetCookie().find(c => c.startsWith('tk_session='));
        assert.match(sc, /Max-Age=0/);
    });

    it('bozuk/yabancı çerez 401 verir', async () => {
        const r = await s.api('GET', '/api/auth/me', { headers: { Cookie: 'tk_session=bozuk.jwt.deger' } });
        assert.equal(r.status, 401);
    });
});
