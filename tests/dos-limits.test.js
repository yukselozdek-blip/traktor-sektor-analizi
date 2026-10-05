'use strict';
// DoS / girdi sınırı regresyon testleri: gövde limiti, AI analiz doğrulaması,
// sales-query soru sınırı ve giriş numaralandırma/zamanlama korumaları.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('DoS / girdi sınırları (HTTP)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin;
    before(async () => {
        s = await startServer({ env: { MINIMAX_API_KEY: 'test-key', WHATSAPP_QUERY_API_KEY: 'q-token' } });
        admin = await s.createUserWithToken({ role: 'admin' }); // 1 login
    });
    after(async () => { if (s) await s.stop(); });

    it('JSON gövde varsayılanı 1mb: 2mb gövde 413, ingest yolu 10mb ayrıştırıcıyla 413 değil', async () => {
        const big = { pad: 'x'.repeat(2 * 1024 * 1024) };
        const r = await s.api('POST', '/api/ai/analyze', { token: admin.token, body: big });
        assert.equal(r.status, 413);
        const ing = await s.api('POST', '/api/media-watch/ingest', { body: big });
        assert.notEqual(ing.status, 413); // yetkisiz (401/503) ama gövde ayrıştırıldı
        const small = await s.api('POST', '/api/media-watch/ingest', { body: { a: 1 } });
        assert.equal(small.status, ing.status);
    });

    it('/api/ai/analyze: geçersiz tip/boyutta 400 (500 değil)', async () => {
        const post = (body) => s.api('POST', '/api/ai/analyze', { token: admin.token, body });
        assert.equal((await post({ type: 123, context: {} })).status, 400);
        assert.equal((await post({ type: 'brand-region', context: 'str' })).status, 400);
        assert.equal((await post({ type: 'brand-region', context: [1] })).status, 400);
        assert.equal((await post({ type: 'brand-region', context: { pad: 'x'.repeat(20001) } })).status, 400);
        assert.equal((await post({ type: 'model-region', context: { regionLadder: 'abc' } })).status, 400);
        assert.equal((await post({ type: 'model-region', context: { regionLadder: [null] } })).status, 400);
        assert.equal((await post({ type: 'brand-compare', context: {} })).status, 400);
        assert.equal((await post({ type: 'brand-region' })).status, 400);
        assert.equal((await post({ type: 'regional-index', context: { provinces: 5 } })).status, 400);
        assert.equal((await post({ type: 'model-region', question: 'x'.repeat(2001), context: {} })).status, 400);
        assert.equal((await post({ type: 'model-region', question: { a: 1 }, context: {} })).status, 400);
        assert.equal((await post({ type: 'bilinmeyen', context: {} })).status, 400);
    });

    it('sales-query: question tip ve uzunluk kontrolü', async () => {
        const h = { 'x-query-token': 'q-token' };
        const post = (body) => s.api('POST', '/api/public/assistant/sales-query', { headers: h, body });
        assert.equal((await post({ question: 123 })).status, 400);
        assert.equal((await post({ question: { a: 1 } })).status, 400);
        assert.equal((await post({ question: ['x'] })).status, 400);
        assert.equal((await post({ question: '   ' })).status, 400);
        const long = await post({ question: 'a'.repeat(1001) });
        assert.equal(long.status, 400);
        assert.match(long.json.error, /1000/);
        assert.equal((await s.api('POST', '/api/public/assistant/sales-query', { body: { question: 'x' } })).status, 401);
    });

    it('login: bilinmeyen e-posta ve kilitli hesap aynı genel 401 gövdesini verir', async () => {
        const u = await s.createUser();
        await s.pool.query(`UPDATE users SET failed_login_count=5, locked_until=NOW()+INTERVAL '15 minutes' WHERE id=$1`, [u.id]);
        const locked = await s.api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
        const unknown = await s.api('POST', '/api/auth/login', { body: { email: 'yok_' + u.email, password: 'x' } });
        assert.equal(locked.status, 401);
        assert.equal(unknown.status, 401);
        assert.deepEqual(locked.json, unknown.json);
        assert.match(locked.json.error, /^Geçersiz kimlik bilgileri/);
    });
});

describe('login zamanlama eşitleme (statik)', () => {
    it('bilinmeyen e-posta dalı sahte hash ile bcrypt.compare çalıştırır', () => {
        const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
        assert.match(src, /DUMMY_PASSWORD_HASH = '\$2[aby]\$12\$/);
        const login = src.slice(src.indexOf("app.post('/api/auth/login'"), src.indexOf("app.post('/api/auth/preview-plan'"));
        assert.match(login, /bcrypt\.compare\(password, DUMMY_PASSWORD_HASH\)/);
        assert.doesNotMatch(login, /423/);
    });
});

describe('kayıt: IP\'den bağımsız genel sınır (X-Forwarded-For sahteciliğine karşı)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer({ env: { SIGNUP_GLOBAL_MAX: '4' } }); });
    after(async () => { if (s) await s.stop(); });
    it('her istekte farklı sahte IP gönderilse bile genel sınır 429 verir', async () => {
        const codes = [];
        for (let i = 0; i < 7; i++) {
            const r = await s.api('POST', '/api/auth/signup', {
                headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` },
                body: { email: `x${i}@test.local`, password: 'x', full_name: 'A', company_name: 'F', job_title: 'M' }
            });
            codes.push(r.status);
        }
        assert.ok(codes.slice(0, 4).every(c => c !== 429), 'ilk 4 istek sınıra takılmamalı: ' + codes);
        assert.ok(codes.slice(4).every(c => c === 429), 'sonrakiler 429 olmalı: ' + codes);
    });
});
