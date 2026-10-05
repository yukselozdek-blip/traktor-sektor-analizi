'use strict';
process.env.MEDIA_WATCH_GOOGLE_DELAY_MS = '0';
process.env.MEDIA_WATCH_BRIDGE_DELAY_MS = '0';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../media-watch-bridge');

const BING = `<?xml version="1.0"?><rss xmlns:News="https://www.bing.com/news/search"><channel>
<item><title>Kubota yeni traktör serisini tanıttı</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fwww.tarimhaber.com%2fkubota-yeni-seri&amp;c=1</link>
<description>Kubota Türkiye lansman yaptı.</description><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>
<News:Source>Tarım Haber</News:Source></item></channel></rss>`;

describe('medya takip: Bing Haberler yedeği', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; b.googleBreaker.fails = 0; b.googleBreaker.open = false; b.bingBreaker.fails = 0; b.bingBreaker.open = false; });

    it('normalizeBingXml: gerçek haber adresi ve yayıncı çıkarılır, parseRssItems kullanabilir', () => {
        const items = b.parseRssItems(b.normalizeBingXml(BING), { brand_id: 1, brand_name: 'Kubota', brand_slug: 'kubota', family_code: 'news' });
        assert.equal(items.length, 1);
        assert.equal(items[0].source_url, 'https://www.tarimhaber.com/kubota-yeni-seri');
        assert.equal(items[0].source_name, 'Tarım Haber');
        assert.equal(items[0].source_domain, 'www.tarimhaber.com');
    });

    it('Google 503 verirse Bing’e düşer; Google devre kesicisi açılınca Bing kullanılmaya devam eder', async () => {
        const calls = [];
        global.fetch = async (url) => {
            calls.push(String(url));
            if (String(url).includes('news.google.com')) return new Response('x', { status: 503 });
            return new Response(BING, { status: 200 });
        };
        for (let i = 0; i < 8; i++) {
            const r = await b.fetchNewsFeed('Kubota traktör', 'pack-1');
            assert.equal(r.via, 'bing-news-rss');
        }
        assert.equal(b.googleBreaker.open, true);
        const googleCalls = calls.filter(u => u.includes('news.google.com')).length;
        assert.equal(googleCalls, 6, 'Google devre açıldıktan sonra denenmemeli');
    });

    it('Google çalışıyorsa Bing’e dokunulmaz', async () => {
        const calls = [];
        global.fetch = async (url) => { calls.push(String(url)); return new Response('<rss><channel></channel></rss>', { status: 200 }); };
        const r = await b.fetchNewsFeed('x', 'pack-1');
        assert.equal(r.via, 'google-news-rss');
        assert.ok(!calls.some(u => u.includes('bing.com')));
    });

    it('ikisi de çökerse hata fırlatır (sahte kayıt üretilmez)', async () => {
        global.fetch = async () => new Response('x', { status: 503 });
        await assert.rejects(() => b.fetchNewsFeed('x', 'pack-1'), /HTTP 503/);
    });
});
