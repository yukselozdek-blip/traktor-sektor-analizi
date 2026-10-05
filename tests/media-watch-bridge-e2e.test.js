'use strict';
// Uçtan uca: köprü (doğrudan mod) → sahte RSS → gerçek test sunucusunun /api/media-watch/ingest uç noktası → veritabanı.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const KEY = 'test-media-watch-key-' + 'x'.repeat(20);

describe('medya takip köprüsü → ingest → veritabanı', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, bridge, realFetch;
    before(async () => {
        s = await startServer({ env: { MEDIA_WATCH_WEBHOOK_KEY: KEY } });
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
            if (String(url).startsWith(s.baseUrl)) return realFetch(url, opts);
            return new Response(`<rss><channel><item><title>Kubota yeni traktörünü tanıttı</title><description>Lansman haberi</description>
                <link>https://haber.test/kubota-1</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
                <item><title>Alakasız haber</title><link>https://haber.test/x</link></item></channel></rss>`, { status: 200 });
        };
        bridge = require('../media-watch-bridge');
    });
    after(async () => {
        if (realFetch) global.fetch = realFetch;
        if (s) await s.stop();
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
});
