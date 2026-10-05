'use strict';
// Hata günlükleme: birim testler (DB gerekmez) + gerçek 500 senaryosu (DB gerekir, yoksa atlanır).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');
const L = require('../src/lib/log-error');

function capture(fn) {
    const lines = [];
    const old = L._setSink(l => lines.push(l));
    try { fn(lines); } finally { L._setSink(old); }
    return lines;
}

describe('log-error birim', () => {
    it('tek satır JSON: zaman, istek, kullanıcı, code, message, detail, stack(3 satır)', () => {
        const err = Object.assign(new Error('relation "x" does not exist'), { code: '42P01', detail: 'ayrıntı' });
        const lines = capture(() => L.logRouteError({ method: 'GET', originalUrl: '/api/a/b', user: { id: 7 } }, err, 'GET /api/a/b'));
        assert.equal(lines.length, 1);
        assert.ok(lines[0].startsWith('[route-error] '));
        assert.ok(!lines[0].includes('\n'));
        const rec = JSON.parse(lines[0].slice('[route-error] '.length));
        assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
        assert.equal(rec.req, 'GET /api/a/b');
        assert.equal(rec.user, '7');
        assert.equal(rec.code, '42P01');
        assert.equal(rec.label, 'GET /api/a/b');
        assert.equal(rec.detail, 'ayrıntı');
        assert.equal(rec.stack.length, 3);
    });

    it('query string asla loglanmaz', () => {
        const lines = capture(() => L.logRouteError({ method: 'GET', originalUrl: '/api/x?token=SUPERSECRET&email=a@b.com', user: { id: 1 } }, new Error('boom'), 'x'));
        assert.ok(!/SUPERSECRET|a@b\.com|token=/.test(lines[0]), lines[0]);
        assert.match(lines[0], /GET \/api\/x"/);
    });

    it('token benzeri uzun yol segmenti maskelenir', () => {
        const p = L.safePath({ originalUrl: '/api/reset/abcdef0123456789abcdef0123456789?x=1' });
        assert.equal(p, '/api/reset/:gizli');
    });

    it('bağlantı dizesi kimlik bilgisi maskelenir', () => {
        const lines = capture(() => L.logRouteError(null, new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/app'), 'x'));
        assert.ok(lines[0].includes('://***@db.internal'), lines[0]);
        assert.ok(!/hunter2|admin:/.test(lines[0]));
    });

    it('e-posta, JWT, Bearer ve parola/token alanları sızmaz', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.abcDEF123_-';
        const err = new Error(`Key (email)=(kisi@ornek.com) already exists; password=Gizli123 token: abc123 Authorization: Bearer ${jwt} ${jwt}`);
        err.detail = 'Key (email)=(baska@ornek.com)';
        const lines = capture(() => L.logRouteError({ method: 'POST', originalUrl: '/api/auth/login', user: { id: 1, email: 'x@y.com', password: 'p' } }, err, 'POST /api/auth/login'));
        for (const bad of ['kisi@ornek.com', 'baska@ornek.com', 'Gizli123', 'abc123', 'eyJhbGci', 'x@y.com']) {
            assert.ok(!lines[0].includes(bad), `${bad} sızdı: ${lines[0]}`);
        }
    });

    it('mesaj ilk 300 karakterle sınırlı; req null ve Error olmayan hata desteklenir', () => {
        const lines = capture(() => {
            L.logRouteError(null, new Error('a'.repeat(1000)), 'x');
            L.logRouteError(null, 'düz metin', 'y');
            L.logRouteError(null, undefined);
        });
        assert.equal(lines.length, 3);
        assert.equal(JSON.parse(lines[0].slice(14)).message.length, 300);
        assert.equal(JSON.parse(lines[0].slice(14)).req, '-');
        assert.equal(JSON.parse(lines[1].slice(14)).message, 'düz metin');
    });

    it('hız sınırı: pencerede en fazla 20 satır, sonra bastırıldı özeti', () => {
        let t = 1000;
        const summaries = [];
        const rl = L.createRateLimiter({ now: () => t, onSummary: (k, n) => summaries.push([k, n]) });
        let allowed = 0;
        for (let i = 0; i < 50; i++) if (rl.allow('k')) allowed++;
        assert.equal(allowed, 20);
        assert.equal(rl.allow('baska'), true); // anahtarlar bağımsız
        t += 61000;
        assert.equal(rl.allow('k'), true); // yeni pencere
        assert.deepEqual(summaries, [['k', 30]]);
    });

    it('logRouteError aynı etiket+kod için dakikada 20 satırla sınırlar', () => {
        const lines = capture(() => { for (let i = 0; i < 40; i++) L.logRouteError(null, Object.assign(new Error('e'), { code: 'RL1' }), 'rl-test'); });
        assert.equal(lines.length, 20);
    });

    it('globalErrorHandler: 4xx varsayılan işleyiciye (next), diğerleri JSON 500', () => {
        const mk = () => ({ headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
        let passed = null;
        const r1 = mk();
        capture(() => L.globalErrorHandler(Object.assign(new Error('x'), { type: 'entity.parse.failed', status: 400 }), { method: 'POST', originalUrl: '/a' }, r1, e => { passed = e; }));
        assert.ok(passed); assert.equal(r1.code, undefined);
        const r2 = mk();
        const lines = capture(() => L.globalErrorHandler(new Error('db'), { method: 'GET', originalUrl: '/a' }, r2, () => assert.fail('next çağrılmamalı')));
        assert.equal(r2.code, 500); assert.deepEqual(r2.body, { error: 'Sunucu hatası' });
        assert.equal(lines.length, 1);
    });
});

describe('log-error HTTP', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, u;
    before(async () => { s = await startServer(); u = await s.createUserWithToken(); });
    after(async () => { if (s) await s.stop(); });

    it('rota 500 döner: gövde değişmez, günlükte [route-error] ve [5xx] görünür; query sızmaz', async () => {
        await s.pool.query('ALTER TABLE notifications RENAME TO notifications_bak');
        try {
            const r = await s.api('GET', '/api/notifications?secret=QRYSECRET123', { token: u.token });
            assert.equal(r.status, 500, r.text);
            assert.deepEqual(r.json, { error: 'Sunucu hatası' });
            await new Promise(res => setTimeout(res, 150));
            const logs = s.logs();
            const errLine = logs.split('\n').find(l => l.startsWith('[route-error]') && l.includes('GET /api/notifications'));
            assert.ok(errLine, logs.slice(-1500));
            const rec = JSON.parse(errLine.slice('[route-error] '.length));
            assert.equal(rec.code, '42P01');
            assert.equal(rec.user, String(u.id));
            assert.ok(/^\[5xx\] GET \/api\/notifications 500 \d+ms user=/.test(logs.split('\n').find(l => l.startsWith('[5xx]')) || ''), logs.slice(-1500));
            assert.ok(!logs.includes('QRYSECRET123'));
            assert.ok(!logs.includes(u.email));
        } finally {
            await s.pool.query('ALTER TABLE notifications_bak RENAME TO notifications');
        }
    });

    it('bozuk JSON gövde 400 davranışı korunur (günlüğe 5xx yazılmaz)', async () => {
        const before = s.logs().length;
        const r = await s.api('POST', '/api/auth/login', { rawBody: '{bozuk', headers: { 'Content-Type': 'application/json' } });
        assert.equal(r.status, 400);
        assert.ok(!r.json); // Express varsayılan (HTML) işleyicisi, eskisi gibi
        assert.ok(!/\[5xx\]|global-error-handler/.test(s.logs().slice(before)));
    });
});
