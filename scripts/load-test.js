'use strict';
// Yük testi: geçici DB + yerel sunucu (hız sınırı kapalı), örnek veriyle seçili rotalara eşzamanlı yük bindirir.
// Kullanım: TEST_DATABASE_URL=postgresql://... node scripts/load-test.js [bağlantı=50] [süre_sn=10]
// Çıktı: rota başına istek/sn, gecikme (ort/p99) ve hata sayısı. Üretime karşı ÇALIŞTIRMAYIN.
const autocannon = require('autocannon');
const { startServer, SKIP_DB } = require('../tests/helpers');

const CONNECTIONS = parseInt(process.argv[2] || '50', 10);
const DURATION = parseInt(process.argv[3] || '10', 10);
const ROUTES = ['/health', '/api/brands', '/api/provinces', '/api/dashboard', '/api/sales/summary',
    '/api/sales/historical', '/api/sales/by-province', '/api/sales/brand-summary', '/api/sales/regional-index'];

(async () => {
    if (SKIP_DB) { console.error('TEST_DATABASE_URL gerekli'); process.exit(1); }
    const s = await startServer({ env: { API_RATE_LIMIT_MAX: '100000000', NODE_ENV: 'production' } });
    try {
        const admin = await s.createUserWithToken({ role: 'admin' });
        await s.pool.query(`
            INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config, data_source)
            SELECT b.id, p.id, y.year, m.month, 5 + (b.id + p.id + m.month) % 20, 'Tarla', 'Kabinli', '4WD', '70-90 HP', '12+12', 'load'
            FROM (SELECT id FROM brands ORDER BY id) b, (SELECT id FROM provinces ORDER BY id) p,
                 (VALUES (2023), (2024), (2025)) y(year), generate_series(1, 12) m(month)`);
        await s.pool.query(`
            INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet)
            SELECT b.name, 'LOAD MODEL', y.year, m.month, p.id, p.name, y.year, 3 + (p.id + m.month) % 7
            FROM (SELECT name FROM brands ORDER BY id) b, (SELECT id, name FROM provinces ORDER BY id) p,
                 (VALUES (2023), (2024), (2025)) y(year), generate_series(1, 12) m(month)`);
        const rows = (await s.pool.query('SELECT COUNT(*)::int AS n FROM sales_data')).rows[0].n;
        console.log(`Veri: ${rows} satış satırı | ${CONNECTIONS} eşzamanlı bağlantı, ${DURATION} sn/rota\n`);
        console.log('rota'.padEnd(30), 'istek/sn'.padStart(9), 'ort ms'.padStart(8), 'p99 ms'.padStart(8), '2xx'.padStart(8), 'hata'.padStart(7));
        for (const route of ROUTES) {
            const r = await autocannon({ url: s.baseUrl + route, connections: CONNECTIONS, duration: DURATION,
                headers: { Authorization: `Bearer ${admin.token}` } });
            const bad = r.non2xx + r.errors + r.timeouts;
            console.log(route.padEnd(30), String(Math.round(r.requests.average)).padStart(9), String(r.latency.average).padStart(8),
                String(r.latency.p99).padStart(8), String(r['2xx']).padStart(8), String(bad).padStart(7));
        }
    } finally { await s.stop(); }
})().catch(e => { console.error(e); process.exit(1); });
