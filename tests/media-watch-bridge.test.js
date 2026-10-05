'use strict';
// Medya takip tarayıcısı (köprü): RSS ayrıştırma, marka eşleşmesi, dönüşümlü marka penceresi, her kaynağı çalıştırma başına bir kez indirme.
// Ağ/veritabanı gerekmez (fetch sahte).
process.env.MEDIA_WATCH_BRIDGE_DELAY_MS = '0';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../media-watch-bridge');

const RSS = (items) => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item>
<title><![CDATA[${i.title}]]></title><description><![CDATA[${i.desc || ''}]]></description>
<link>${i.link}</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;

describe('media-watch-bridge: saf fonksiyonlar', () => {
    it('RSS öğelerini ayrıştırır, sınıflandırır ve puanlar', () => {
        const xml = RSS([
            { title: 'John Deere yeni seri traktörünü tanıttı', desc: '<p>Lansman</p>', link: 'https://x.test/a' },
            { title: 'Valtra servis şikayeti artıyor', desc: 'garanti sorunu', link: 'https://x.test/b' }
        ]);
        const items = bridge.parseRssItems(xml, { family_code: 'news', brand_id: 1, brand_name: 'John Deere', brand_slug: 'john-deere' });
        assert.equal(items.length, 2);
        assert.equal(items[0].item_type, 'launch');
        assert.equal(items[0].sentiment_label, 'positive');
        assert.equal(items[0].summary, 'Lansman'); // HTML temizlendi
        assert.equal(items[1].item_type, 'complaint');
        assert.equal(items[1].sentiment_label, 'negative');
    });

    it('marka eşleşmesi tam kelime ve takma adlarla çalışır; alakasız metni eler', () => {
        const dd = { name: 'JOHN DEERE', slug: 'john-deere' };
        assert.equal(bridge.brandMatchesText(dd, 'Deere yeni motor duyurdu'), true);
        assert.equal(bridge.brandMatchesText(dd, 'Frutteto TR videosu'), false);
        assert.equal(bridge.brandMatchesText({ name: 'CASE', slug: 'case' }, 'Case IH hasat makinesi'), true);
    });

    it('aynı bağlantı+başlık yinelenenleri atılır', () => {
        const a = { source_url: 'u', title: 't' };
        assert.equal(bridge.dedupeByLink([a, { ...a }, { source_url: 'u2', title: 't' }]).length, 2);
    });

    it('marka penceresi dönüşümlüdür: 5 marka, pencere 2 → hepsi sırayla taranır', () => {
        const brands = ['A', 'B', 'C', 'D', 'E'].map(n => ({ name: n }));
        const seen = [];
        for (let i = 0; i < 3; i++) seen.push(...bridge.pickBrandWindow(brands, 2, 'pack-test', false).map(b => b.name));
        assert.deepEqual(seen, ['A', 'B', 'C', 'D', 'E', 'A']);
        // belirli marka istenmişse pencere dönmez
        assert.deepEqual(bridge.pickBrandWindow(brands, 2, 'pack-test', true).map(b => b.name), ['A', 'B']);
        // marka sayısı pencereden küçükse hepsi
        assert.equal(bridge.pickBrandWindow(brands.slice(0, 2), 12, 'pack-x', false).length, 2);
    });

    it('kayıtlı kaynak listeleri tutarlı: benzersiz kodlar, https RSS', () => {
        const all = [...bridge.INTERNATIONAL_SOURCE_REGISTRY, ...bridge.SECTOR_PUBLICATIONS_REGISTRY];
        assert.equal(new Set(all.map(s => s.code)).size, all.length);
        for (const s of all) assert.match(s.rss, /^https:\/\//, s.code);
    });
});

describe('media-watch-bridge: kaynak başına tek indirme', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it('aynı RSS kaynağı birden çok marka için tek kez indirilir', async () => {
        let calls = 0;
        global.fetch = async () => {
            calls++;
            return new Response(RSS([
                { title: 'John Deere ve Kubota yeni model', link: 'https://x.test/1' },
                { title: 'Alakasız haber', link: 'https://x.test/2' }
            ]), { status: 200 });
        };
        const registry = [{ code: 't1', name: 'Test', rss: 'https://feed.test/rss', language: 'en', country: 'US', category: 'news' }];
        const cache = new Map();
        const brands = [{ id: 1, name: 'John Deere', slug: 'john-deere' }, { id: 2, name: 'Kubota', slug: 'kubota' }, { id: 3, name: 'Fendt', slug: 'fendt' }];
        const results = [];
        for (const b of brands) results.push(await bridge.collectFromRegistrySources('pack-4', b, registry, { _feedCache: cache }));
        assert.equal(calls, 1);
        assert.equal(results[0].length, 1);
        assert.equal(results[1].length, 1);
        assert.equal(results[2].length, 0);
        assert.equal(results[0][0].country_code, 'US');
    });

    it('bozuk/hatalı kaynak diğerlerini engellemez', async () => {
        global.fetch = async (url) => String(url).includes('bad')
            ? new Response('x', { status: 500 })
            : new Response(RSS([{ title: 'Kubota duyurdu', link: 'https://x.test/k' }]), { status: 200 });
        const registry = [
            { code: 'bad', name: 'Bad', rss: 'https://bad.test/rss', language: 'en', country: 'US', category: 'news' },
            { code: 'ok', name: 'Ok', rss: 'https://ok.test/rss', language: 'en', country: 'US', category: 'news' }
        ];
        const items = await bridge.collectFromRegistrySources('pack-4', { id: 2, name: 'Kubota', slug: 'kubota' }, registry, { _feedCache: new Map() });
        assert.equal(items.length, 1);
    });
});
