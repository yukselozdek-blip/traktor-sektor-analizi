'use strict';
try { require('dotenv').config(); } catch (_) { /* üretimde ortam değişkenleri platformdan gelir */ }
const express = require('express');
const cron = require('node-cron');

const app = express();

const PORT = parseInt(process.env.MEDIA_WATCH_BRIDGE_PORT || '3011', 10);
const HOST = process.env.MEDIA_WATCH_BRIDGE_HOST || '127.0.0.1';
// Veritabanı bağlantısı uygulamanın kendi havuzundan (SSL kuralları dahil) alınır; yalnızca marka listesi okunur.
// Havuz tembel yüklenir: DATABASE_URL olmadan da modül birim testlerde içe aktarılabilir.
let _pool = null;
const poolProxy = { query: (...args) => (_pool || (_pool = require('./src/db').pool)).query(...args) };
const DEFAULT_N8N_WEBHOOK_URLS = {
    'pack-1': 'http://127.0.0.1:5680/webhook/media-watch-pack-1',
    'pack-2': 'http://127.0.0.1:5680/webhook/media-watch-pack-2',
    'pack-3': 'http://127.0.0.1:5680/webhook/media-watch-pack-3',
    'pack-4': 'http://127.0.0.1:5680/webhook/media-watch-pack-4',
    'pack-5': 'http://127.0.0.1:5680/webhook/media-watch-pack-5',
    'pack-6': 'http://127.0.0.1:5680/webhook/media-watch-pack-6'
};

// ============================================
// PACK 4 — Uluslararası tarım haberleri (RSS, doğrudan kaynak)
// ============================================
const INTERNATIONAL_SOURCE_REGISTRY = [
    { code: 'reuters_agri',     name: 'Reuters Agriculture',  rss: 'https://www.reutersagency.com/feed/?best-topics=agriculture&post_type=best',  language: 'en', country: 'WORLD', category: 'news' },
    { code: 'agfunder',         name: 'AgFunder News',        rss: 'https://agfundernews.com/feed',                                                language: 'en', country: 'US',    category: 'news' },
    { code: 'future_farming',   name: 'Future Farming',       rss: 'https://www.futurefarming.com/feed/',                                          language: 'en', country: 'NL',    category: 'news' },
    { code: 'modern_farmer',    name: 'Modern Farmer',        rss: 'https://modernfarmer.com/feed/',                                               language: 'en', country: 'US',    category: 'news' },
    { code: 'agriland_ie',      name: 'Agriland Ireland',     rss: 'https://www.agriland.ie/feed/',                                                language: 'en', country: 'IE',    category: 'news' },
    { code: 'agriland_uk',      name: 'Agriland UK',          rss: 'https://www.agriland.co.uk/feed/',                                             language: 'en', country: 'GB',    category: 'news' },
    { code: 'farmers_weekly',   name: 'Farmers Weekly UK',    rss: 'https://www.fwi.co.uk/rss.xml',                                                language: 'en', country: 'GB',    category: 'news' },
    { code: 'agweb',            name: 'AgWeb',                rss: 'https://www.agweb.com/rss',                                                    language: 'en', country: 'US',    category: 'news' },
    { code: 'successful_farm',  name: 'Successful Farming',   rss: 'https://www.agriculture.com/feeds/all',                                        language: 'en', country: 'US',    category: 'news' },
    { code: 'farmonline_au',    name: 'Farm Online Australia',rss: 'https://www.farmonline.com.au/rss.xml',                                        language: 'en', country: 'AU',    category: 'news' },
    { code: 'agtechnavigator',  name: 'AgTech Navigator',     rss: 'https://www.agtechnavigator.com/rss',                                          language: 'en', country: 'WORLD', category: 'tech' },
    { code: 'precision_ag',     name: 'Precision Ag',         rss: 'https://www.precisionag.com/feed/',                                            language: 'en', country: 'US',    category: 'tech' },
    { code: 'agrarheute',       name: 'agrarheute',           rss: 'https://www.agrarheute.com/rss/news.xml',                                      language: 'de', country: 'DE',    category: 'news' },
    { code: 'topagrar',         name: 'topagrar',             rss: 'https://www.topagrar.com/rss/news/',                                           language: 'de', country: 'DE',    category: 'news' },
    { code: 'reussir',          name: 'Réussir Machinisme',   rss: 'https://www.reussir.fr/rss/feeds.xml',                                         language: 'fr', country: 'FR',    category: 'news' },
    { code: 'lafranceagricole', name: 'La France Agricole',   rss: 'https://www.lafranceagricole.fr/rss',                                          language: 'fr', country: 'FR',    category: 'news' },
    { code: 'agronotizie_it',   name: 'AgroNotizie',          rss: 'https://agronotizie.imagelinenetwork.com/rss/',                                language: 'it', country: 'IT',    category: 'news' },
    { code: 'eurofarmer',       name: 'Euro Farmer',          rss: 'https://www.eurofarmer.net/feed',                                              language: 'en', country: 'EU',    category: 'news' },
    { code: 'fao_news',         name: 'FAO News',             rss: 'https://www.fao.org/feed/news/en/',                                            language: 'en', country: 'WORLD', category: 'official' },
    { code: 'usda_news',        name: 'USDA News',            rss: 'https://www.usda.gov/oc/feeds/usda-news.xml',                                  language: 'en', country: 'US',    category: 'official' },
    { code: 'fwi_machinery',    name: 'FWI Machinery',        rss: 'https://www.fwi.co.uk/machinery/feed',                                         language: 'en', country: 'GB',    category: 'machinery' }
];

// ============================================
// PACK 5 — Türkiye sektör yayınları (RSS, doğrudan)
// ============================================
const SECTOR_PUBLICATIONS_REGISTRY = [
    { code: 'tarim_pulsu',    name: 'Tarım Pulsu',          rss: 'https://www.tarimpulsu.com/feed',                                language: 'tr', country: 'TR', category: 'news' },
    { code: 'tarim_haber',    name: 'Tarım Haber',          rss: 'https://www.tarimhaber.com.tr/rss.xml',                          language: 'tr', country: 'TR', category: 'news' },
    { code: 'tarimdan_haber', name: 'Tarımdan Haber',       rss: 'https://www.tarimdanhaber.com/feed/',                            language: 'tr', country: 'TR', category: 'news' },
    { code: 'agropedia_tr',   name: 'Agropedia',            rss: 'https://agropedia.com.tr/feed/',                                 language: 'tr', country: 'TR', category: 'news' },
    { code: 'tarim_yatirim',  name: 'Tarım & Yatırım',      rss: 'https://www.tarimveyatirim.com/feed',                            language: 'tr', country: 'TR', category: 'news' },
    { code: 'koyden',         name: 'Köyden',               rss: 'https://www.koyden.com/feed',                                    language: 'tr', country: 'TR', category: 'news' },
    { code: 'ciftci_postasi', name: 'Çiftçi Postası',       rss: 'https://www.ciftcipostasi.com/feed',                             language: 'tr', country: 'TR', category: 'news' },
    { code: 'tarim_dunyasi',  name: 'Tarım Dünyası',        rss: 'https://www.tarimdunyasi.net/feed',                              language: 'tr', country: 'TR', category: 'news' },
    { code: 'iha_tarim',      name: 'İHA Tarım',            rss: 'https://www.iha.com.tr/rss/ekonomi/tarim',                       language: 'tr', country: 'TR', category: 'news' },
    { code: 'aa_tarim',       name: 'AA Tarım',             rss: 'https://www.aa.com.tr/tr/rss/default?cat=tarim',                 language: 'tr', country: 'TR', category: 'news' },
    { code: 'dha_tarim',      name: 'DHA Tarım',            rss: 'https://www.dha.com.tr/rss/tarim.xml',                           language: 'tr', country: 'TR', category: 'news' },
    { code: 'tzob',           name: 'TZOB Duyurular',       rss: 'https://www.tzob.org.tr/?feed=rss2',                             language: 'tr', country: 'TR', category: 'official' }
];

// ============================================
// PACK 6 — OEM resmi basın / kurumsal duyuru sayfaları (HTML scrape gerektirir, fallback: kendi sitesinde site: araması)
// ============================================
const OEM_PRESS_PATTERNS = {
    cnh:        ['site:cnh.com OR site:cnhindustrial.com news press'],
    deere:      ['site:deere.com OR site:johndeere.com news press'],
    agco:       ['site:agcocorp.com OR site:masseyferguson.com OR site:fendt.com OR site:valtra.com news press'],
    kubota:     ['site:kubota.com news press'],
    claas:      ['site:claas.com news press'],
    sdf:        ['site:sdfgroup.com OR site:deutz-fahr.com OR site:same-tractors.com news press'],
    argo:       ['site:argotractors.com OR site:landini.it OR site:mccormick.it news press'],
    yto:        ['site:yto.com.cn news press'],
    lovol:      ['site:lovol.com news press']
};
const N8N_BASIC_AUTH_USER = String(process.env.N8N_BASIC_AUTH_USER || '').trim();
const N8N_BASIC_AUTH_PASSWORD = String(process.env.N8N_BASIC_AUTH_PASSWORD || '').trim();
const BRIDGE_AUTORUN = String(process.env.MEDIA_WATCH_BRIDGE_AUTORUN || 'true').toLowerCase() === 'true';
// Varsayılan: saatte bir (Google Haberler/RSS kaynaklarına nazik davranmak için). İhtiyaç olursa MEDIA_WATCH_BRIDGE_SCHEDULE ile sıklaştırılır.
const BRIDGE_SCHEDULE = String(process.env.MEDIA_WATCH_BRIDGE_SCHEDULE || '7 * * * *').trim();
// DIRECT MODE: n8n'i bypass et, doğrudan app'in /api/media-watch/ingest endpoint'ine POST at.
// Default: 'true' (n8n container'ı kurulu olmadan çalışır). 'false' yapılırsa n8n webhook akışı kullanılır.
const DIRECT_MODE = String(process.env.MEDIA_WATCH_BRIDGE_DIRECT || 'true').toLowerCase() === 'true';
const APP_BASE_URL = String(process.env.MEDIA_WATCH_APP_BASE_URL || process.env.APP_BASE_URL || 'http://127.0.0.1:3002').replace(/\/$/, '');
const MEDIA_WATCH_KEY = String(process.env.MEDIA_WATCH_WEBHOOK_KEY || process.env.WHATSAPP_QUERY_API_KEY || '').trim();
const BRIDGE_PACKS = String(process.env.MEDIA_WATCH_BRIDGE_PACKS || 'pack-1,pack-2,pack-3,pack-4,pack-5,pack-6')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => ['pack-1', 'pack-2', 'pack-3', 'pack-4', 'pack-5', 'pack-6'].includes(item));
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.MEDIA_WATCH_BRIDGE_TIMEOUT_MS || 12000));
const ALLOWED_ORIGINS = new Set([
    'http://localhost:3002',
    'http://127.0.0.1:3002',
    'http://localhost:5680',
    'http://127.0.0.1:5680'
]);

const pool = poolProxy;
let autorunInFlight = false;
const FETCH_DELAY_MS = Math.max(0, Number(process.env.MEDIA_WATCH_BRIDGE_DELAY_MS || 250)); // art arda isteklerde nezaket aralığı
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Çalıştırma durumu (yönetici panelinde görünür): sürüyor mu, son çalıştırma sonucu ve ilk hatalar.
const runState = { in_flight: false, started_at: null, last: null };
let runErrors = [];
let ingestStats = { ok: 0, failed: 0, inserted: 0 };
const noteError = (pack, where, err) => { if (runErrors.length < 200) runErrors.push({ pack, where: String(where).slice(0, 80), error: String((err && err.message) || err).slice(0, 160) }); };

app.use(express.json({ limit: '4mb' }));

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.use((req, res, next) => {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
});

function decodeXmlEntities(value = '') {
    return String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value = '') {
    return decodeXmlEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseJsonSafe(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeUrlHost(url = '') {
    try {
        return new URL(String(url)).hostname.replace(/^www\./i, '');
    } catch {
        return '';
    }
}

function normalizeSocialHandle(entry = {}) {
    const direct = String(entry.handle || '').trim().replace(/^@+/, '');
    if (direct) return direct;
    const url = String(entry.url || '').trim();
    if (!url) return '';
    try {
        const path = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
        return path.replace(/^@+/, '');
    } catch {
        return '';
    }
}

function normalizeSocialPlatform(entry = {}) {
    const bag = `${entry.platform || ''} ${entry.url || ''}`.toLowerCase();
    if (bag.includes('instagram')) return 'instagram';
    if (bag.includes('facebook')) return 'facebook';
    if (bag.includes('youtube')) return 'youtube';
    if (bag.includes('twitter') || bag.includes('x.com') || bag.includes('x/')) return 'x';
    if (bag.includes('linkedin')) return 'linkedin';
    return 'web';
}

function extractTag(block = '', tagName = '') {
    const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? decodeXmlEntities(match[1]).trim() : '';
}

function extractSource(block = '') {
    const match = block.match(/<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);
    return {
        url: match ? decodeXmlEntities(match[1]).trim() : '',
        title: match ? decodeXmlEntities(match[2]).trim() : ''
    };
}

function buildGoogleNewsUrl(query = '') {
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=tr&gl=TR&ceid=TR:tr`;
}

function resolveN8nWebhookUrl(packCode = 'pack-1') {
    const envMap = {
        'pack-1': String(
            process.env.MEDIA_WATCH_N8N_WEBHOOK_URL ||
            process.env.N8N_MEDIA_WATCH_WEBHOOK_URL ||
            DEFAULT_N8N_WEBHOOK_URLS['pack-1']
        ).trim(),
        'pack-2': String(
            process.env.MEDIA_WATCH_N8N_WEBHOOK_URL_PACK_2 ||
            process.env.N8N_MEDIA_WATCH_WEBHOOK_URL_PACK_2 ||
            DEFAULT_N8N_WEBHOOK_URLS['pack-2']
        ).trim(),
        'pack-3': String(
            process.env.MEDIA_WATCH_N8N_WEBHOOK_URL_PACK_3 ||
            process.env.N8N_MEDIA_WATCH_WEBHOOK_URL_PACK_3 ||
            DEFAULT_N8N_WEBHOOK_URLS['pack-3']
        ).trim()
    };

    return envMap[packCode] || DEFAULT_N8N_WEBHOOK_URLS['pack-1'];
}

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
}

function normalizeFamilyMeta(familyCode = '', title = '', summary = '') {
    const bag = `${title} ${summary}`.toLocaleLowerCase('tr-TR');
    if (familyCode === 'official') return { channel_type: 'official', item_type: 'regulation', platform_name: 'official' };
    if (familyCode === 'official-web') {
        if (/(kampanya|indirim|firsat|destek paketi)/i.test(bag)) return { channel_type: 'official', item_type: 'campaign', platform_name: 'brand-web' };
        if (/(tanit|lansman|yeni seri|duyurdu|launch|product)/i.test(bag)) return { channel_type: 'official', item_type: 'launch', platform_name: 'brand-web' };
        return { channel_type: 'official', item_type: 'news', platform_name: 'brand-web' };
    }
    if (familyCode === 'official-social') {
        if (/(tanit|lansman|yeni seri|duyurdu|launch|product)/i.test(bag)) return { channel_type: 'social', item_type: 'launch', platform_name: 'official-social' };
        if (/(kampanya|indirim|firsat)/i.test(bag)) return { channel_type: 'social', item_type: 'campaign', platform_name: 'official-social' };
        return { channel_type: 'social', item_type: 'review', platform_name: 'official-social' };
    }
    if (familyCode === 'official-video') {
        const isLaunch = /(tanit|lansman|yeni seri|duyurdu|unveiled|launch)/i.test(bag);
        return { channel_type: 'video', item_type: isLaunch ? 'launch' : 'review', platform_name: 'official-video' };
    }
    if (familyCode === 'complaint') return { channel_type: 'complaint', item_type: 'complaint', platform_name: 'web' };
    if (familyCode === 'forum') {
        return {
            channel_type: 'forum',
            item_type: /(sikayet|ariza|servis|garanti|sorun)/i.test(bag) ? 'complaint' : 'discussion',
            platform_name: 'forum'
        };
    }
    if (familyCode === 'social') {
        if (/(sikayet|ariza|servis|garanti|sorun)/i.test(bag)) {
            return { channel_type: 'social', item_type: 'complaint', platform_name: 'social-web' };
        }
        if (/(tanit|lansman|yeni seri|duyurdu|unveiled|launch)/i.test(bag)) {
            return { channel_type: 'social', item_type: 'launch', platform_name: 'social-web' };
        }
        return { channel_type: 'social', item_type: 'review', platform_name: 'social-web' };
    }
    if (familyCode === 'video') {
        const isLaunch = /(tanit|lansman|yeni seri|duyurdu|unveiled|launch)/i.test(bag);
        return { channel_type: 'video', item_type: isLaunch ? 'launch' : 'review', platform_name: 'youtube' };
    }
    if (/(kampanya|indirim|firsat|destek paketi)/i.test(bag)) {
        return { channel_type: 'news', item_type: 'campaign', platform_name: 'web' };
    }
    if (/(sikayet|ariza|servis|garanti|yedek parca)/i.test(bag)) {
        return { channel_type: 'news', item_type: 'complaint', platform_name: 'web' };
    }
    if (/(yeni model|yeni seri|tanitti|duyurdu|lansman)/i.test(bag)) {
        return { channel_type: 'news', item_type: 'launch', platform_name: 'web' };
    }
    return { channel_type: 'news', item_type: 'news', platform_name: 'web' };
}

function buildTopicTags(familyCode = '', title = '', summary = '') {
    const bag = `${title} ${summary}`.toLocaleLowerCase('tr-TR');
    const topics = [];
    if (familyCode === 'official') topics.push('resmi-karar');
    if (familyCode === 'official-web') topics.push('resmi-web');
    if (familyCode === 'official-social') topics.push('resmi-sosyal');
    if (familyCode === 'official-video') topics.push('resmi-video');
    if (familyCode === 'complaint') topics.push('sikayet');
    if (familyCode === 'forum') topics.push('forum');
    if (familyCode === 'social') topics.push('sosyal-web');
    if (familyCode === 'video') topics.push('video');
    if (/(destek|hibe|teblig|karar)/i.test(bag)) topics.push('destek');
    if (/(yeni model|yeni seri|lansman|tanit)/i.test(bag)) topics.push('lansman');
    if (/(servis|yedek parca|garanti|ariza|sikayet)/i.test(bag)) topics.push('servis');
    if (/(finansman|kampanya|indirim)/i.test(bag)) topics.push('kampanya');
    return [...new Set(topics)];
}

function inferIssueType(bag = '') {
    if (/(sanziman|vites|gear)/i.test(bag)) return 'sanziman';
    if (/(hidrolik|lift|kaldirma)/i.test(bag)) return 'hidrolik';
    if (/(motor|yakit|hararet|egzoz)/i.test(bag)) return 'motor';
    if (/(elektrik|sensor|ekran|gosterg)/i.test(bag)) return 'elektrik';
    if (/(servis|yedek parca|garanti)/i.test(bag)) return 'servis';
    return null;
}

function inferComplaintArea(bag = '') {
    if (/(servis|garanti|yedek parca)/i.test(bag)) return 'satis-sonrasi';
    if (/(fiyat|kampanya|finansman)/i.test(bag)) return 'ticari';
    if (/(motor|sanziman|hidrolik|elektrik)/i.test(bag)) return 'teknik';
    return null;
}

function inferSignalScores(familyMeta = {}, title = '', summary = '') {
    const bag = `${title} ${summary}`.toLocaleLowerCase('tr-TR');
    let sentimentLabel = 'neutral';
    let sentimentScore = 0.05;
    let severityScore = 0.2;
    let relevanceScore = 0.72;

    if (familyMeta.item_type === 'launch') {
        sentimentLabel = 'positive';
        sentimentScore = 0.62;
        severityScore = 0.16;
        relevanceScore = 0.88;
    } else if (familyMeta.item_type === 'regulation') {
        sentimentLabel = 'mixed';
        sentimentScore = 0;
        severityScore = 0.58;
        relevanceScore = 0.91;
    } else if (familyMeta.item_type === 'complaint') {
        sentimentLabel = 'negative';
        sentimentScore = -0.72;
        severityScore = 0.79;
        relevanceScore = 0.86;
    }

    if (/(yasak|geri cagir|ceza|durdu|toplati)/i.test(bag)) {
        sentimentLabel = 'negative';
        sentimentScore = -0.88;
        severityScore = 0.94;
        relevanceScore = 0.97;
    } else if (/(sikayet|ariza|sorun|gecikme|memnuniyetsiz)/i.test(bag)) {
        sentimentLabel = 'negative';
        sentimentScore = Math.min(sentimentScore, -0.65);
        severityScore = Math.max(severityScore, 0.78);
    } else if (/(odul|rekor|yeni seri|tanitti|lansman|yatirim)/i.test(bag)) {
        sentimentLabel = 'positive';
        sentimentScore = Math.max(sentimentScore, 0.58);
        severityScore = Math.min(severityScore, 0.22);
    }

    if (/(traktor|tarim|hasat|ekim|bayi|servis|motor|tarla)/i.test(bag)) {
        relevanceScore = Math.max(relevanceScore, 0.84);
    }

    return {
        sentiment_label: sentimentLabel,
        sentiment_score: clampNumber(sentimentScore, -1, 1, 0),
        severity_score: clampNumber(severityScore, 0, 1, 0.2),
        relevance_score: clampNumber(relevanceScore, 0, 1, 0.72)
    };
}

function buildRecommendations(itemType = '', sentimentLabel = '', complaintArea = '') {
    const payload = {};

    if (itemType === 'launch') {
        payload.marketing = 'Lansmanin ilk haftasinda bayi videosu, teknik ozet ve saha testi icerigi ayni ritimde yayinlanmali.';
    }
    if (itemType === 'regulation') {
        payload.management = 'Resmi karar sinyali icin bayi, finansman ve saha ekiplerine tek sayfalik etki ozeti iletilmeli.';
    }
    if (itemType === 'complaint' || sentimentLabel === 'negative') {
        payload.aftersales = 'Negatif kayitlar icin servis kontrol listesi, parca bulunurlugu ve geri donus suresi birlikte izlenmeli.';
    }
    if (complaintArea === 'teknik') {
        payload.arge = 'Teknik ariza sinyallerinde model, kullanim kosulu ve parca grubu bazinda tekrar eden tema ayristirilmali.';
    }

    return payload;
}

function buildPack1BrandQueries(brand = {}) {
    const displayName = String(brand.name || '').trim();
    return [
        {
            family_code: 'news',
            search_query: `"${displayName}" traktor tarim`,
            workflow_code: 'media-watch-pack-1'
        },
        {
            family_code: 'official',
            search_query: `site:tarimorman.gov.tr OR site:resmigazete.gov.tr "${displayName}" traktor destek hibe karar`,
            workflow_code: 'media-watch-pack-1'
        },
        {
            family_code: 'video',
            search_query: `site:youtube.com "${displayName}" traktor`,
            workflow_code: 'media-watch-pack-1'
        }
    ];
}

function buildPack2BrandQueries(brand = {}) {
    const displayName = String(brand.name || '').trim();
    return [
        {
            family_code: 'complaint',
            search_query: `(site:sikayetvar.com OR site:cozummerkezi.com OR site:sikayetim.com) "${displayName}" traktor`,
            workflow_code: 'media-watch-pack-2'
        },
        {
            family_code: 'forum',
            search_query: `(site:trakkulup.net OR site:tarimziraat.com OR site:donanimhaber.com OR site:forum* ) "${displayName}" traktor`,
            workflow_code: 'media-watch-pack-2'
        },
        {
            family_code: 'social',
            search_query: `(site:youtube.com OR site:x.com OR site:instagram.com OR site:facebook.com) "${displayName}" traktor`,
            workflow_code: 'media-watch-pack-2'
        },
        {
            family_code: 'complaint',
            search_query: `"${displayName}" traktor (sikayet OR ariza OR servis OR garanti OR "yedek parca")`,
            workflow_code: 'media-watch-pack-2'
        }
    ];
}

function buildPack3BrandQueries(brand = {}) {
    const displayName = String(brand.name || '').trim();
    const socialLinks = Array.isArray(parseJsonSafe(brand.social_links_json, []))
        ? parseJsonSafe(brand.social_links_json, []).filter(Boolean)
        : [];
    const queries = [];
    const seen = new Set();

    const pushQuery = (familyCode, searchQuery) => {
        const query = String(searchQuery || '').trim();
        if (!query || seen.has(`${familyCode}|${query}`)) return;
        seen.add(`${familyCode}|${query}`);
        queries.push({
            family_code: familyCode,
            search_query: query,
            workflow_code: 'media-watch-pack-3'
        });
    };

    socialLinks.forEach(entry => {
        const platform = normalizeSocialPlatform(entry);
        const handle = normalizeSocialHandle(entry);
        const host = normalizeUrlHost(entry.url || '');
        if (!host) return;

        if (platform === 'youtube') {
            pushQuery('official-video', `site:${host} "${handle || displayName}" "${displayName}" traktor`);
            return;
        }

        pushQuery('official-social', `site:${host} "${handle || displayName}" "${displayName}" traktor`);
    });

    const websiteHost = normalizeUrlHost(brand.website_url || '');
    if (websiteHost) {
        pushQuery('official-web', `site:${websiteHost} "${displayName}" traktor`);
    }

    const portalHost = normalizeUrlHost(brand.portal_url || '');
    if (portalHost && portalHost !== websiteHost) {
        pushQuery('official-web', `site:${portalHost} "${displayName}" traktor`);
    }

    if (!queries.length) {
        pushQuery('official-social', `(site:youtube.com OR site:instagram.com OR site:facebook.com OR site:x.com) "${displayName}" traktor`);
        pushQuery('official-web', `"${displayName}" resmi site traktor`);
    }

    return queries.slice(0, 6);
}

function buildBrandQueries(packCode = 'pack-1', brand = {}) {
    if (packCode === 'pack-2') return buildPack2BrandQueries(brand);
    if (packCode === 'pack-3') return buildPack3BrandQueries(brand);
    return buildPack1BrandQueries(brand);
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Traktor-Media-Watch-Bridge/1.0'
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error('Yanıt çok büyük');
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw new Error('Yanıt çok büyük');
    if (FETCH_DELAY_MS) await sleep(FETCH_DELAY_MS);
    return buf.toString('utf8');
}

function parseRssItems(xml = '', context = {}) {
    const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

    return itemBlocks.map(block => {
        const title = stripHtml(extractTag(block, 'title'));
        const description = stripHtml(extractTag(block, 'description'));
        const link = extractTag(block, 'link');
        const pubDate = extractTag(block, 'pubDate');
        const source = extractSource(block);
        const familyMeta = normalizeFamilyMeta(context.family_code, title, description);
        const bag = `${title} ${description}`.toLocaleLowerCase('tr-TR');
        const scores = inferSignalScores(familyMeta, title, description);
        const sourceUrl = source.url || link || '';
        let sourceDomain = '';

        if (sourceUrl) {
            try {
                sourceDomain = new URL(sourceUrl).hostname;
            } catch {
                sourceDomain = '';
            }
        }

        const issueType = inferIssueType(bag);
        const complaintArea = inferComplaintArea(bag);

        return {
            brand_id: context.brand_id,
            brand_name: context.brand_name,
            brand_slug: context.brand_slug,
            source_name: source.title || 'Google News',
            source_domain: sourceDomain || 'news.google.com',
            source_url: link || sourceUrl || buildGoogleNewsUrl(context.search_query || context.brand_name),
            channel_type: familyMeta.channel_type,
            item_type: familyMeta.item_type,
            platform_name: familyMeta.platform_name,
            title,
            summary: description,
            content_text: description,
            published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
            sentiment_label: scores.sentiment_label,
            sentiment_score: scores.sentiment_score,
            severity_score: scores.severity_score,
            relevance_score: scores.relevance_score,
            complaint_area: complaintArea,
            issue_type: issueType,
            tags: [context.family_code, context.brand_slug].filter(Boolean),
            topics: buildTopicTags(context.family_code, title, description),
            recommendations: buildRecommendations(familyMeta.item_type, scores.sentiment_label, complaintArea),
            raw_payload: {
                bridge_source: 'google-news-rss',
                family_code: context.family_code,
                query: context.search_query
            }
        };
    }).filter(item => item.title && item.source_url);
}

function dedupeByLink(items = []) {
    const seen = new Set();
    return items.filter(item => {
        const key = `${item.source_url}|${item.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function loadBrands(filters = {}) {
    const params = [];
    let where = 'WHERE b.is_active = true';

    if (filters.brand_id) {
        params.push(Number(filters.brand_id));
        where += ` AND b.id = $${params.length}`;
    }

    if (filters.brand_name) {
        params.push(String(filters.brand_name));
        where += ` AND UPPER(b.name) = UPPER($${params.length})`;
    }

    const result = await pool.query(`
        SELECT
            b.id,
            b.name,
            b.slug,
            COALESCE(p.website_url, b.website, '') AS website_url,
            COALESCE(p.portal_url, '') AS portal_url,
            COALESCE(p.social_links_json, '[]'::jsonb) AS social_links_json
        FROM brands b
        LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
        ${where}
        ORDER BY b.name
    `, params);

    return result.rows;
}

// Her çalıştırmada en fazla maxBrands marka taranır; belirli bir marka istenmediyse pencere dönüşümlüdür,
// böylece 12'den fazla marka olsa da hepsi zamanla taranır (eskiden hep alfabetik ilk 12 markaydı).
const brandCursor = new Map();
function pickBrandWindow(brands, maxBrands, packCode, explicit = false) {
    if (explicit || brands.length <= maxBrands) return brands.slice(0, maxBrands);
    const start = (brandCursor.get(packCode) || 0) % brands.length;
    const window = [];
    for (let i = 0; i < maxBrands; i++) window.push(brands[(start + i) % brands.length]);
    brandCursor.set(packCode, (start + maxBrands) % brands.length);
    return window;
}

async function collectPackPayloads(packCode = 'pack-1', options = {}) {
    const limitPerFamily = Math.max(2, Math.min(10, Number(options.limit_per_family || options.limitPerFamily || 4)));
    const maxBrands = Math.max(1, Math.min(30, Number(options.max_brands || options.maxBrands || 12)));
    const brands = pickBrandWindow(await loadBrands({
        brand_id: options.brand_id || options.brandId || '',
        brand_name: options.brand_name || options.brandName || ''
    }), maxBrands, packCode, !!(options.brand_id || options.brandId || options.brand_name || options.brandName));

    if (brands.length === 0) {
        return [];
    }

    const payloads = [];

    for (const brand of brands) {
        const queries = buildBrandQueries(packCode, brand);
        const collected = [];

        for (const family of queries) {
            try {
                const xml = await fetchText(buildGoogleNewsUrl(family.search_query));
                const allParsed = parseRssItems(xml, {
                    ...family,
                    brand_id: brand.id,
                    brand_name: brand.name,
                    brand_slug: brand.slug
                });
                // CRITICAL: Google News agresif eşleşme yapıyor — başlık/özet'te marka adı veya alias
                // geçmeyen kayıtları ele (false-positive önleme: ör. John Deere q'su Frutteto TR
                // videosu döndürüyor — Frutteto SAME/Deutz modeli, John Deere ile alakasız).
                const parsed = allParsed
                    .filter(it => brandMatchesText(brand, it.title, it.summary, it.content_text))
                    .slice(0, limitPerFamily);

                collected.push(...parsed);
            } catch (err) {
                noteError(packCode, `${brand.slug}/${family.family_code}`, err);
                const familyMeta = normalizeFamilyMeta(family.family_code, '', '');
                collected.push({
                    brand_id: brand.id,
                    brand_name: brand.name,
                    brand_slug: brand.slug,
                    source_name: 'Media Watch Bridge',
                    source_domain: 'host-bridge',
                    source_url: buildGoogleNewsUrl(family.search_query),
                    channel_type: familyMeta.channel_type,
                    item_type: familyMeta.item_type,
                    platform_name: familyMeta.platform_name || 'bridge',
                    title: `${brand.name} icin ${family.family_code} akisinda hata`,
                    summary: `Bridge ${family.family_code} akisini okuyamadi: ${err.message}`,
                    content_text: `Bridge ${family.family_code} akisini okuyamadi: ${err.message}`,
                    published_at: new Date().toISOString(),
                    sentiment_label: 'mixed',
                    sentiment_score: -0.1,
                    severity_score: 0.42,
                    relevance_score: 0.9,
                    tags: ['bridge-error', family.family_code],
                    topics: ['bridge-error'],
                    recommendations: {
                        operations: 'Kaynak erisimi ve DNS kontrol edilmeli.'
                    },
                    raw_payload: {
                        bridge_source: 'google-news-rss',
                        family_code: family.family_code,
                        query: family.search_query,
                        error: err.message
                    }
                });
            }
        }

        const deduped = dedupeByLink(collected);
        payloads.push({
            brand_id: brand.id,
            brand_name: brand.name,
            brand_slug: brand.slug,
            workflow_code: `media-watch-${packCode}`,
            run_key: `media-watch-${packCode}-${brand.slug}-${Date.now()}`,
            status: 'completed',
            trigger_source: 'media-watch-bridge',
            item_count: deduped.length,
            meta: {
                source_pack: packCode,
                families: queries.map(item => item.family_code),
                bridge_collected_at: new Date().toISOString()
            },
            items: deduped
        });
    }

    return payloads;
}

// ============================================
// DOĞRUDAN RSS — registry kaynaklarını her marka için tara, eşleşenleri çıkar
// ============================================
function brandMatchesText(brand, ...texts) {
    const aliases = [String(brand.name || '').trim()];
    if (brand.slug) aliases.push(String(brand.slug).replace(/-/g, ' '));
    // Marka için yaygın varyantlar (örn. CASE → "Case IH", DEUTZ → "Deutz-Fahr")
    const ALIAS_MAP = {
        'CASE': ['Case IH', 'CaseIH', 'Case Construction'],
        'CASE IH': ['Case IH', 'CaseIH', 'CNH', 'CNHi'],
        'DEUTZ': ['Deutz-Fahr', 'DeutzFahr', 'SDF Deutz', 'SDF', 'SAME Deutz'],
        'DEUTZ-FAHR': ['Deutz-Fahr', 'DeutzFahr', 'SDF', 'SAME Deutz-Fahr'],
        'KİOTİ': ['Kioti', 'Daedong'],
        'KIOTI': ['Kioti', 'Daedong'],
        'NEW HOLLAND': ['NewHolland', 'New-Holland', 'New Holland TR', 'TürkTraktör', 'TurkTraktor', 'CNH', 'CNHi'],
        'JOHN DEERE': ['Deere', 'JohnDeere', 'John-Deere', 'JD Türkiye'],
        'MASSEY FERGUSON': ['MF', 'AGCO Massey', 'AGCO MF', 'Massey-Ferguson', 'AGCO'],
        'VALTRA': ['AGCO Valtra'],
        'FENDT': ['AGCO Fendt'],
        'CHALLENGER': ['AGCO Challenger'],
        'CLAAS': ['CLAAS Tractors', 'CLAAS Türkiye'],
        'TÜMOSAN': ['Tumosan', 'TUMOSAN'],
        'TÜRKTRAKTÖR': ['TurkTraktor', 'Türk Traktör', 'Turk Traktor', 'CNH'],
        'ERKUNT': ['Erkunt Traktör', 'Erkunt Tractor'],
        'BAŞAK': ['Basak', 'Başak Traktör', 'Basak Tractor'],
        'HATTAT': ['Hattat Traktör', 'Hattat Tarım', 'Hattat Tarim', 'Hattat Tractor'],
        'ARMATRAC': ['ArmaTrac', 'Erkunt Armatrac'],
        'BMC': ['BMC Tarım', 'BMC Tractor', 'BMC Sanayi'],
        'UZEL': ['Uzel Traktör', 'Uzel Makina'],
        'ANTONIO CARRARO': ['AntonioCarraro', 'A. Carraro'],
        'KUBOTA': ['Kubota Türkiye', 'Kubota Tractor'],
        'SAME': ['SAME Tractors', 'SAME Deutz', 'SDF SAME'],
        'LAMBORGHINI': ['Lamborghini Trattori', 'Lamborghini Tractor'],
        'LANDINI': ['Landini Türkiye', 'Argo Landini'],
        'MCCORMICK': ['McCormick', 'Argo McCormick'],
        'GOLDONI': ['Goldoni Türkiye'],
        'FOTON': ['Foton Lovol', 'Foton Türkiye'],
        'YTO': ['YTO Tractor', 'YTO Türkiye'],
        'SOLIS': ['Solis Tractor', 'Solis Türkiye'],
        'MAHINDRA': ['Mahindra Tractor', 'Mahindra Türkiye'],
        'TAFE': ['TAFE Tractor', 'TAFE Türkiye'],
        'STEYR': ['Steyr Tractor', 'CNH Steyr']
    };
    const upperName = String(brand.name || '').toUpperCase();
    if (ALIAS_MAP[upperName]) aliases.push(...ALIAS_MAP[upperName]);
    const haystack = texts.filter(Boolean).join(' ').toLowerCase();
    return aliases.some(a => {
        const al = String(a).trim().toLowerCase();
        if (!al) return false;
        // Tam kelime eşleşmesi (false positive önleme)
        const re = new RegExp(`\\b${al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        return re.test(haystack);
    });
}

async function collectFromRegistrySources(packCode, brand, registry, options = {}) {
    const limitPerSource = Math.max(1, Math.min(8, Number(options.limit_per_source || 3)));
    const items = [];
    for (const source of registry) {
        try {
            const cache = options._feedCache;
            let feed = cache && cache.get(source.rss);
            if (!feed) {
                feed = fetchText(source.rss);
                if (cache) cache.set(source.rss, feed);
            }
            const xml = await feed;
            const parsed = parseRssItems(xml, {
                family_code: source.category || 'news',
                brand_id: brand.id,
                brand_name: brand.name,
                brand_slug: brand.slug,
                search_query: source.name
            });
            // Marka adı eşleşen son N kaydı al
            const matched = parsed
                .filter(it => brandMatchesText(brand, it.title, it.summary, it.content_text))
                .slice(0, limitPerSource)
                .map(it => ({
                    ...it,
                    source_name: source.name,
                    source_domain: (() => { try { return new URL(source.rss).hostname; } catch { return source.code; } })(),
                    language: source.language,
                    country_code: source.country,
                    raw_payload: {
                        ...it.raw_payload,
                        bridge_source: `direct-rss-${packCode}`,
                        source_code: source.code,
                        source_language: source.language,
                        source_country: source.country
                    }
                }));
            items.push(...matched);
        } catch (err) {
            // Bir kaynak çökerse diğerleri çalışsın; hata çalıştırma özetine yazılır
            noteError(packCode, source.code, err);
            console.warn(`[${packCode}] ${source.code} okunamadı: ${err.message}`);
        }
    }
    return items;
}

async function collectPack4Payloads(options = {}) {
    return collectRegistryPackPayloads('pack-4', INTERNATIONAL_SOURCE_REGISTRY, options);
}
async function collectPack5Payloads(options = {}) {
    return collectRegistryPackPayloads('pack-5', SECTOR_PUBLICATIONS_REGISTRY, options);
}

async function collectRegistryPackPayloads(packCode, registry, options = {}) {
    const maxBrands = Math.max(1, Math.min(30, Number(options.max_brands || 12)));
    const brands = pickBrandWindow(await loadBrands({
        brand_id: options.brand_id || '',
        brand_name: options.brand_name || ''
    }), maxBrands, packCode, !!(options.brand_id || options.brand_name));

    if (brands.length === 0) return [];
    const payloads = [];
    const sharedOptions = { ...options, _feedCache: new Map() };

    for (const brand of brands) {
        const items = await collectFromRegistrySources(packCode, brand, registry, sharedOptions);
        const deduped = dedupeByLink(items);
        payloads.push({
            brand_id: brand.id,
            brand_name: brand.name,
            brand_slug: brand.slug,
            workflow_code: `media-watch-${packCode}`,
            run_key: `media-watch-${packCode}-${brand.slug}-${Date.now()}`,
            status: 'completed',
            trigger_source: 'media-watch-bridge',
            item_count: deduped.length,
            meta: {
                source_pack: packCode,
                source_count: registry.length,
                languages: Array.from(new Set(registry.map(s => s.language))),
                countries: Array.from(new Set(registry.map(s => s.country))),
                bridge_collected_at: new Date().toISOString()
            },
            items: deduped
        });
    }
    return payloads;
}

// ============================================
// PACK 6 — OEM resmi basın (Google News site: ile, marka grubu)
// ============================================
function buildPack6BrandQueries(brand = {}) {
    const displayName = String(brand.name || '').trim();
    const slug = String(brand.slug || '').toLowerCase();
    const queries = [];
    // Marka grubu eşleşmesi (parent OEM patterns)
    for (const [group, patterns] of Object.entries(OEM_PRESS_PATTERNS)) {
        if (slug.includes(group) || displayName.toLowerCase().includes(group)) {
            patterns.forEach(p => queries.push({
                family_code: 'official-press',
                search_query: `${p} "${displayName}"`,
                workflow_code: 'media-watch-pack-6'
            }));
        }
    }
    // Fallback: marka adı + press release
    if (queries.length === 0) {
        queries.push({
            family_code: 'official-press',
            search_query: `"${displayName}" press release news announcement tractor`,
            workflow_code: 'media-watch-pack-6'
        });
    }
    return queries.slice(0, 3);
}

async function collectPack6Payloads(options = {}) {
    const maxBrands = Math.max(1, Math.min(30, Number(options.max_brands || 12)));
    const brands = pickBrandWindow(await loadBrands({
        brand_id: options.brand_id || '',
        brand_name: options.brand_name || ''
    }), maxBrands, 'pack-6', !!(options.brand_id || options.brand_name));
    if (brands.length === 0) return [];

    const payloads = [];
    for (const brand of brands) {
        const queries = buildPack6BrandQueries(brand);
        const collected = [];
        for (const family of queries) {
            try {
                const xml = await fetchText(buildGoogleNewsUrl(family.search_query));
                const parsed = parseRssItems(xml, {
                    ...family,
                    brand_id: brand.id,
                    brand_name: brand.name,
                    brand_slug: brand.slug
                }).slice(0, 4);
                collected.push(...parsed.map(it => ({
                    ...it,
                    raw_payload: { ...it.raw_payload, bridge_source: 'oem-press-google-news' }
                })));
            } catch (err) {
                noteError('pack-6', `${brand.slug}/${family.family_code}`, err);
                console.warn(`[pack-6] ${brand.slug}/${family.family_code} hatası: ${err.message}`);
            }
        }
        const deduped = dedupeByLink(collected);
        payloads.push({
            brand_id: brand.id,
            brand_name: brand.name,
            brand_slug: brand.slug,
            workflow_code: 'media-watch-pack-6',
            run_key: `media-watch-pack-6-${brand.slug}-${Date.now()}`,
            status: 'completed',
            trigger_source: 'media-watch-bridge',
            item_count: deduped.length,
            meta: {
                source_pack: 'pack-6',
                families: queries.map(q => q.family_code),
                bridge_collected_at: new Date().toISOString()
            },
            items: deduped
        });
    }
    return payloads;
}

function buildBasicAuthHeader() {
    if (!N8N_BASIC_AUTH_USER || !N8N_BASIC_AUTH_PASSWORD) return null;
    return `Basic ${Buffer.from(`${N8N_BASIC_AUTH_USER}:${N8N_BASIC_AUTH_PASSWORD}`).toString('base64')}`;
}

async function postSinglePayloadToN8n(payload = {}, packCode = 'pack-1') {
    const headers = { 'Content-Type': 'application/json' };
    const basicAuth = buildBasicAuthHeader();
    if (basicAuth) headers.Authorization = basicAuth;
    const webhookUrl = resolveN8nWebhookUrl(packCode);

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(FETCH_TIMEOUT_MS, 20000))
    });

    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text || null;
    }

    if (!response.ok) {
        throw new Error(`n8n webhook HTTP ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    return parsed;
}

async function pushPayloadsToN8n(payloads = [], packCode = 'pack-1') {
    const responses = [];
    for (const payload of payloads) {
        const result = await postSinglePayloadToN8n(payload, packCode);
        responses.push({
            brand_id: payload.brand_id,
            brand_name: payload.brand_name,
            response: result
        });
    }
    return responses;
}

async function postJsonToApp(path = '', body = {}) {
    const url = `${APP_BASE_URL}${path}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-media-watch-key': MEDIA_WATCH_KEY
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(FETCH_TIMEOUT_MS, 25000))
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text || null; }
    if (!response.ok) {
        throw new Error(`App ${path} HTTP ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }
    return parsed;
}

async function pushPayloadsDirectToApp(payloads = [], packCode = 'pack-1') {
    const responses = [];
    const seenBrands = new Set();
    for (const payload of payloads) {
        try {
            const ingestResult = await postJsonToApp('/api/media-watch/ingest', payload);
            const runId = ingestResult?.run_id || null;
            ingestStats.ok++;
            ingestStats.inserted += Number(ingestResult?.inserted_count || 0);
            const brandId = ingestResult?.brand_id || payload.brand_id;
            responses.push({
                brand_id: brandId,
                brand_name: payload.brand_name,
                inserted_count: ingestResult?.inserted_count || 0,
                run_id: runId
            });
            if (brandId && !seenBrands.has(String(brandId))) {
                seenBrands.add(String(brandId));
                postJsonToApp('/api/media-watch/alerts/refresh', { brand_id: brandId, run_id: runId, window_days: 30 })
                    .catch(err => console.warn(`Alerts refresh skipped for brand ${brandId}: ${err.message}`));
                postJsonToApp('/api/media-watch/brief/refresh', { brand_id: brandId, window_days: 14, created_by: 'bridge' })
                    .catch(err => console.warn(`Brief refresh skipped for brand ${brandId}: ${err.message}`));
            }
        } catch (err) {
            ingestStats.failed++;
            const hint = /HTTP 401/.test(err.message) ? ' — Webhook anahtarı reddedildi: MEDIA_WATCH_WEBHOOK_KEY değeri kontrol edilmeli' : '';
            noteError('ingest', payload.brand_slug || payload.brand_name || payload.brand_id, err.message + hint);
            console.error(`Direct ingest failed for ${payload.brand_name || payload.brand_id}:`, err.message);
            responses.push({
                brand_id: payload.brand_id,
                brand_name: payload.brand_name,
                error: err.message
            });
        }
    }
    return responses;
}

async function runPackAndPush(packCode = 'pack-1', options = {}) {
    let payloads;
    if (packCode === 'pack-4') payloads = await collectPack4Payloads(options);
    else if (packCode === 'pack-5') payloads = await collectPack5Payloads(options);
    else if (packCode === 'pack-6') payloads = await collectPack6Payloads(options);
    else payloads = await collectPackPayloads(packCode, options);

    if (payloads.length === 0) {
        return {
            success: true,
            pack_code: packCode,
            payload_count: 0,
            item_count: 0,
            brands: [],
            mode: DIRECT_MODE ? 'direct' : 'n8n',
            response: null
        };
    }

    const response = DIRECT_MODE
        ? await pushPayloadsDirectToApp(payloads, packCode)
        : await pushPayloadsToN8n(payloads, packCode);

    return {
        success: true,
        pack_code: packCode,
        payload_count: payloads.length,
        item_count: payloads.reduce((total, payload) => total + Number(payload.item_count || 0), 0),
        brands: payloads.map(payload => ({
            brand_id: payload.brand_id,
            brand_name: payload.brand_name,
            item_count: payload.item_count
        })),
        mode: DIRECT_MODE ? 'direct' : 'n8n',
        response
    };
}

async function runEnabledPacksAndPush(options = {}) {
    if (runState.in_flight) throw Object.assign(new Error('Tarama zaten sürüyor'), { code: 'IN_FLIGHT' });
    runState.in_flight = true;
    runState.started_at = new Date().toISOString();
    runErrors = [];
    ingestStats = { ok: 0, failed: 0, inserted: 0 };
    const t0 = Date.now();
    try {
        const result = await runEnabledPacksAndPushInner(options);
        runState.last = {
            started_at: runState.started_at, finished_at: new Date().toISOString(), duration_ms: Date.now() - t0, ok: true,
            packs: result.packs, payload_count: result.payload_count, item_count: result.item_count,
            ingest_ok: ingestStats.ok, ingest_failed: ingestStats.failed, inserted_count: ingestStats.inserted,
            error_count: runErrors.length, errors: runErrors.slice(0, 10)
        };
        return result;
    } catch (err) {
        runState.last = {
            started_at: runState.started_at, finished_at: new Date().toISOString(), duration_ms: Date.now() - t0, ok: false,
            error: String(err.message || err).slice(0, 200), error_count: runErrors.length, errors: runErrors.slice(0, 10)
        };
        throw err;
    } finally {
        runState.in_flight = false;
    }
}

async function runEnabledPacksAndPushInner(options = {}) {
    const packs = BRIDGE_PACKS.length ? BRIDGE_PACKS : ['pack-1'];
    const results = [];

    for (const packCode of packs) {
        results.push(await runPackAndPush(packCode, options));
    }

    return {
        success: true,
        packs,
        payload_count: results.reduce((total, item) => total + Number(item.payload_count || 0), 0),
        item_count: results.reduce((total, item) => total + Number(item.item_count || 0), 0),
        results
    };
}

// Uzun süren taramayı arka planda başlatır (istemci beklemez): 202 {started:true}; zaten sürüyorsa 409.
function startInBackground(res, options) {
    if (runState.in_flight) return res.status(409).json({ error: 'Tarama zaten sürüyor', started_at: runState.started_at });
    runEnabledPacksAndPush(options)
        .then(r => console.log(`Media watch bridge tarama tamamlandi. Payload: ${r.payload_count}, kayit: ${r.item_count}, hata: ${runErrors.length}`))
        .catch(err => console.error('Media watch bridge tarama hatasi:', err.message));
    return res.status(202).json({ started: true, started_at: runState.started_at });
}
const wantsAsync = req => req.body?.async === true || req.query?.async === '1';

app.get('/api/media-watch/status', (req, res) => {
    res.json({ in_flight: runState.in_flight, started_at: runState.started_at, last: runState.last, schedule: BRIDGE_SCHEDULE, autorun: BRIDGE_AUTORUN, packs: BRIDGE_PACKS });
});

app.get('/health', async (req, res) => {
    res.json({
        ok: true,
        bridge: 'media-watch',
        url: `http://${HOST}:${PORT}`,
        mode: DIRECT_MODE ? 'direct' : 'n8n',
        app_target: DIRECT_MODE ? `${APP_BASE_URL}/api/media-watch/ingest` : null,
        enabled_packs: BRIDGE_PACKS,
        registries: {
            international_sources: INTERNATIONAL_SOURCE_REGISTRY.length,
            sector_publications: SECTOR_PUBLICATIONS_REGISTRY.length,
            oem_press_groups: Object.keys(OEM_PRESS_PATTERNS).length,
            languages: Array.from(new Set([
                ...INTERNATIONAL_SOURCE_REGISTRY.map(s => s.language),
                ...SECTOR_PUBLICATIONS_REGISTRY.map(s => s.language)
            ])),
            countries: Array.from(new Set([
                ...INTERNATIONAL_SOURCE_REGISTRY.map(s => s.country),
                ...SECTOR_PUBLICATIONS_REGISTRY.map(s => s.country)
            ]))
        },
        n8n_webhook_urls: DIRECT_MODE ? null : DEFAULT_N8N_WEBHOOK_URLS,
        autorun: BRIDGE_AUTORUN,
        schedule: BRIDGE_SCHEDULE
    });
});

app.get('/api/media-watch/sources', (req, res) => {
    res.json({
        international: INTERNATIONAL_SOURCE_REGISTRY,
        sector: SECTOR_PUBLICATIONS_REGISTRY,
        oem_groups: OEM_PRESS_PATTERNS,
        total: INTERNATIONAL_SOURCE_REGISTRY.length + SECTOR_PUBLICATIONS_REGISTRY.length,
        languages: Array.from(new Set([
            ...INTERNATIONAL_SOURCE_REGISTRY.map(s => s.language),
            ...SECTOR_PUBLICATIONS_REGISTRY.map(s => s.language)
        ])),
        countries: Array.from(new Set([
            ...INTERNATIONAL_SOURCE_REGISTRY.map(s => s.country),
            ...SECTOR_PUBLICATIONS_REGISTRY.map(s => s.country)
        ]))
    });
});

// Yeni paketler için kısayol endpoint'leri
['pack-4', 'pack-5', 'pack-6'].forEach(packCode => {
    app.post(`/api/media-watch/push-${packCode}`, async (req, res) => {
        try {
            const result = await runPackAndPush(packCode, { ...req.query, ...req.body });
            res.json(result);
        } catch (err) {
            console.error(`Bridge push-${packCode} error:`, err);
            res.status(500).json({ error: err.message || 'Bridge push hatasi' });
        }
    });
    app.post(`/api/media-watch/source-${packCode}`, async (req, res) => {
        try {
            let payloads;
            if (packCode === 'pack-4') payloads = await collectPack4Payloads({ ...req.query, ...req.body });
            else if (packCode === 'pack-5') payloads = await collectPack5Payloads({ ...req.query, ...req.body });
            else if (packCode === 'pack-6') payloads = await collectPack6Payloads({ ...req.query, ...req.body });
            res.json(payloads || []);
        } catch (err) {
            console.error(`Bridge source-${packCode} error:`, err);
            res.status(500).json({ error: err.message || 'Bridge source hatasi' });
        }
    });
});

app.post('/api/media-watch/source-pack-1', async (req, res) => {
    try {
        const payloads = await collectPackPayloads('pack-1', {
            ...req.query,
            ...req.body
        });
        res.json(payloads);
    } catch (err) {
        console.error('Media watch bridge pack-1 error:', err);
        res.status(500).json({ error: err.message || 'Bridge hatasi' });
    }
});

app.post('/api/media-watch/push-pack-1', async (req, res) => {
    try {
        const result = await runPackAndPush('pack-1', {
            ...req.query,
            ...req.body
        });
        res.json(result);
    } catch (err) {
        console.error('Media watch bridge push-pack-1 error:', err);
        res.status(500).json({ error: err.message || 'Bridge push hatasi' });
    }
});

app.post('/api/media-watch/source-pack-2', async (req, res) => {
    try {
        const payloads = await collectPackPayloads('pack-2', {
            ...req.query,
            ...req.body
        });
        res.json(payloads);
    } catch (err) {
        console.error('Media watch bridge pack-2 error:', err);
        res.status(500).json({ error: err.message || 'Bridge hatasi' });
    }
});

app.post('/api/media-watch/push-pack-2', async (req, res) => {
    try {
        const result = await runPackAndPush('pack-2', {
            ...req.query,
            ...req.body
        });
        res.json(result);
    } catch (err) {
        console.error('Media watch bridge push-pack-2 error:', err);
        res.status(500).json({ error: err.message || 'Bridge push hatasi' });
    }
});

app.post('/api/media-watch/source-pack-3', async (req, res) => {
    try {
        const payloads = await collectPackPayloads('pack-3', {
            ...req.query,
            ...req.body
        });
        res.json(payloads);
    } catch (err) {
        console.error('Media watch bridge pack-3 error:', err);
        res.status(500).json({ error: err.message || 'Bridge hatasi' });
    }
});

app.post('/api/media-watch/push-pack-3', async (req, res) => {
    try {
        const result = await runPackAndPush('pack-3', {
            ...req.query,
            ...req.body
        });
        res.json(result);
    } catch (err) {
        console.error('Media watch bridge push-pack-3 error:', err);
        res.status(500).json({ error: err.message || 'Bridge push hatasi' });
    }
});

app.post('/api/media-watch/push-all', async (req, res) => {
    try {
        if (wantsAsync(req)) return startInBackground(res, { ...req.query, ...req.body });
        const result = await runEnabledPacksAndPush({
            ...req.query,
            ...req.body
        });
        res.json(result);
    } catch (err) {
        if (err.code === 'IN_FLIGHT') return res.status(409).json({ error: err.message });
        console.error('Media watch bridge push-all error:', err);
        res.status(500).json({ error: err.message || 'Bridge push hatasi' });
    }
});

function start() {
    if (!process.env.DATABASE_URL) {
        console.error('[FATAL] DATABASE_URL env tanimsiz');
        process.exit(1);
    }
    if (DIRECT_MODE && !MEDIA_WATCH_KEY) {
        console.error('[UYARI] MEDIA_WATCH_WEBHOOK_KEY tanimsiz: uygulama ingest isteklerini reddedecek, hicbir haber kaydedilmeyecek.');
    }
    app.listen(PORT, HOST, () => {
        console.log(`Media watch bridge hazir: http://${HOST}:${PORT}`);
        console.log(`Mod: ${DIRECT_MODE ? `DIRECT (n8n bypass) → ${APP_BASE_URL}/api/media-watch/ingest` : 'N8N webhook'}`);
        if (!DIRECT_MODE) {
            console.log(`n8n webhook hedefleri: ${JSON.stringify({
                'pack-1': resolveN8nWebhookUrl('pack-1'),
                'pack-2': resolveN8nWebhookUrl('pack-2'),
                'pack-3': resolveN8nWebhookUrl('pack-3')
            })}`);
        }

        if (BRIDGE_AUTORUN && cron.validate(BRIDGE_SCHEDULE)) {
            console.log(`Media watch bridge autorun aktif: ${BRIDGE_SCHEDULE}`);
            cron.schedule(BRIDGE_SCHEDULE, async () => {
                if (autorunInFlight) {
                    console.log('Media watch bridge autorun atlandi: onceki kosu devam ediyor.');
                    return;
                }

                autorunInFlight = true;
                try {
                    const result = await runEnabledPacksAndPush({});
                    console.log(`Media watch bridge autorun tamamlandi. Payload: ${result.payload_count}, kayit: ${result.item_count}, paketler: ${result.packs.join(', ')}`);
                } catch (err) {
                    console.error('Media watch bridge autorun error:', err);
                } finally {
                    autorunInFlight = false;
                }
            });
        } else if (BRIDGE_AUTORUN) {
            console.warn(`Media watch bridge autorun etkin ama cron ifadesi gecersiz: ${BRIDGE_SCHEDULE}`);
        }

        // Açılışta (deploy sonrası) son 6 saatte hiç kayıt toplanmadıysa bir ilk tarama yap: sayfa saatlerce boş kalmasın.
        if (BRIDGE_AUTORUN && String(process.env.MEDIA_WATCH_BRIDGE_RUN_ON_START || 'true').toLowerCase() === 'true') {
            setTimeout(async () => {
                if (autorunInFlight) return;
                try {
                    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM media_watch_items WHERE collected_at >= NOW() - INTERVAL '6 hours'`);
                    if (r.rows[0].n > 0) return;
                    autorunInFlight = true;
                    const result = await runEnabledPacksAndPush({});
                    console.log(`Media watch bridge ilk tarama tamamlandi. Payload: ${result.payload_count}, kayit: ${result.item_count}`);
                } catch (err) {
                    console.error('Media watch bridge ilk tarama hatasi:', err.message);
                } finally {
                    autorunInFlight = false;
                }
            }, Math.max(5000, Number(process.env.MEDIA_WATCH_BRIDGE_START_DELAY_MS || 60000))).unref();
        }
    });
}

module.exports = {
    app, runPackAndPush, runEnabledPacksAndPush, parseRssItems, brandMatchesText, normalizeFamilyMeta, inferSignalScores, buildTopicTags, dedupeByLink,
    pickBrandWindow, INTERNATIONAL_SOURCE_REGISTRY, SECTOR_PUBLICATIONS_REGISTRY, OEM_PRESS_PATTERNS,
    buildPack1BrandQueries, buildPack2BrandQueries, buildPack3BrandQueries, buildPack6BrandQueries, collectFromRegistrySources
};

if (require.main === module) start();
