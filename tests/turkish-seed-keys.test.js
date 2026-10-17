'use strict';
// Türkçe karakterli marka portalı anahtarları (brand_portal_items.title, brand_portal_contacts.label/city).
// 1) Sunucu açılışında seed + migration sonrası satır sayıları seed dosyasıyla birebir eşit olmalı,
//    ASCII eski anahtar kalmamalı.
// 2) migration 011 eski ASCII satırları yerinde yeniden adlandırmalı; ikinci çalıştırma etkisiz olmalı.
// 3) Yeni anahtar zaten varsa eski satır silinmeli (çift kayıt oluşmamalı).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seed = require('../database/brand-portal-seed');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const MIGRATION_011 = fs.readFileSync(path.join(ROOT, 'database/migrations/011_turkish_seed_keys.sql'), 'utf8');

// Temsili OLD (ASCII) -> NEW (Türkçe) anahtar çiftleri.
const ITEM_PAIRS = [
    { type: 'news', old: 'BASAK Traktor AGROEXPO Izmirde yeni modellerini sergiledi', next: "BAŞAK Traktör AGROEXPO İzmir'de yeni modellerini sergiledi" },
    { type: 'product', old: 'Tarla ve bahce icin seri bazli urun kurgusu', next: 'Tarla ve bahçe için seri bazlı ürün kurgusu' },
    { type: 'network', old: '542 noktalik bayi ve servis haritasi', next: '542 noktalık bayi ve servis haritası' }
];
const CONTACT_PAIRS = [
    { type: 'factory', oldLabel: 'Konya fabrikasi', oldCity: 'Konya', newLabel: 'Konya fabrikası', newCity: 'Konya' },
    { type: 'network', oldLabel: 'Yurt ici bayi agi', oldCity: 'Turkiye', newLabel: 'Yurt içi bayi ağı', newCity: 'Türkiye' },
    { type: 'hq', oldLabel: 'Merkez ofis', oldCity: 'Istanbul', newLabel: 'Merkez ofis', newCity: 'İstanbul' }
];

function seedCounts() {
    const values = Object.values(seed);
    return {
        items: values.reduce((n, b) => n + (b.items || []).length, 0),
        contacts: values.reduce((n, b) => n + (b.contacts || []).length, 0)
    };
}

async function count(pool, sql, params = []) {
    const r = await pool.query(sql, params);
    return r.rows[0].n;
}

describe('turkish seed keys', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('seed sayıları DB ile eşit, eski ASCII anahtar kalmamış, yeni anahtarlar mevcut', async () => {
        const { pool } = s;
        const brands = await pool.query('SELECT id, slug FROM brands WHERE slug = ANY($1)', [Object.keys(seed)]);
        assert.equal(brands.rows.length, Object.keys(seed).length, 'seed markaları DB içinde olmalı');

        const expected = seedCounts();
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items'), expected.items);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts'), expected.contacts);

        for (const pair of ITEM_PAIRS) {
            assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE title = $1', [pair.old]), 0, `eski anahtar kalmış: ${pair.old}`);
            assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE title = $1', [pair.next]), 1, `yeni anahtar yok: ${pair.next}`);
        }
        for (const pair of CONTACT_PAIRS) {
            assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts WHERE label = $1 AND city = $2', [pair.oldLabel, pair.oldCity]), 0, `eski kişi anahtarı kalmış: ${pair.oldLabel}`);
            assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts WHERE label = $1 AND city = $2', [pair.newLabel, pair.newCity]), 1, `yeni kişi anahtarı yok: ${pair.newLabel}`);
        }

        // Tekrar yok: her (brand_id, item_type, title) ve (brand_id, contact_type, label, city) tek satır.
        assert.equal(await count(pool, `SELECT COUNT(*)::int AS n FROM (SELECT brand_id, item_type, title FROM brand_portal_items GROUP BY 1, 2, 3 HAVING COUNT(*) > 1) d`), 0);
        assert.equal(await count(pool, `SELECT COUNT(*)::int AS n FROM (SELECT brand_id, contact_type, label, city FROM brand_portal_contacts GROUP BY 1, 2, 3, 4 HAVING COUNT(*) > 1) d`), 0);
    });

    it('011 eski satırları yerinde yeniden adlandırır; ikinci çalıştırma etkisiz', async () => {
        const { pool } = s;
        const b = await pool.query(`INSERT INTO brands (name, slug) VALUES ('Test Marka 011A', 'test-marka-011a') RETURNING id`);
        const brandId = b.rows[0].id;
        await pool.query(`INSERT INTO brand_portal_items (brand_id, item_type, title) VALUES ($1, 'news', $2)`, [brandId, ITEM_PAIRS[0].old]);
        await pool.query(`INSERT INTO brand_portal_contacts (brand_id, contact_type, label, city) VALUES ($1, 'factory', $2, $3)`, [brandId, CONTACT_PAIRS[0].oldLabel, CONTACT_PAIRS[0].oldCity]);

        await pool.query(MIGRATION_011);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE brand_id = $1', [brandId]), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE brand_id = $1 AND title = $2', [brandId, ITEM_PAIRS[0].next]), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts WHERE brand_id = $1 AND label = $2 AND city = $3', [brandId, CONTACT_PAIRS[0].newLabel, CONTACT_PAIRS[0].newCity]), 1);

        const totalItems = await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items');
        const totalContacts = await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts');
        await pool.query(MIGRATION_011); // ikinci çalıştırma
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items'), totalItems);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts'), totalContacts);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE brand_id = $1 AND title = $2', [brandId, ITEM_PAIRS[0].next]), 1);
    });

    it('011: eski ve yeni anahtar birlikte varsa eski satır silinir, çift kayıt oluşmaz', async () => {
        const { pool } = s;
        const b = await pool.query(`INSERT INTO brands (name, slug) VALUES ('Test Marka 011B', 'test-marka-011b') RETURNING id`);
        const brandId = b.rows[0].id;
        await pool.query(`INSERT INTO brand_portal_items (brand_id, item_type, title) VALUES ($1, 'product', $2), ($1, 'product', $3)`, [brandId, ITEM_PAIRS[1].old, ITEM_PAIRS[1].next]);
        await pool.query(`INSERT INTO brand_portal_contacts (brand_id, contact_type, label, city) VALUES ($1, 'network', $2, $3), ($1, 'network', $4, $5)`,
            [brandId, CONTACT_PAIRS[1].oldLabel, CONTACT_PAIRS[1].oldCity, CONTACT_PAIRS[1].newLabel, CONTACT_PAIRS[1].newCity]);

        await pool.query(MIGRATION_011);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE brand_id = $1', [brandId]), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_items WHERE brand_id = $1 AND title = $2', [brandId, ITEM_PAIRS[1].old]), 0);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts WHERE brand_id = $1', [brandId]), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*)::int AS n FROM brand_portal_contacts WHERE brand_id = $1 AND label = $2 AND city = $3', [brandId, CONTACT_PAIRS[1].oldLabel, CONTACT_PAIRS[1].oldCity]), 0);
    });
});
