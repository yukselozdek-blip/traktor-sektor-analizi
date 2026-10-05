'use strict';
// Uçtan uca: köprü (doğrudan mod) → sahte RSS → gerçek test sunucusunun /api/media-watch/ingest uç noktası → veritabanı.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const KEY = 'Şifre-test-key-ğüöçı-' + 'x'.repeat(20); // Türkçe karakterli anahtar: HTTP başlığına düz yazılamaz, özetle gönderilmeli

describe('medya takip köprüsü → ingest → veritabanı', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, bridge, realFetch, failIngest = false, failGoogle = false, fakeBridge, fakeBridgeCalls = [], fakeBridgeBusy = false;
    before(async () => {
        // Uygulamanın run-now yolunu sınamak için sahte köprü (gövdeyi kaydeder, meşgulse 409 döner)
        fakeBridge = http.createServer((req, res) => {
            let body = '';
            req.on('data', d => { body += d; });
            req.on('end', () => {
                fakeBridgeCalls.push({ url: req.url, body: JSON.parse(body || '{}') });
                res.setHeader('Content-Type', 'application/json');
                if (fakeBridgeBusy) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'Tarama zaten sürüyor' })); }
                res.statusCode = 202; res.end(JSON.stringify({ started: true }));
            });
        });
        await new Promise(r => fakeBridge.listen(0, '127.0.0.1', r));
        s = await startServer({ env: { MEDIA_WATCH_WEBHOOK_KEY: KEY, MEDIA_WATCH_BRIDGE_URL: `http://127.0.0.1:${fakeBridge.address().port}` } });
        await s.pool.query(`INSERT INTO brands (name, slug, is_active) VALUES ('Kubota', 'kubota', true)
            ON CONFLICT (slug) DO UPDATE SET name = 'Kubota', is_active = true`);
        process.env.DATABASE_URL = s.pool.options.connectionString;
        process.env.MEDIA_WATCH_APP_BASE_URL = s.baseUrl;
        process.env.MEDIA_WATCH_WEBHOOK_KEY = KEY;
        process.env.MEDIA_WATCH_BRIDGE_DELAY_MS = '0';
        process.env.MEDIA_WATCH_BRIDGE_DIRECT = 'true';
        realFetch = global.fetch;
        // Yalnızca dış RSS adresleri sahtelenir; test sunucusuna giden istekler gerçek kalır.
        global.fetch = async (url, opts) => {
            if (failGoogle && String(url).includes('news.google.com')) return new Response('blocked', { status: 503 });
            if (failIngest && String(url).includes('/api/media-watch/ingest')) return new Response(JSON.stringify({ error: 'Webhook yetkisiz' }), { status: 401 });
            if (String(url).startsWith(s.baseUrl)) return realFetch(url, opts);
            await new Promise(r => setTimeout(r, 120)); // taramanın 'sürüyor' durumunu gözlemlemek için
            return new Response(`<rss><channel><item><title>Kubota yeni traktörünü tanıttı</title><description>Lansman haberi</description>
                <link>https://haber.test/kubota-1</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
                <item><title>Alakasız haber</title><link>https://haber.test/x</link></item></channel></rss>`, { status: 200 });
        };
        bridge = require('../media-watch-bridge');
    });
    after(async () => {
        if (realFetch) global.fetch = realFetch;
        if (s) await s.stop();
        if (fakeBridge) await new Promise(r => fakeBridge.close(r));
    });

    it('pack-5 çalışır: eşleşen haber veritabanına yazılır, alakasız yazılmaz; tekrar çalıştırmak yineleme üretmez', async () => {
        const first = await bridge.runPackAndPush('pack-5', { brand_name: 'Kubota' });
        assert.equal(first.success, true);
        assert.ok(first.item_count >= 1, 'en az bir eşleşen kayıt: ' + JSON.stringify(first));
        const rows = (await s.pool.query(
            `SELECT title, item_type, source_domain, language, country_code FROM media_watch_items WHERE source_url = 'https://haber.test/kubota-1'`)).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].item_type, 'launch');
        assert.equal(rows[0].country_code, 'TR');
        assert.equal((await s.pool.query(`SELECT COUNT(*)::int AS n FROM media_watch_items WHERE title = 'Alakasız haber'`)).rows[0].n, 0);
        const runs = (await s.pool.query(`SELECT COUNT(*)::int AS n FROM media_watch_runs`)).rows[0].n;
        assert.ok(runs >= 1);

        await bridge.runPackAndPush('pack-5', { brand_name: 'Kubota' });
        const again = (await s.pool.query(`SELECT COUNT(*)::int AS n FROM media_watch_items WHERE source_url = 'https://haber.test/kubota-1'`)).rows[0].n;
        assert.equal(again, 1, 'aynı haber tekrar eklenmemeli');
    });

    it('yanlış webhook anahtarıyla ingest reddedilir', async () => {
        const r = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key': 'yanlis' }, body: { items: [] } });
        assert.equal(r.status, 401);
    });

    it('"Şimdi Tara": uygulama köprüyü arka planda (async) başlatır, hemen 202 döner; meşgulken 409 iletir', async () => {
        const admin = await s.createUserWithToken({ role: 'admin' });
        const r = await s.api('POST', '/api/media-watch/run-now', { token: admin.token, body: { brand_id: null } });
        assert.equal(r.status, 202, r.text);
        assert.equal(r.json.started, true);
        const call = fakeBridgeCalls.at(-1);
        assert.match(call.url, /push-all$/);
        assert.equal(call.body.async, true);
        fakeBridgeBusy = true;
        const busy = await s.api('POST', '/api/media-watch/run-now', { token: admin.token, body: {} });
        assert.equal(busy.status, 409);
        fakeBridgeBusy = false;
    });

    it('bridge-status yalnızca yöneticiye açık', async () => {
        const user = await s.createUserWithToken({ role: 'brand_user' });
        assert.equal((await s.api('GET', '/api/admin/media-watch/bridge-status')).status, 401);
        assert.equal((await s.api('GET', '/api/admin/media-watch/bridge-status', { token: user.token })).status, 403);
        const admin = await s.createUserWithToken({ role: 'admin' });
        const r = await s.api('GET', '/api/admin/media-watch/bridge-status', { token: admin.token });
        assert.equal(r.status, 200);
        assert.ok('reachable' in r.json);
    });

    it('köprü: async başlatma 202, sürerken ikinci istek 409, bitince durum ve son sonuç görünür', async () => {
        const srv = await new Promise(r => { const x = bridge.app.listen(0, '127.0.0.1', () => r(x)); });
        const base = `http://127.0.0.1:${srv.address().port}`;
        try {
            const post = () => realFetch(`${base}/api/media-watch/push-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ async: true, brand_name: 'Kubota' }) });
            const a = await post();
            assert.equal(a.status, 202);
            const b = await post();
            assert.equal(b.status, 409);
            let st;
            for (let i = 0; i < 100; i++) {
                st = await (await realFetch(`${base}/api/media-watch/status`)).json();
                if (!st.in_flight && st.last) break;
                await new Promise(r => setTimeout(r, 200));
            }
            assert.equal(st.in_flight, false);
            assert.equal(st.last.ok, true, JSON.stringify(st.last));
            assert.ok(st.last.item_count >= 1);
            assert.ok(Number.isFinite(st.last.duration_ms));
        } finally { await new Promise(r => srv.close(r)); }
    });

    it('kayıt reddedilirse (401) çalıştırma özetinde görünür: başarısız sayısı ve anahtar ipucu', async () => {
        const srv = await new Promise(r => { const x = bridge.app.listen(0, '127.0.0.1', () => r(x)); });
        const base = `http://127.0.0.1:${srv.address().port}`;
        try {
            failIngest = true;
            const a = await realFetch(`${base}/api/media-watch/push-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ async: true, brand_name: 'Kubota' }) });
            assert.equal(a.status, 202);
            let st;
            for (let i = 0; i < 100; i++) {
                st = await (await realFetch(`${base}/api/media-watch/status`)).json();
                if (!st.in_flight && st.last) break;
                await new Promise(r => setTimeout(r, 200));
            }
            assert.ok(st.last.ingest_failed >= 1, JSON.stringify(st.last));
            assert.equal(st.last.inserted_count, 0);
            assert.ok(st.last.errors.some(e => e.pack === 'ingest' && /401/.test(e.error) && /MEDIA_WATCH_WEBHOOK_KEY/.test(e.error)), JSON.stringify(st.last.errors));
        } finally { failIngest = false; await new Promise(r => srv.close(r)); }
    });

    it('başarılı çalıştırmada kaydedilen kayıt sayısı özete yansır', async () => {
        const srv = await new Promise(r => { const x = bridge.app.listen(0, '127.0.0.1', () => r(x)); });
        const base = `http://127.0.0.1:${srv.address().port}`;
        try {
            await realFetch(`${base}/api/media-watch/push-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ async: true, brand_name: 'Kubota' }) });
            let st;
            for (let i = 0; i < 100; i++) {
                st = await (await realFetch(`${base}/api/media-watch/status`)).json();
                if (!st.in_flight && st.last) break;
                await new Promise(r => setTimeout(r, 200));
            }
            assert.ok(st.last.ingest_ok >= 1 && st.last.ingest_failed === 0, JSON.stringify(st.last));
        } finally { await new Promise(r => srv.close(r)); }
    });

    it('Google Haberler yanıt vermezse devre kesici açılır, RSS paketleri yine kaydedilir ve özet bunu söyler', async () => {
        const srv = await new Promise(r => { const x = bridge.app.listen(0, '127.0.0.1', () => r(x)); });
        const base = `http://127.0.0.1:${srv.address().port}`;
        try {
            failGoogle = true;
            await realFetch(`${base}/api/media-watch/push-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ async: true, brand_name: 'Kubota' }) });
            let st, sawProgress = false;
            for (let i = 0; i < 150; i++) {
                st = await (await realFetch(`${base}/api/media-watch/status`)).json();
                if (st.in_flight && st.progress && st.progress.pack) sawProgress = true;
                if (!st.in_flight && st.last) break;
                await new Promise(r => setTimeout(r, 100));
            }
            assert.equal(st.last.google_breaker_open, true, JSON.stringify(st.last));
            assert.ok(st.last.fetch_failed >= 6, JSON.stringify(st.last));
            assert.ok(st.last.errors.some(e => e.where === 'google-news'), JSON.stringify(st.last.errors));
            assert.ok(st.last.ingest_ok >= 1, 'RSS paketleri (4/5) yine kaydedilmeli: ' + JSON.stringify(st.last));
            assert.ok(sawProgress, 'sürerken ilerleme bilgisi görünmeli');
        } finally { failGoogle = false; await new Promise(r => srv.close(r)); }
    });

    it('bağlantı testi: dış kaynaklar, kayıt (anahtar) ve marka sayısını raporlar; reddedilen anahtarı tanır', async () => {
        const ok = await bridge.selfTest();
        assert.equal(ok.google_news.ok, true);
        assert.equal(ok.sector_rss.ok, true);
        assert.equal(ok.ingest.ok, true);
        assert.ok(ok.brands.count >= 1);
        assert.equal(ok.config.key_set, true);
        assert.equal(ok.config.key_non_ascii, true);
        assert.ok(ok.registry.total >= 30 && ok.registry.ok === ok.registry.total, JSON.stringify(ok.registry));
        assert.equal(JSON.stringify(ok).includes(KEY), false, 'anahtarın kendisi sızmamalı (yalnızca uzunluk)');
        failGoogle = true; failIngest = true;
        try {
            const bad = await bridge.selfTest();
            assert.equal(bad.google_news.ok, false);
            assert.equal(bad.ingest.ok, false);
            assert.equal(bad.ingest.key_rejected, true);
        } finally { failGoogle = false; failIngest = false; }
    });

    it('admin self-test ucu yalnızca yöneticiye açık ve köprüye iletir', async () => {
        const user = await s.createUserWithToken({ role: 'brand_user' });
        assert.equal((await s.api('GET', '/api/admin/media-watch/self-test')).status, 401);
        assert.equal((await s.api('GET', '/api/admin/media-watch/self-test', { token: user.token })).status, 403);
        const admin = await s.createUserWithToken({ role: 'admin' });
        const r = await s.api('GET', '/api/admin/media-watch/self-test', { token: admin.token });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.reachable, true);
    });
});
