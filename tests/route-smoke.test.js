'use strict';
// Duman testi: tüm kimlik doğrulamalı GET rotalarını admin/superuser token'ıyla çağırır.
// Amaç doğruluk değil, dosya bölme/taşıma sonrası kırılan yardımcıları (ReferenceError,
// TypeError: x is not a function) yakalamak. Boş veritabanında 5xx dönmemeli.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

// Boş test veritabanında bilerek 5xx dönen rotalar: 'GET /yol': neden
const ALLOW_5XX = {};
const SKIP_PATHS = /webhook|\/public\/|\/export|\/download|\/stream|\/oauth|\/google/;

function getRoutes() {
    const out = [];
    for (const line of fs.readFileSync(path.join(__dirname, 'snapshots', 'routes.txt'), 'utf8').split('\n')) {
        const m = /^([A-Z,]+) (".*?"|\[.*?\]) \[(.*)\]$/.exec(line);
        if (!m || !m[1].split(',').includes('GET')) continue;
        const chain = m[3].split('>');
        if (chain[0] !== 'authMiddleware') continue;
        for (const p of (m[2].startsWith('[') ? JSON.parse(m[2]) : [JSON.parse(m[2])])) {
            if (!p.includes('*') && !SKIP_PATHS.test(p)) out.push(p.replace(/:[A-Za-z_]+/g, '1'));
        }
    }
    return [...new Set(out)];
}

describe('route smoke (GET, admin token)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin;
    before(async () => {
        s = await startServer();
        admin = await s.createUserWithToken({ role: 'admin' });
        // Boş veritabanında MAX(year) NaN olur ve birçok rota 500 döner; küçük bir örnek veri ekle.
        await s.pool.query(`
            INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
            SELECT b.id, p.id, y.year, m.month, 5 + (b.id + p.id + m.month) % 20, 'Tarla', 'Kabinli', '4WD', '70-90 HP', '12+12', 'test'
            FROM (SELECT id FROM brands ORDER BY id LIMIT 4) b,
                 (SELECT id FROM provinces ORDER BY id LIMIT 6) p,
                 (VALUES (2024), (2025)) y(year),
                 generate_series(1, 6) m(month)`);
        await s.pool.query(`
            INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet)
            SELECT b.name, 'TEST MODEL', y.year, m.month, p.id, p.name, y.year, 3 + (p.id + m.month) % 7
            FROM (SELECT name FROM brands ORDER BY id LIMIT 4) b,
                 (SELECT id, name FROM provinces ORDER BY id LIMIT 6) p,
                 (VALUES (2024), (2025)) y(year),
                 generate_series(1, 6) m(month)`);
    });
    after(async () => { if (s) await s.stop(); });

    it('hiçbir GET rotası 5xx dönmez ve sunucu ReferenceError/TypeError loglamaz', async () => {
        const routes = getRoutes();
        assert.ok(routes.length > 40, 'rota listesi beklenenden kısa');
        const bad = [];
        for (const p of routes) {
            const r = await s.api('GET', p, { token: admin.token });
            if (r.status >= 500 && !ALLOW_5XX['GET ' + p]) bad.push(`${r.status} GET ${p}`);
        }
        const logs = s.logs();
        const errs = logs.split('\n').filter(l => /ReferenceError|TypeError: .* is not a function/.test(l));
        assert.deepEqual(bad, [], 'Bu rotalar 5xx döndü');
        assert.deepEqual(errs.slice(0, 5), [], 'Sunucu loglarında kod hatası');
    });
});
