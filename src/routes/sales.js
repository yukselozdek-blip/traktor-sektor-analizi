'use strict';
const { logRouteError } = require('../lib/log-error');
// Satış verisi ve analitik route'ları (/api/sales/*), server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerSales(app, ctx) {
    const { pool, authMiddleware, roundMetric, calculateYoY, ensureProvincesSeeded } = ctx;

    // ============================================
    // SALES DATA & ANALYTICS
    // ============================================

    // Genel satış özeti
    app.get('/api/sales/summary', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
            const targetYear = year || new Date().getFullYear();

            let query = `
                SELECT b.name as brand_name, b.slug, b.primary_color,
                       SUM(s.quantity) as total_sales,
                       COUNT(DISTINCT s.province_id) as province_count
                FROM sales_view s
                JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1
            `;
            const params = [targetYear];

            if (userBrandId) {
                query += ` AND (s.brand_id = $2 OR TRUE)`;
                params.push(userBrandId);
            }
            query += ' GROUP BY b.id, b.name, b.slug, b.primary_color ORDER BY total_sales DESC';
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/summary');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Tarihsel Gelişim - Yıllık toplam pazar + marka satışları
    app.get('/api/sales/historical', authMiddleware, async (req, res) => {
        try {
            const { brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;

            // 1. Son veri noktasını bul (en son yıl ve ay)
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ data: [], max_year: null, max_month: null, compare_months: null, pct_diff_market: null, pct_diff_brand: null });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

            // 2. Son 12 yılın tam yıllık verileri (son 2 yıl hariç)
            const yearlyRes = await pool.query(`
                SELECT s.year,
                       SUM(s.quantity) as total_market,
                       SUM(CASE WHEN s.brand_id = $1 THEN s.quantity ELSE 0 END) as brand_sales
                FROM sales_view s
                WHERE s.year >= $2 AND s.year <= $3
                GROUP BY s.year ORDER BY s.year
            `, [userBrandId || 0, maxYear - 11, maxYear - 1]);

            // 3. Son 2 yılın karşılaştırması (aynı ay aralığı: 1..maxMonth)
            // Eğer maxYear=2025, maxMonth=5 ise: 2024 ilk 5 ay vs 2025 ilk 5 ay
            const prevYear = maxYear - 1;
            const compareRes = await pool.query(`
                SELECT s.year,
                       SUM(s.quantity) as total_market,
                       SUM(CASE WHEN s.brand_id = $1 THEN s.quantity ELSE 0 END) as brand_sales
                FROM sales_view s
                WHERE s.year IN ($2, $3) AND s.month <= $4
                GROUP BY s.year ORDER BY s.year
            `, [userBrandId || 0, prevYear, maxYear, maxMonth]);

            // Combine
            const yearlyData = yearlyRes.rows.map(r => ({
                year: r.year,
                label: r.year.toString(),
                total_market: parseInt(r.total_market),
                brand_sales: parseInt(r.brand_sales),
                brand_share_pct: r.total_market > 0 ? parseFloat((r.brand_sales * 100 / r.total_market).toFixed(1)) : 0,
                is_partial: false
            }));

            // Add partial year comparisons
            compareRes.rows.forEach(r => {
                yearlyData.push({
                    year: r.year,
                    label: `${r.year} İLK ${maxMonth} AY`,
                    total_market: parseInt(r.total_market),
                    brand_sales: parseInt(r.brand_sales),
                    brand_share_pct: r.total_market > 0 ? parseFloat((r.brand_sales * 100 / r.total_market).toFixed(1)) : 0,
                    is_partial: true
                });
            });

            // Calculate % difference between last 2 partial periods
            const partials = yearlyData.filter(d => d.is_partial).sort((a, b) => a.year - b.year);
            let pctDiffMarket = null, pctDiffBrand = null;
            if (partials.length === 2) {
                pctDiffMarket = partials[0].total_market > 0
                    ? parseFloat(((partials[1].total_market - partials[0].total_market) * 100 / partials[0].total_market).toFixed(1))
                    : null;
                pctDiffBrand = partials[0].brand_sales > 0
                    ? parseFloat(((partials[1].brand_sales - partials[0].brand_sales) * 100 / partials[0].brand_sales).toFixed(1))
                    : null;
            }

            res.json({
                data: yearlyData,
                max_year: maxYear,
                max_month: maxMonth,
                compare_months: maxMonth,
                pct_diff_market: pctDiffMarket,
                pct_diff_brand: pctDiffBrand
            });
        } catch (err) {
            console.error('Historical error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Distribütör Özet Tablosu - Marka grupları
    app.get('/api/sales/distributor-summary', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], brands: [], totals: { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 } });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);

            // Distribütör grup tanımları (slug → grup adı)
            const distributorGroups = {
                'TÜRK TRAKTÖR\n(CNH)': ['new-holland', 'case-ih', 'fiat'],
                'TÜMOSAN': ['tumosan'],
                'MASSEY FERGUSON': ['massey-ferguson'],
                'MAHINDRA GRUBU\n(ERKUNT&MAHINDRA)': ['erkunt'],
                'SAME DEUTZ - FAHR': ['deutz-fahr', 'same'],
                'HATTAT': ['hattat'],
                'KUTLUCAN\n(FENDT&VALTRA)': ['fendt', 'valtra'],
                'BAŞAK': ['basak'],
                'KUBOTA': ['kubota'],
                'JOHN DEERE': ['john-deere'],
                'SOLIS': ['solis'],
                'LANDINI': ['landini', 'mccormick'],
                'ANTONIO CARRARO': ['antonio-carraro'],
                'CLAAS': ['claas']
            };

            // Slug → brand_id mapping
            const brandRows = await pool.query('SELECT id, slug FROM brands');
            const slugToId = {};
            brandRows.rows.forEach(r => { slugToId[r.slug] = r.id; });

            // Tüm satış verisini çek
            const allData = await pool.query(`
                SELECT b.slug, s.year, s.month, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                GROUP BY b.slug, s.year, s.month ORDER BY b.slug, s.year, s.month
            `);

            // Slug bazlı veri
            const slugData = {};
            allData.rows.forEach(r => {
                if (!slugData[r.slug]) slugData[r.slug] = {};
                const key = `${r.year}_${r.month}`;
                slugData[r.slug][key] = (slugData[r.slug][key] || 0) + parseInt(r.total);
            });

            // Grupları oluştur
            const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);
            const groups = [];
            const usedSlugs = new Set();

            for (const [groupName, slugs] of Object.entries(distributorGroups)) {
                const group = { name: groupName, yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                slugs.forEach(slug => {
                    usedSlugs.add(slug);
                    const sd = slugData[slug] || {};
                    // Yıllık toplamlar
                    years.forEach(y => {
                        for (let m = 1; m <= 12; m++) {
                            group.yearly[y] = (group.yearly[y] || 0) + (sd[`${y}_${m}`] || 0);
                        }
                    });
                    // Son yıl aylık
                    for (let m = 1; m <= maxMonth; m++) {
                        group.months[m] = (group.months[m] || 0) + (sd[`${maxYear}_${m}`] || 0);
                    }
                    // Partial
                    for (let m = 1; m <= maxMonth; m++) {
                        group.prev_partial += (sd[`${prevYear}_${m}`] || 0);
                        group.curr_partial += (sd[`${maxYear}_${m}`] || 0);
                    }
                });
                groups.push(group);
            }

            // Kalan markalar → UNKNOWN
            const unknownGroup = { name: 'DİĞER', yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
            let hasUnknown = false;
            for (const [slug, sd] of Object.entries(slugData)) {
                if (usedSlugs.has(slug)) continue;
                hasUnknown = true;
                years.forEach(y => {
                    for (let m = 1; m <= 12; m++) {
                        unknownGroup.yearly[y] = (unknownGroup.yearly[y] || 0) + (sd[`${y}_${m}`] || 0);
                    }
                });
                for (let m = 1; m <= maxMonth; m++) {
                    unknownGroup.months[m] = (unknownGroup.months[m] || 0) + (sd[`${maxYear}_${m}`] || 0);
                }
                for (let m = 1; m <= maxMonth; m++) {
                    unknownGroup.prev_partial += (sd[`${prevYear}_${m}`] || 0);
                    unknownGroup.curr_partial += (sd[`${maxYear}_${m}`] || 0);
                }
            }
            if (hasUnknown) groups.push(unknownGroup);

            // Sırala
            groups.sort((a, b) => b.curr_partial - a.curr_partial);

            // Toplam pazar
            const totals = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
            groups.forEach(g => {
                years.forEach(y => { totals.yearly[y] = (totals.yearly[y] || 0) + (g.yearly[y] || 0); });
                for (let m = 1; m <= maxMonth; m++) { totals.months[m] = (totals.months[m] || 0) + (g.months[m] || 0); }
                totals.prev_partial += g.prev_partial;
                totals.curr_partial += g.curr_partial;
            });

            res.json({ min_year: minYear, max_year: maxYear, prev_year: prevYear, max_month: maxMonth, years, brands: groups, totals });
        } catch (err) {
            console.error('Distributor summary error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Segment Top 10 Marka
    app.get('/api/sales/hp-top-brands', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ year: null, max_month: null, segments: [] });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            // Son yılın ilk N ayı verisi: hp_range + marka bazlı
            const result = await pool.query(`
                SELECT s.hp_range, b.name as brand_name, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.month <= $2 AND s.hp_range IS NOT NULL
                GROUP BY s.hp_range, b.name
                ORDER BY s.hp_range, total DESC
            `, [maxYear, maxMonth]);

            // HP bazlı grupla
            const hpData = {};
            result.rows.forEach(r => {
                if (!hpData[r.hp_range]) hpData[r.hp_range] = [];
                hpData[r.hp_range].push({ brand: r.brand_name, sales: parseInt(r.total) });
            });

            // Her segment için top 10 + toplam
            const segments = hpOrder.map(hp => {
                const all = hpData[hp] || [];
                const segTotal = all.reduce((s, b) => s + b.sales, 0);
                const top10 = all.slice(0, 10).map(b => ({
                    brand: b.brand,
                    sales: b.sales,
                    share: segTotal > 0 ? parseFloat((b.sales * 100 / segTotal).toFixed(1)) : 0
                }));
                return { hp_range: hp, total: segTotal, brands: top10 };
            });

            res.json({ year: maxYear, max_month: maxMonth, segments });
        } catch (err) {
            console.error('HP top brands error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Segment Top 10 İl
    app.get('/api/sales/hp-top-provinces', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ year: null, max_month: null, segments: [] });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            const result = await pool.query(`
                SELECT s.hp_range, p.name as province_name, SUM(s.quantity) as total
                FROM sales_view s JOIN provinces p ON s.province_id = p.id
                WHERE s.year = $1 AND s.month <= $2 AND s.hp_range IS NOT NULL
                GROUP BY s.hp_range, p.name
                ORDER BY s.hp_range, total DESC
            `, [maxYear, maxMonth]);

            const hpData = {};
            result.rows.forEach(r => {
                if (!hpData[r.hp_range]) hpData[r.hp_range] = [];
                hpData[r.hp_range].push({ province: r.province_name, sales: parseInt(r.total) });
            });

            const segments = hpOrder.map(hp => {
                const all = hpData[hp] || [];
                const segTotal = all.reduce((s, p) => s + p.sales, 0);
                const top10 = all.slice(0, 10).map(p => ({
                    province: p.province,
                    sales: p.sales,
                    share: segTotal > 0 ? parseFloat((p.sales * 100 / segTotal).toFixed(1)) : 0
                }));
                return { hp_range: hp, total: segTotal, provinces: top10 };
            });

            res.json({ year: maxYear, max_month: maxMonth, segments });
        } catch (err) {
            console.error('HP top provinces error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Segment Top 10 Marka/Model (Bahçe/Tarla ayrımı)
    app.get('/api/sales/hp-top-models', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ year: null, max_month: null, categories: {} });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
            const categories = ['bahce', 'tarla'];

            const result = await pool.query(`
                SELECT s.hp_range, s.category, b.name as brand_name, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.month <= $2 AND s.hp_range IS NOT NULL
                GROUP BY s.hp_range, s.category, b.name
                ORDER BY s.hp_range, s.category, total DESC
            `, [maxYear, maxMonth]);

            // Grupla: hp_range → category → [{brand, sales}]
            const data = {};
            result.rows.forEach(r => {
                const key = `${r.hp_range}_${r.category}`;
                if (!data[key]) data[key] = [];
                data[key].push({ brand: r.brand_name, sales: parseInt(r.total) });
            });

            // Her kategori + HP segment için top 10
            const catResults = {};
            categories.forEach(cat => {
                catResults[cat] = hpOrder.map(hp => {
                    const key = `${hp}_${cat}`;
                    const all = data[key] || [];
                    const segTotal = all.reduce((s, b) => s + b.sales, 0);
                    const top10 = all.slice(0, 10).map(b => ({
                        brand: b.brand,
                        sales: b.sales,
                        share: segTotal > 0 ? parseFloat((b.sales * 100 / segTotal).toFixed(1)) : 0
                    }));
                    return { hp_range: hp, total: segTotal, items: top10 };
                });
            });

            res.json({ year: maxYear, max_month: maxMonth, categories: catResults });
        } catch (err) {
            console.error('HP top models error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // İl bazlı Top 10 Marka
    app.get('/api/sales/province-top-brands', authMiddleware, async (req, res) => {
        try {
            const requestedYear = req.query.year ? parseInt(req.query.year, 10) : null;
            const requestedProvinceId = req.query.province_id ? parseInt(req.query.province_id, 10) : null;
            const requestedBrandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;
            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

            const latestRes = await pool.query('SELECT MAX(tescil_yil) as max_year, MIN(tescil_yil) as min_year FROM tuik_veri');
            const dbMaxYear = parseInt(latestRes.rows[0]?.max_year, 10);
            const dbMinYear = parseInt(latestRes.rows[0]?.min_year, 10) || dbMaxYear;

            if (!dbMaxYear) {
                return res.json({
                    year: null,
                    prev_year: null,
                    max_month: 0,
                    period_label: '',
                    overview: null,
                    provinces: [],
                    selected_province: null,
                    selected_brand: null,
                    brand_network: [],
                    heatmap: { brands: [], rows: [] }
                });
            }

            const targetYear = requestedYear
                ? Math.min(Math.max(requestedYear, dbMinYear), dbMaxYear)
                : dbMaxYear;
            const prevYear = targetYear - 1;
            let maxMonth = 12;

            if (targetYear >= dbMaxYear) {
                const latestMonthRes = await pool.query(
                    'SELECT MAX(tescil_ay) as max_month FROM tuik_veri WHERE tescil_yil = $1',
                    [targetYear]
                );
                maxMonth = parseInt(latestMonthRes.rows[0]?.max_month, 10) || 12;
            }

            const normalizedBrandExpr = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tv.marka
                END
            `;
            const categoryExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' OR LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahçe%' THEN 'bahce'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                    ELSE 'belirsiz'
                END
            `;
            const cabinTypeExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%rops%' OR LOWER(COALESCE(tk.koruma, '')) LIKE '%roll%' THEN 'rollbar'
                    ELSE 'belirsiz'
                END
            `;

            const [currentRowsRes, previousBrandRes] = await Promise.all([
                pool.query(`
                    WITH model_totals AS (
                        SELECT
                            p.id as province_id,
                            p.name as province_name,
                            p.region,
                            p.plate_code,
                            b.id as brand_id,
                            b.name as brand_name,
                            b.slug as brand_slug,
                            b.primary_color,
                            tv.marka as raw_brand_name,
                            tv.tuik_model_adi,
                            SUM(tv.satis_adet)::int as total_sales
                        FROM tuik_veri tv
                        JOIN brands b
                            ON UPPER(b.name) = UPPER(${normalizedBrandExpr})
                        JOIN provinces p
                            ON LPAD(COALESCE(p.plate_code, '0')::text, 2, '0') = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                        WHERE tv.tescil_yil = $1
                          AND tv.tescil_ay <= $2
                        GROUP BY
                            p.id, p.name, p.region, p.plate_code,
                            b.id, b.name, b.slug, b.primary_color,
                            tv.marka, tv.tuik_model_adi
                    )
                    SELECT
                        mt.province_id,
                        mt.province_name,
                        mt.region,
                        mt.plate_code,
                        mt.brand_id,
                        mt.brand_name,
                        mt.brand_slug,
                        mt.primary_color,
                        mt.tuik_model_adi,
                        COALESCE(NULLIF(MAX(tk.model), ''), mt.tuik_model_adi) as model_name,
                        mt.total_sales,
                        ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                        ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                        COALESCE(MAX(${categoryExpr}), 'belirsiz') as category,
                        COALESCE(UPPER(MAX(NULLIF(tk.cekis_tipi, ''))), 'belirsiz') as drive_type,
                        COALESCE(MAX(${cabinTypeExpr}), 'belirsiz') as cabin_type,
                        MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                        MAX(COALESCE(tk.mensei, '')) as origin,
                        MAX(COALESCE(tk.motor_marka, '')) as engine_brand
                    FROM model_totals mt
                    LEFT JOIN teknik_veri tk
                        ON UPPER(mt.raw_brand_name) = UPPER(tk.marka)
                       AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                    GROUP BY
                        mt.province_id, mt.province_name, mt.region, mt.plate_code,
                        mt.brand_id, mt.brand_name, mt.brand_slug, mt.primary_color,
                        mt.tuik_model_adi, mt.total_sales
                    ORDER BY mt.total_sales DESC, mt.province_name ASC, mt.brand_name ASC
                `, [targetYear, maxMonth]),
                pool.query(`
                    SELECT
                        p.id as province_id,
                        b.id as brand_id,
                        SUM(tv.satis_adet)::int as total_sales
                    FROM tuik_veri tv
                    JOIN brands b
                        ON UPPER(b.name) = UPPER(${normalizedBrandExpr})
                    JOIN provinces p
                        ON LPAD(COALESCE(p.plate_code, '0')::text, 2, '0') = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    WHERE tv.tescil_yil = $1
                      AND tv.tescil_ay <= $2
                    GROUP BY p.id, b.id
                `, [prevYear, maxMonth])
            ]);

            const currentRows = currentRowsRes.rows
                .map(row => ({
                    province_id: parseInt(row.province_id, 10),
                    province_name: row.province_name,
                    region: row.region || '',
                    plate_code: row.plate_code,
                    brand_id: parseInt(row.brand_id, 10),
                    brand_name: row.brand_name,
                    brand_slug: row.brand_slug,
                    primary_color: row.primary_color,
                    tuik_model_adi: row.tuik_model_adi,
                    model_name: row.model_name || row.tuik_model_adi,
                    total_sales: parseInt(row.total_sales, 10) || 0,
                    avg_hp: row.avg_hp != null ? Number(row.avg_hp) : null,
                    avg_price_usd: row.avg_price_usd != null ? Number(row.avg_price_usd) : null,
                    category: row.category || 'belirsiz',
                    drive_type: row.drive_type || 'belirsiz',
                    cabin_type: row.cabin_type || 'belirsiz',
                    gear_config: row.gear_config || '',
                    origin: row.origin || '',
                    engine_brand: row.engine_brand || ''
                }))
                .filter(row => row.total_sales > 0);

            const previousBrandMap = new Map();
            const previousProvinceMap = new Map();
            const previousGlobalBrandMap = new Map();

            previousBrandRes.rows.forEach(row => {
                const provinceId = parseInt(row.province_id, 10);
                const brandId = parseInt(row.brand_id, 10);
                const totalSales = parseInt(row.total_sales, 10) || 0;
                previousBrandMap.set(`${provinceId}:${brandId}`, totalSales);
                previousProvinceMap.set(provinceId, (previousProvinceMap.get(provinceId) || 0) + totalSales);
                previousGlobalBrandMap.set(brandId, (previousGlobalBrandMap.get(brandId) || 0) + totalSales);
            });

            if (!currentRows.length) {
                return res.json({
                    year: targetYear,
                    prev_year: prevYear,
                    max_month: maxMonth,
                    period_label: `${monthNames[Math.max(maxMonth - 1, 0)] || ''} ${targetYear}`.trim(),
                    overview: null,
                    provinces: [],
                    selected_province: null,
                    selected_brand: null,
                    brand_network: [],
                    heatmap: { brands: [], rows: [] }
                });
            }

            const provinceMap = new Map();
            const globalBrandMap = new Map();

            currentRows.forEach(row => {
                if (!provinceMap.has(row.province_id)) {
                    provinceMap.set(row.province_id, {
                        province_id: row.province_id,
                        province_name: row.province_name,
                        region: row.region,
                        plate_code: row.plate_code,
                        total_sales: 0,
                        _model_keys: new Set(),
                        _brands: new Map()
                    });
                }

                const province = provinceMap.get(row.province_id);
                province.total_sales += row.total_sales;
                province._model_keys.add(`${row.brand_id}:${String(row.tuik_model_adi || '').toUpperCase()}`);

                if (!province._brands.has(row.brand_id)) {
                    province._brands.set(row.brand_id, {
                        brand_id: row.brand_id,
                        brand_name: row.brand_name,
                        brand_slug: row.brand_slug,
                        primary_color: row.primary_color,
                        total_sales: 0,
                        _model_keys: new Set(),
                        models: []
                    });
                }

                const brand = province._brands.get(row.brand_id);
                brand.total_sales += row.total_sales;
                brand._model_keys.add(String(row.tuik_model_adi || '').toUpperCase());
                brand.models.push({ ...row });

                if (!globalBrandMap.has(row.brand_id)) {
                    globalBrandMap.set(row.brand_id, {
                        brand_id: row.brand_id,
                        brand_name: row.brand_name,
                        brand_slug: row.brand_slug,
                        primary_color: row.primary_color,
                        total_sales: 0,
                        province_ids: new Set(),
                        province_totals: new Map(),
                        model_map: new Map(),
                        lead_count: 0
                    });
                }

                const globalBrand = globalBrandMap.get(row.brand_id);
                globalBrand.total_sales += row.total_sales;
                globalBrand.province_ids.add(row.province_id);
                globalBrand.province_totals.set(
                    row.province_id,
                    (globalBrand.province_totals.get(row.province_id) || 0) + row.total_sales
                );

                const modelKey = String(row.tuik_model_adi || '').toUpperCase();
                if (!globalBrand.model_map.has(modelKey)) {
                    globalBrand.model_map.set(modelKey, {
                        tuik_model_adi: row.tuik_model_adi,
                        model_name: row.model_name,
                        total_sales: 0,
                        avg_hp: row.avg_hp,
                        avg_price_usd: row.avg_price_usd
                    });
                }

                const modelAgg = globalBrand.model_map.get(modelKey);
                modelAgg.total_sales += row.total_sales;
                modelAgg.model_name = modelAgg.model_name || row.model_name;
                modelAgg.avg_hp = modelAgg.avg_hp != null ? modelAgg.avg_hp : row.avg_hp;
                modelAgg.avg_price_usd = modelAgg.avg_price_usd != null ? modelAgg.avg_price_usd : row.avg_price_usd;
            });

            const buildWeightedAverage = (rows, field) => {
                const weightedTotal = rows.reduce((sum, item) => sum + ((Number(item[field]) || 0) * Number(item.total_sales || 0)), 0);
                const weight = rows.reduce((sum, item) => sum + ((item[field] != null ? 1 : 0) * Number(item.total_sales || 0)), 0);
                return weight > 0 ? roundMetric(weightedTotal / weight, field === 'avg_price_usd' ? 0 : 1) : null;
            };
            const buildMixRows = (rows, field) => {
                const mix = new Map();
                rows.forEach(item => {
                    const label = String(item[field] || 'belirsiz');
                    mix.set(label, (mix.get(label) || 0) + Number(item.total_sales || 0));
                });
                return Array.from(mix.entries())
                    .map(([label, totalSales]) => ({
                        label,
                        total_sales: totalSales,
                        share_pct: rows.length ? roundMetric((totalSales * 100) / rows.reduce((sum, item) => sum + Number(item.total_sales || 0), 0), 1) : 0
                    }))
                    .sort((left, right) => right.total_sales - left.total_sales || String(left.label).localeCompare(String(right.label), 'tr'));
            };

            const provinceDetails = Array.from(provinceMap.values())
                .map(province => {
                    const brands = Array.from(province._brands.values())
                        .map(brand => {
                            const modelRows = [...brand.models]
                                .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'))
                                .map(model => ({
                                    ...model,
                                    share_in_brand_pct: brand.total_sales > 0 ? roundMetric((model.total_sales * 100) / brand.total_sales, 1) : 0,
                                    share_in_province_pct: province.total_sales > 0 ? roundMetric((model.total_sales * 100) / province.total_sales, 1) : 0
                                }));
                            const previousSales = previousBrandMap.get(`${province.province_id}:${brand.brand_id}`) || 0;

                            return {
                                brand_id: brand.brand_id,
                                brand_name: brand.brand_name,
                                brand_slug: brand.brand_slug,
                                primary_color: brand.primary_color,
                                total_sales: brand.total_sales,
                                previous_sales: previousSales,
                                yoy_pct: calculateYoY(brand.total_sales, previousSales),
                                share_pct: province.total_sales > 0 ? roundMetric((brand.total_sales * 100) / province.total_sales, 1) : 0,
                                model_count: brand._model_keys.size,
                                weighted_avg_hp: buildWeightedAverage(modelRows, 'avg_hp'),
                                weighted_avg_price_usd: buildWeightedAverage(modelRows, 'avg_price_usd'),
                                top_model_name: modelRows[0]?.model_name || null,
                                top_model_sales: modelRows[0]?.total_sales || 0,
                                models: modelRows,
                                category_mix: buildMixRows(modelRows, 'category'),
                                drive_mix: buildMixRows(modelRows, 'drive_type'),
                                cabin_mix: buildMixRows(modelRows, 'cabin_type')
                            };
                        })
                        .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'))
                        .map((brand, index) => ({ ...brand, rank: index + 1 }));

                    const previousTotal = previousProvinceMap.get(province.province_id) || 0;
                    const top3Total = brands.slice(0, 3).reduce((sum, item) => sum + item.total_sales, 0);
                    const modelArena = brands
                        .flatMap(brand => brand.models.map(model => ({
                            ...model,
                            brand_id: brand.brand_id,
                            brand_name: brand.brand_name,
                            brand_slug: brand.brand_slug,
                            primary_color: brand.primary_color
                        })))
                        .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'))
                        .slice(0, 20);

                    return {
                        province_id: province.province_id,
                        province_name: province.province_name,
                        region: province.region,
                        plate_code: province.plate_code,
                        total_sales: province.total_sales,
                        previous_total_sales: previousTotal,
                        yoy_pct: calculateYoY(province.total_sales, previousTotal),
                        active_brand_count: brands.length,
                        active_model_count: province._model_keys.size,
                        concentration_top3_pct: province.total_sales > 0 ? roundMetric((top3Total * 100) / province.total_sales, 1) : 0,
                        competitive_gap_pct: brands[1]
                            ? roundMetric((brands[0].share_pct || 0) - (brands[1].share_pct || 0), 1)
                            : (brands[0]?.share_pct || 0),
                        top_brand_name: brands[0]?.brand_name || null,
                        top_brand_share_pct: brands[0]?.share_pct || 0,
                        challenger_brand_name: brands[1]?.brand_name || null,
                        challenger_brand_share_pct: brands[1]?.share_pct || 0,
                        top_model_name: modelArena[0]?.model_name || null,
                        top_model_brand_name: modelArena[0]?.brand_name || null,
                        brands,
                        model_arena: modelArena
                    };
                })
                .sort((left, right) => right.total_sales - left.total_sales || String(left.province_name || '').localeCompare(String(right.province_name || ''), 'tr'));

            provinceDetails.forEach(province => {
                const leaderBrandId = province.brands[0]?.brand_id;
                if (leaderBrandId && globalBrandMap.has(leaderBrandId)) {
                    globalBrandMap.get(leaderBrandId).lead_count += 1;
                }
            });

            const overallSales = provinceDetails.reduce((sum, item) => sum + item.total_sales, 0);
            const overallPreviousSales = provinceDetails.reduce((sum, item) => sum + item.previous_total_sales, 0);

            const brandNetwork = Array.from(globalBrandMap.values())
                .map(brand => {
                    const dominantProvinceEntry = Array.from(brand.province_totals.entries())
                        .sort((left, right) => right[1] - left[1])[0];
                    const dominantProvince = provinceDetails.find(item => item.province_id === dominantProvinceEntry?.[0]) || null;
                    const topModel = Array.from(brand.model_map.values())
                        .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'))[0] || null;
                    const previousSales = previousGlobalBrandMap.get(brand.brand_id) || 0;

                    return {
                        brand_id: brand.brand_id,
                        brand_name: brand.brand_name,
                        brand_slug: brand.brand_slug,
                        primary_color: brand.primary_color,
                        total_sales: brand.total_sales,
                        previous_sales: previousSales,
                        yoy_pct: calculateYoY(brand.total_sales, previousSales),
                        share_pct: overallSales > 0 ? roundMetric((brand.total_sales * 100) / overallSales, 1) : 0,
                        province_count: brand.province_ids.size,
                        lead_count: brand.lead_count,
                        dominant_province_name: dominantProvince?.province_name || null,
                        dominant_province_sales: dominantProvinceEntry?.[1] || 0,
                        top_model_name: topModel?.model_name || null,
                        top_model_sales: topModel?.total_sales || 0
                    };
                })
                .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'));

            const selectedProvince = provinceDetails.find(item => item.province_id === requestedProvinceId) || provinceDetails[0] || null;
            const selectedBrand = selectedProvince
                ? (selectedProvince.brands.find(item => item.brand_id === requestedBrandId) || selectedProvince.brands[0] || null)
                : null;

            const selectedBrandDetail = selectedBrand
                ? {
                    ...selectedBrand,
                    province_rank: selectedProvince.brands.findIndex(item => item.brand_id === selectedBrand.brand_id) + 1,
                    leader_gap_pct: selectedProvince.brands[0]
                        ? roundMetric((selectedProvince.brands[0].share_pct || 0) - (selectedBrand.share_pct || 0), 1)
                        : 0,
                    scatter: selectedBrand.models
                        .filter(item => item.avg_hp != null && item.avg_price_usd != null)
                        .slice(0, 18),
                    model_table: selectedBrand.models.slice(0, 18)
                }
                : null;

            const heatmapBrands = brandNetwork.slice(0, 6);
            const heatmapRows = provinceDetails.slice(0, 10).map(province => ({
                province_id: province.province_id,
                province_name: province.province_name,
                total_sales: province.total_sales,
                brands: heatmapBrands.map(brand => {
                    const provinceBrand = province.brands.find(item => item.brand_id === brand.brand_id);
                    return {
                        brand_id: brand.brand_id,
                        brand_name: brand.brand_name,
                        primary_color: brand.primary_color,
                        sales: provinceBrand?.total_sales || 0,
                        share_pct: provinceBrand?.share_pct || 0
                    };
                })
            }));

            const provinceSummaries = provinceDetails.map(province => ({
                province_id: province.province_id,
                province_name: province.province_name,
                region: province.region,
                plate_code: province.plate_code,
                total_sales: province.total_sales,
                previous_total_sales: province.previous_total_sales,
                yoy_pct: province.yoy_pct,
                active_brand_count: province.active_brand_count,
                active_model_count: province.active_model_count,
                concentration_top3_pct: province.concentration_top3_pct,
                competitive_gap_pct: province.competitive_gap_pct,
                top_brand_name: province.top_brand_name,
                top_brand_share_pct: province.top_brand_share_pct,
                top_model_name: province.top_model_name,
                top_model_brand_name: province.top_model_brand_name
            }));

            res.json({
                year: targetYear,
                prev_year: prevYear,
                max_month: maxMonth,
                period_label: `${monthNames[Math.max(maxMonth - 1, 0)] || ''} ${targetYear}`.trim(),
                overview: {
                    total_sales: overallSales,
                    previous_total_sales: overallPreviousSales,
                    yoy_pct: calculateYoY(overallSales, overallPreviousSales),
                    active_province_count: provinceDetails.length,
                    active_brand_count: brandNetwork.length,
                    top_province_name: provinceDetails[0]?.province_name || null,
                    top_province_sales: provinceDetails[0]?.total_sales || 0,
                    top_province_share_pct: overallSales > 0 ? roundMetric(((provinceDetails[0]?.total_sales || 0) * 100) / overallSales, 1) : 0,
                    strongest_brand_name: brandNetwork[0]?.brand_name || null,
                    strongest_brand_sales: brandNetwork[0]?.total_sales || 0,
                    strongest_brand_share_pct: brandNetwork[0]?.share_pct || 0
                },
                provinces: provinceSummaries,
                selected_province: selectedProvince
                    ? {
                        ...selectedProvince,
                        brands: selectedProvince.brands.slice(0, 12).map(brand => ({
                            brand_id: brand.brand_id,
                            brand_name: brand.brand_name,
                            brand_slug: brand.brand_slug,
                            primary_color: brand.primary_color,
                            total_sales: brand.total_sales,
                            previous_sales: brand.previous_sales,
                            yoy_pct: brand.yoy_pct,
                            share_pct: brand.share_pct,
                            model_count: brand.model_count,
                            weighted_avg_hp: brand.weighted_avg_hp,
                            weighted_avg_price_usd: brand.weighted_avg_price_usd,
                            top_model_name: brand.top_model_name,
                            top_model_sales: brand.top_model_sales,
                            rank: brand.rank,
                            model_preview: brand.models.slice(0, 3).map(model => ({
                                model_name: model.model_name,
                                total_sales: model.total_sales,
                                share_in_brand_pct: model.share_in_brand_pct,
                                avg_hp: model.avg_hp
                            }))
                        })),
                        model_arena: selectedProvince.model_arena
                    }
                    : null,
                selected_brand: selectedBrandDetail,
                brand_network: brandNetwork,
                heatmap: {
                    brands: heatmapBrands,
                    rows: heatmapRows
                }
            });
        } catch (err) {
            console.error('Province top brands error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Brand Matrix - HP segment bazlı tüm markalar (adet + %)
    app.get('/api/sales/hp-brand-matrix', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ years: [], max_year: null, max_month: null, prev_year: null, segments: [], total_market: { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 } });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            const allData = await pool.query(`
                SELECT s.hp_range, b.name as brand_name, s.year, s.month, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.hp_range IS NOT NULL
                GROUP BY s.hp_range, b.name, s.year, s.month
            `);

            const totalMarketData = await pool.query(`
                SELECT year, month, SUM(quantity) as total
                FROM sales_view WHERE hp_range IS NOT NULL
                GROUP BY year, month
            `);

            // Organize: hp -> brand -> year_month -> total
            const raw = {};
            allData.rows.forEach(r => {
                if (!raw[r.hp_range]) raw[r.hp_range] = {};
                if (!raw[r.hp_range][r.brand_name]) raw[r.hp_range][r.brand_name] = {};
                raw[r.hp_range][r.brand_name][`${r.year}_${r.month}`] = (raw[r.hp_range][r.brand_name][`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            const totalMarketRaw = {};
            totalMarketData.rows.forEach(r => {
                totalMarketRaw[`${r.year}_${r.month}`] = (totalMarketRaw[`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            function buildData(src) {
                const d = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                years.forEach(y => { d.yearly[y] = 0; for (let m = 1; m <= 12; m++) d.yearly[y] += (src[`${y}_${m}`] || 0); });
                for (let m = 1; m <= maxMonth; m++) {
                    d.months[m] = src[`${maxYear}_${m}`] || 0;
                    d.prev_partial += (src[`${prevYear}_${m}`] || 0);
                    d.curr_partial += (src[`${maxYear}_${m}`] || 0);
                }
                return d;
            }

            const totalMarket = buildData(totalMarketRaw);

            const segments = hpOrder.map(hp => {
                const hpBrands = raw[hp] || {};
                const brands = [];
                const segTotalRaw = {};

                Object.entries(hpBrands).forEach(([brandName, brandRaw]) => {
                    const bd = buildData(brandRaw);
                    brands.push({ name: brandName, ...bd });
                    // Accumulate segment total
                    Object.entries(brandRaw).forEach(([k, v]) => { segTotalRaw[k] = (segTotalRaw[k] || 0) + v; });
                });

                const segTotal = buildData(segTotalRaw);
                brands.sort((a, b) => b.curr_partial - a.curr_partial || b.prev_partial - a.prev_partial);

                return { hp, total: segTotal, brands };
            });

            res.json({ years, max_year: maxYear, max_month: maxMonth, prev_year: prevYear, segments, total_market: totalMarket });
        } catch (err) {
            console.error('HP Brand matrix error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Brand HP Detail - Marka bazlı HP segment analizi
    app.get('/api/sales/brand-hp-detail', authMiddleware, async (req, res) => {
        try {
            const brandId = req.query.brand_id || '';
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ brand_id: brandId, brand_name: null, years: [], max_year: null, max_month: null, prev_year: null, segments: [] });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            let brandName = 'Tüm Markalar';
            if (brandId) {
                const brandRes = await pool.query('SELECT name FROM brands WHERE id = $1', [brandId]);
                if (brandRes.rows.length > 0) brandName = brandRes.rows[0].name;
            }

            // Market data by hp_range
            const marketData = await pool.query(`
                SELECT hp_range, year, month, SUM(quantity) as total
                FROM sales_view WHERE hp_range IS NOT NULL
                GROUP BY hp_range, year, month
            `);

            // Brand data
            let brandData = { rows: [] };
            if (brandId) {
                brandData = await pool.query(`
                    SELECT hp_range, year, month, SUM(quantity) as total
                    FROM sales_view WHERE hp_range IS NOT NULL AND brand_id = $1
                    GROUP BY hp_range, year, month
                `, [brandId]);
            }

            const marketRaw = {};
            const marketTotalRaw = {};
            marketData.rows.forEach(r => {
                if (!marketRaw[r.hp_range]) marketRaw[r.hp_range] = {};
                marketRaw[r.hp_range][`${r.year}_${r.month}`] = (marketRaw[r.hp_range][`${r.year}_${r.month}`] || 0) + parseInt(r.total);
                marketTotalRaw[`${r.year}_${r.month}`] = (marketTotalRaw[`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            const brandRaw = {};
            const brandTotalRaw = {};
            brandData.rows.forEach(r => {
                if (!brandRaw[r.hp_range]) brandRaw[r.hp_range] = {};
                brandRaw[r.hp_range][`${r.year}_${r.month}`] = (brandRaw[r.hp_range][`${r.year}_${r.month}`] || 0) + parseInt(r.total);
                brandTotalRaw[`${r.year}_${r.month}`] = (brandTotalRaw[`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            function buildSeg(mRaw, bRaw) {
                const market = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                const brand = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                years.forEach(y => {
                    market.yearly[y] = 0; brand.yearly[y] = 0;
                    for (let m = 1; m <= 12; m++) {
                        market.yearly[y] += (mRaw[`${y}_${m}`] || 0);
                        brand.yearly[y] += ((bRaw || {})[`${y}_${m}`] || 0);
                    }
                });
                for (let m = 1; m <= maxMonth; m++) {
                    market.months[m] = mRaw[`${maxYear}_${m}`] || 0;
                    brand.months[m] = (bRaw || {})[`${maxYear}_${m}`] || 0;
                    market.prev_partial += (mRaw[`${prevYear}_${m}`] || 0);
                    brand.prev_partial += ((bRaw || {})[`${prevYear}_${m}`] || 0);
                    market.curr_partial += (mRaw[`${maxYear}_${m}`] || 0);
                    brand.curr_partial += ((bRaw || {})[`${maxYear}_${m}`] || 0);
                }
                return { market, brand };
            }

            const segments = [];
            // Toplam Pazar
            const totalSeg = buildSeg(marketTotalRaw, brandTotalRaw);
            segments.push({ hp: 'Toplam Pazar', ...totalSeg });
            // HP segments
            hpOrder.forEach(hp => {
                const seg = buildSeg(marketRaw[hp] || {}, brandRaw[hp] || {});
                segments.push({ hp, ...seg });
            });

            res.json({ brand_id: brandId, brand_name: brandName, years, max_year: maxYear, max_month: maxMonth, prev_year: prevYear, segments });
        } catch (err) {
            console.error('Brand HP detail error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // OBT HP - Bahçe/Tarla HP segment yıllık + aylık + karşılaştırma
    app.get('/api/sales/obt-hp', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], categories: {} });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
            const categories = ['bahce', 'tarla'];

            const allData = await pool.query(`
                SELECT category, hp_range, year, month, SUM(quantity) as total
                FROM sales_view WHERE hp_range IS NOT NULL
                GROUP BY category, hp_range, year, month
                ORDER BY category, hp_range, year, month
            `);

            // Organize: cat → hp → year_month → total
            const raw = {};
            allData.rows.forEach(r => {
                const key = `${r.category}_${r.hp_range}`;
                if (!raw[key]) raw[key] = {};
                raw[key][`${r.year}_${r.month}`] = (raw[key][`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            // Category totals
            const catTotalRaw = {};
            allData.rows.forEach(r => {
                if (!catTotalRaw[r.category]) catTotalRaw[r.category] = {};
                catTotalRaw[r.category][`${r.year}_${r.month}`] = (catTotalRaw[r.category][`${r.year}_${r.month}`] || 0) + parseInt(r.total);
            });

            function buildSegment(catKey, hpKey) {
                const sd = raw[`${catKey}_${hpKey}`] || {};
                const seg = { hp: hpKey, yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                years.forEach(y => { for (let m = 1; m <= 12; m++) seg.yearly[y] = (seg.yearly[y] || 0) + (sd[`${y}_${m}`] || 0); });
                for (let m = 1; m <= maxMonth; m++) {
                    seg.months[m] = sd[`${maxYear}_${m}`] || 0;
                    seg.prev_partial += (sd[`${prevYear}_${m}`] || 0);
                    seg.curr_partial += (sd[`${maxYear}_${m}`] || 0);
                }
                return seg;
            }

            function buildCatTotal(catKey) {
                const sd = catTotalRaw[catKey] || {};
                const tot = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                years.forEach(y => { for (let m = 1; m <= 12; m++) tot.yearly[y] = (tot.yearly[y] || 0) + (sd[`${y}_${m}`] || 0); });
                for (let m = 1; m <= maxMonth; m++) {
                    tot.months[m] = sd[`${maxYear}_${m}`] || 0;
                    tot.prev_partial += (sd[`${prevYear}_${m}`] || 0);
                    tot.curr_partial += (sd[`${maxYear}_${m}`] || 0);
                }
                return tot;
            }

            const result = {};
            categories.forEach(cat => {
                result[cat] = {
                    segments: hpOrder.map(hp => buildSegment(cat, hp)),
                    total: buildCatTotal(cat)
                };
            });

            res.json({ min_year: minYear, max_year: maxYear, prev_year: prevYear, max_month: maxMonth, years, categories: result });
        } catch (err) {
            console.error('OBT HP error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Segment Top 10 İl (Bahçe/Tarla ayrımı)
    app.get('/api/sales/hp-top-provinces-cat', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ year: null, max_month: null, categories: { bahce: [], tarla: [] } });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            const result = await pool.query(`
                SELECT s.hp_range, s.category, p.name as province_name, SUM(s.quantity) as total
                FROM sales_view s JOIN provinces p ON s.province_id = p.id
                WHERE s.year = $1 AND s.month <= $2 AND s.hp_range IS NOT NULL
                GROUP BY s.hp_range, s.category, p.name
                ORDER BY s.hp_range, s.category, total DESC
            `, [maxYear, maxMonth]);

            const data = {};
            result.rows.forEach(r => {
                const key = `${r.hp_range}_${r.category}`;
                if (!data[key]) data[key] = [];
                data[key].push({ province: r.province_name, sales: parseInt(r.total) });
            });

            const categories = ['bahce', 'tarla'];
            const catResults = {};
            categories.forEach(cat => {
                catResults[cat] = hpOrder.map(hp => {
                    const key = `${hp}_${cat}`;
                    const all = data[key] || [];
                    const segTotal = all.reduce((s, p) => s + p.sales, 0);
                    const top10 = all.slice(0, 10).map(p => ({
                        province: p.province,
                        sales: p.sales,
                        share: segTotal > 0 ? parseFloat((p.sales * 100 / segTotal).toFixed(1)) : 0
                    }));
                    return { hp_range: hp, total: segTotal, items: top10 };
                });
            });

            res.json({ year: maxYear, max_month: maxMonth, categories: catResults });
        } catch (err) {
            console.error('HP top provinces cat error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP Segment Tablosu - HP aralıklarına göre yıllık + aylık + karşılaştırma
    app.get('/api/sales/hp-summary', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], segments: [], totals: { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 } });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

            // Tüm veriler hp_range bazlı
            const allData = await pool.query(`
                SELECT hp_range, year, month, SUM(quantity) as total
                FROM sales_view
                WHERE hp_range IS NOT NULL
                GROUP BY hp_range, year, month ORDER BY hp_range, year, month
            `);

            // HP bazlı veri
            const hpData = {};
            allData.rows.forEach(r => {
                if (!hpData[r.hp_range]) hpData[r.hp_range] = {};
                const key = `${r.year}_${r.month}`;
                hpData[r.hp_range][key] = (hpData[r.hp_range][key] || 0) + parseInt(r.total);
            });

            // HP sıralaması (standart segmentler)
            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
            const segments = [];

            for (const hp of hpOrder) {
                const sd = hpData[hp] || {};
                const seg = { name: hp, yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
                years.forEach(y => {
                    for (let m = 1; m <= 12; m++) { seg.yearly[y] = (seg.yearly[y] || 0) + (sd[`${y}_${m}`] || 0); }
                });
                for (let m = 1; m <= maxMonth; m++) {
                    seg.months[m] = (seg.months[m] || 0) + (sd[`${maxYear}_${m}`] || 0);
                    seg.prev_partial += (sd[`${prevYear}_${m}`] || 0);
                    seg.curr_partial += (sd[`${maxYear}_${m}`] || 0);
                }
                segments.push(seg);
            }

            // Toplam
            const totals = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
            segments.forEach(s => {
                years.forEach(y => { totals.yearly[y] = (totals.yearly[y] || 0) + (s.yearly[y] || 0); });
                for (let m = 1; m <= maxMonth; m++) { totals.months[m] = (totals.months[m] || 0) + (s.months[m] || 0); }
                totals.prev_partial += s.prev_partial;
                totals.curr_partial += s.curr_partial;
            });

            res.json({ min_year: minYear, max_year: maxYear, prev_year: prevYear, max_month: maxMonth, years, segments, totals });
        } catch (err) {
            console.error('HP summary error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Marka Özet Tablosu - Tüm markalar yıllık + aylık + karşılaştırma
    app.get('/api/sales/hp-command-center', authMiddleware, async (req, res) => {
        try {
            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
            const latestRes = await pool.query('SELECT MAX(tescil_yil) as max_year FROM tuik_veri');
            const maxYear = parseInt(latestRes.rows[0].max_year, 10);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], hp_order: hpOrder, totals: { curr_partial: 0, prev_partial: 0, yoy_pct: null }, concentration: { active_segments: 0, dominant_segment: '', dominant_share_pct: 0, fastest_segment: '', fastest_segment_yoy_pct: null, bahce_share_pct: 0, tarla_share_pct: 0 }, brand_options: [], selected_brand_id: null, segments: [], categories: { bahce: { total: 0, share_pct: 0, segments: [] }, tarla: { total: 0, share_pct: 0, segments: [] } }, brand_spotlight: { brand_id: null, brand_name: '', current_total: 0, previous_total: 0, yoy_pct: null, market_share_pct: 0, dominant_segment: '', dominant_segment_weight_pct: 0, segments: [] }, matrix: { brands: [], segments: [] } });
            const latestMonthRes = await pool.query('SELECT MAX(tescil_ay) as max_month FROM tuik_veri WHERE tescil_yil = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month, 10);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(tescil_yil) as min_year FROM tuik_veri');
            const minYear = parseInt(minYearRes.rows[0].min_year, 10);
            const years = Array.from({ length: Math.max(prevYear - minYear + 1, 0) }, (_, index) => minYear + index);
            const requestedBrandId = req.user.role === 'admin'
                ? (req.query.brand_id ? parseInt(req.query.brand_id, 10) : null)
                : (req.user.brand_id ? parseInt(req.user.brand_id, 10) : null);

            const normalizedBrandExpr = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tv.marka
                END
            `;
            const hpRangeExpr = `
                CASE
                    WHEN tk.motor_gucu_hp IS NULL THEN NULL
                    WHEN tk.motor_gucu_hp <= 39 THEN '1-39'
                    WHEN tk.motor_gucu_hp <= 49 THEN '40-49'
                    WHEN tk.motor_gucu_hp <= 54 THEN '50-54'
                    WHEN tk.motor_gucu_hp <= 59 THEN '55-59'
                    WHEN tk.motor_gucu_hp <= 69 THEN '60-69'
                    WHEN tk.motor_gucu_hp <= 79 THEN '70-79'
                    WHEN tk.motor_gucu_hp <= 89 THEN '80-89'
                    WHEN tk.motor_gucu_hp <= 99 THEN '90-99'
                    WHEN tk.motor_gucu_hp <= 109 THEN '100-109'
                    WHEN tk.motor_gucu_hp <= 119 THEN '110-119'
                    WHEN tk.motor_gucu_hp > 120 THEN '120+'
                    ELSE NULL
                END
            `;
            const categoryExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' OR LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahçe%' THEN 'bahce'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                    ELSE NULL
                END
            `;

            const [salesRowsRes, rawCurrentRes] = await Promise.all([
                pool.query(`
                    SELECT
                        s.year,
                        s.month,
                        s.brand_id,
                        b.name AS brand_name,
                        s.category,
                        s.hp_range,
                        SUM(s.quantity)::int AS quantity
                    FROM sales_view s
                    JOIN brands b ON b.id = s.brand_id
                    WHERE s.hp_range IS NOT NULL
                      AND s.year BETWEEN $1 AND $2
                    GROUP BY s.year, s.month, s.brand_id, b.name, s.category, s.hp_range
                `, [minYear, maxYear]),
                pool.query(`
                    SELECT
                        p.name AS province_name,
                        b.id AS brand_id,
                        b.name AS brand_name,
                        COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi) AS model_name,
                        ${categoryExpr} AS category,
                        ${hpRangeExpr} AS hp_range,
                        SUM(tv.satis_adet)::int AS quantity
                    FROM tuik_veri tv
                    JOIN brands b
                        ON UPPER(b.name) = UPPER(${normalizedBrandExpr})
                    JOIN provinces p
                        ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    LEFT JOIN teknik_veri tk
                        ON UPPER(tk.marka) = UPPER(${normalizedBrandExpr})
                       AND UPPER(tk.tuik_model_adi) = UPPER(tv.tuik_model_adi)
                    WHERE tv.tescil_yil = $1
                      AND tv.tescil_ay <= $2
                    GROUP BY p.name, b.id, b.name, COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi), ${categoryExpr}, ${hpRangeExpr}
                `, [maxYear, maxMonth])
            ]);

            const salesRows = salesRowsRes.rows
                .map(row => ({
                    year: parseInt(row.year, 10),
                    month: parseInt(row.month, 10),
                    brand_id: parseInt(row.brand_id, 10),
                    brand_name: row.brand_name,
                    category: row.category || null,
                    hp_range: row.hp_range || null,
                    quantity: parseInt(row.quantity, 10) || 0
                }))
                .filter(row => row.hp_range && row.quantity > 0);
            const currentDetailRows = rawCurrentRes.rows
                .map(row => ({
                    province_name: row.province_name,
                    brand_id: parseInt(row.brand_id, 10),
                    brand_name: row.brand_name,
                    model_name: row.model_name || '',
                    category: row.category || null,
                    hp_range: row.hp_range || null,
                    quantity: parseInt(row.quantity, 10) || 0
                }))
                .filter(row => row.hp_range && row.quantity > 0);

            const currentBrandTotals = new Map();
            const currentBrandHpTotals = {};
            const previousBrandHpTotals = {};
            const yearlyByHp = {};
            const currentByHp = {};
            const prevByHp = {};
            const monthsByHp = {};
            const brandByHp = {};
            const provinceByHp = {};
            const modelByHp = {};
            const categoryByHp = {};
            const provinceCategoryByHp = {};
            const modelCategoryByHp = {};
            const categoryTotals = {
                bahce: { total: 0, segments: {} },
                tarla: { total: 0, segments: {} }
            };

            const bumpNested = (target, key1, key2, amount) => {
                if (!target[key1]) target[key1] = {};
                target[key1][key2] = (target[key1][key2] || 0) + amount;
            };
            const bumpFlat = (target, key, amount) => {
                target[key] = (target[key] || 0) + amount;
            };

            salesRows.forEach(row => {
                const hp = row.hp_range;
                bumpNested(yearlyByHp, hp, row.year, row.quantity);

                if (row.year === maxYear && row.month <= maxMonth) {
                    bumpFlat(currentByHp, hp, row.quantity);
                    bumpNested(monthsByHp, hp, row.month, row.quantity);
                    bumpNested(brandByHp, hp, row.brand_name, row.quantity);
                    bumpNested(currentBrandHpTotals, row.brand_id, hp, row.quantity);

                    if (!currentBrandTotals.has(row.brand_id)) {
                        currentBrandTotals.set(row.brand_id, { id: row.brand_id, name: row.brand_name, total: 0 });
                    }
                    currentBrandTotals.get(row.brand_id).total += row.quantity;

                    if (row.category === 'bahce' || row.category === 'tarla') {
                        bumpNested(categoryByHp, hp, row.category, row.quantity);
                        categoryTotals[row.category].total += row.quantity;
                        categoryTotals[row.category].segments[hp] = (categoryTotals[row.category].segments[hp] || 0) + row.quantity;
                    }
                }

                if (row.year === prevYear && row.month <= maxMonth) {
                    bumpFlat(prevByHp, hp, row.quantity);
                    bumpNested(previousBrandHpTotals, row.brand_id, hp, row.quantity);
                }
            });

            currentDetailRows.forEach(row => {
                const hp = row.hp_range;
                bumpNested(provinceByHp, hp, row.province_name, row.quantity);
                bumpNested(modelByHp, hp, `${row.brand_name} / ${row.model_name}`, row.quantity);
                if (row.category === 'bahce' || row.category === 'tarla') {
                    bumpNested(provinceCategoryByHp, `${row.category}_${hp}`, row.province_name, row.quantity);
                    bumpNested(modelCategoryByHp, `${row.category}_${hp}`, `${row.brand_name} / ${row.model_name}`, row.quantity);
                }
            });

            const totalCurrent = Object.values(currentByHp).reduce((sum, value) => sum + value, 0);
            const totalPrevious = Object.values(prevByHp).reduce((sum, value) => sum + value, 0);
            const sortedBrandOptions = Array.from(currentBrandTotals.values()).sort((a, b) => b.total - a.total);
            const selectedBrandId = requestedBrandId || sortedBrandOptions[0]?.id || null;
            const selectedBrand = sortedBrandOptions.find(item => item.id === selectedBrandId) || sortedBrandOptions[0] || null;

            const topEntries = (bag, limit = 5) => Object.entries(bag || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, limit)
                .map(([label, total]) => ({ label, total: parseInt(total, 10) }));

            const segments = hpOrder.map(hp => {
                const curr = currentByHp[hp] || 0;
                const prev = prevByHp[hp] || 0;
                const brandLeaders = topEntries(brandByHp[hp], 5).map(item => ({
                    brand: item.label,
                    sales: item.total,
                    share_pct: curr ? roundMetric((item.total * 100) / curr, 1) : 0
                }));
                const provinceLeaders = topEntries(provinceByHp[hp], 5).map(item => ({
                    province: item.label,
                    sales: item.total,
                    share_pct: curr ? roundMetric((item.total * 100) / curr, 1) : 0
                }));
                const modelLeaders = topEntries(modelByHp[hp], 5).map(item => ({
                    model: item.label,
                    sales: item.total,
                    share_pct: curr ? roundMetric((item.total * 100) / curr, 1) : 0
                }));
                const bahce = categoryByHp[hp]?.bahce || 0;
                const tarla = categoryByHp[hp]?.tarla || 0;

                return {
                    hp_range: hp,
                    yearly: years.reduce((acc, year) => {
                        acc[year] = yearlyByHp[hp]?.[year] || 0;
                        return acc;
                    }, {}),
                    months: monthsByHp[hp] || {},
                    prev_partial: prev,
                    curr_partial: curr,
                    share_pct: totalCurrent ? roundMetric((curr * 100) / totalCurrent, 1) : 0,
                    yoy_pct: calculateYoY(curr, prev),
                    top_brand: brandLeaders[0] || null,
                    top_province: provinceLeaders[0] || null,
                    top_model: modelLeaders[0] || null,
                    leaders: {
                        brands: brandLeaders,
                        provinces: provinceLeaders,
                        models: modelLeaders
                    },
                    category_split: {
                        bahce,
                        tarla,
                        bahce_share_pct: curr ? roundMetric((bahce * 100) / curr, 1) : 0,
                        tarla_share_pct: curr ? roundMetric((tarla * 100) / curr, 1) : 0
                    }
                };
            });

            const activeSegments = segments.filter(segment => segment.curr_partial > 0);
            const dominantSegment = [...activeSegments].sort((a, b) => b.curr_partial - a.curr_partial)[0] || null;
            const fastestSegment = activeSegments
                .filter(segment => segment.curr_partial >= 50 && segment.yoy_pct !== null)
                .sort((a, b) => b.yoy_pct - a.yoy_pct)[0] || null;

            const spotlightCurrentTotal = selectedBrand ? selectedBrand.total : 0;
            const spotlightPreviousTotal = hpOrder.reduce((sum, hp) => sum + (previousBrandHpTotals[selectedBrandId]?.[hp] || 0), 0);
            const spotlightSegments = hpOrder.map(hp => {
                const marketCurrent = currentByHp[hp] || 0;
                const marketPrevious = prevByHp[hp] || 0;
                const brandCurrent = currentBrandHpTotals[selectedBrandId]?.[hp] || 0;
                const brandPrevious = previousBrandHpTotals[selectedBrandId]?.[hp] || 0;
                const shareCurrent = marketCurrent ? roundMetric((brandCurrent * 100) / marketCurrent, 1) : 0;
                const sharePrevious = marketPrevious ? roundMetric((brandPrevious * 100) / marketPrevious, 1) : 0;

                return {
                    hp_range: hp,
                    market_current: marketCurrent,
                    market_previous: marketPrevious,
                    brand_current: brandCurrent,
                    brand_previous: brandPrevious,
                    brand_yoy_pct: calculateYoY(brandCurrent, brandPrevious),
                    market_share_current_pct: shareCurrent,
                    market_share_previous_pct: sharePrevious,
                    share_delta_pp: roundMetric(shareCurrent - sharePrevious, 1),
                    portfolio_weight_pct: spotlightCurrentTotal ? roundMetric((brandCurrent * 100) / spotlightCurrentTotal, 1) : 0
                };
            });
            const spotlightDominantSegment = [...spotlightSegments].sort((a, b) => b.brand_current - a.brand_current)[0] || null;

            const matrixBrands = sortedBrandOptions.slice(0, 8).map(item => ({
                id: item.id,
                name: item.name,
                total: item.total
            }));
            const matrixSegments = hpOrder.map(hp => ({
                hp_range: hp,
                total: currentByHp[hp] || 0,
                cells: matrixBrands.map(brand => {
                    const qty = currentBrandHpTotals[brand.id]?.[hp] || 0;
                    return {
                        brand_id: brand.id,
                        qty,
                        segment_share_pct: currentByHp[hp] ? roundMetric((qty * 100) / currentByHp[hp], 1) : 0,
                        brand_mix_pct: brand.total ? roundMetric((qty * 100) / brand.total, 1) : 0
                    };
                })
            }));

            const categoryPanels = {
                bahce: {
                    total: categoryTotals.bahce.total,
                    share_pct: totalCurrent ? roundMetric((categoryTotals.bahce.total * 100) / totalCurrent, 1) : 0,
                    segments: hpOrder.map(hp => ({
                        hp_range: hp,
                        total: categoryTotals.bahce.segments[hp] || 0,
                        top_provinces: topEntries(provinceCategoryByHp[`bahce_${hp}`], 3).map(item => ({ province: item.label, sales: item.total })),
                        top_models: topEntries(modelCategoryByHp[`bahce_${hp}`], 3).map(item => ({ model: item.label, sales: item.total }))
                    }))
                },
                tarla: {
                    total: categoryTotals.tarla.total,
                    share_pct: totalCurrent ? roundMetric((categoryTotals.tarla.total * 100) / totalCurrent, 1) : 0,
                    segments: hpOrder.map(hp => ({
                        hp_range: hp,
                        total: categoryTotals.tarla.segments[hp] || 0,
                        top_provinces: topEntries(provinceCategoryByHp[`tarla_${hp}`], 3).map(item => ({ province: item.label, sales: item.total })),
                        top_models: topEntries(modelCategoryByHp[`tarla_${hp}`], 3).map(item => ({ model: item.label, sales: item.total }))
                    }))
                }
            };

            res.json({
                min_year: minYear,
                max_year: maxYear,
                prev_year: prevYear,
                max_month: maxMonth,
                years,
                hp_order: hpOrder,
                totals: {
                    curr_partial: totalCurrent,
                    prev_partial: totalPrevious,
                    yoy_pct: calculateYoY(totalCurrent, totalPrevious)
                },
                concentration: {
                    active_segments: activeSegments.length,
                    dominant_segment: dominantSegment?.hp_range || '',
                    dominant_share_pct: dominantSegment?.share_pct || 0,
                    fastest_segment: fastestSegment?.hp_range || '',
                    fastest_segment_yoy_pct: fastestSegment?.yoy_pct ?? null,
                    bahce_share_pct: categoryPanels.bahce.share_pct,
                    tarla_share_pct: categoryPanels.tarla.share_pct
                },
                brand_options: sortedBrandOptions,
                selected_brand_id: selectedBrand?.id || null,
                segments,
                categories: categoryPanels,
                brand_spotlight: {
                    brand_id: selectedBrand?.id || null,
                    brand_name: selectedBrand?.name || '',
                    current_total: spotlightCurrentTotal,
                    previous_total: spotlightPreviousTotal,
                    yoy_pct: calculateYoY(spotlightCurrentTotal, spotlightPreviousTotal),
                    market_share_pct: totalCurrent ? roundMetric((spotlightCurrentTotal * 100) / totalCurrent, 1) : 0,
                    dominant_segment: spotlightDominantSegment?.hp_range || '',
                    dominant_segment_weight_pct: spotlightDominantSegment?.portfolio_weight_pct || 0,
                    segments: spotlightSegments
                },
                matrix: {
                    brands: matrixBrands,
                    segments: matrixSegments
                }
            });
        } catch (err) {
            console.error('HP command center error:', err);
            res.status(500).json({ error: 'Sunucu hatasi' });
        }
    });

    app.get('/api/sales/brand-summary', authMiddleware, async (req, res) => {
        try {
            // Son veri noktası
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], brands: [], totals: { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 } });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);

            // 1. Yıllık toplamlar (tüm yıllar, marka bazlı) - son yıl hariç (partial)
            const yearlyRes = await pool.query(`
                SELECT b.id as brand_id, b.name as brand_name, s.year, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year >= $1 AND s.year <= $2
                GROUP BY b.id, b.name, s.year ORDER BY b.name, s.year
            `, [minYear, prevYear]);

            // 2. Son yılın aylık verileri (marka bazlı)
            const monthlyRes = await pool.query(`
                SELECT b.id as brand_id, b.name as brand_name, s.month, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1
                GROUP BY b.id, b.name, s.month ORDER BY b.name, s.month
            `, [maxYear]);

            // 3. Önceki yılın ilk N ayı (marka bazlı)
            const prevPartialRes = await pool.query(`
                SELECT b.id as brand_id, b.name as brand_name, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.month <= $2
                GROUP BY b.id, b.name ORDER BY b.name
            `, [prevYear, maxMonth]);

            // 4. Son yılın ilk N ayı (marka bazlı) = aylık toplamların toplamı
            const currPartialRes = await pool.query(`
                SELECT b.id as brand_id, b.name as brand_name, SUM(s.quantity) as total
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.month <= $2
                GROUP BY b.id, b.name ORDER BY b.name
            `, [maxYear, maxMonth]);

            // 5. Yıllık toplam pazar
            const yearlyTotalRes = await pool.query(`
                SELECT year, SUM(quantity) as total FROM sales_view
                WHERE year >= $1 AND year <= $2
                GROUP BY year ORDER BY year
            `, [minYear, prevYear]);

            // 6. Son yıl aylık toplam pazar
            const monthlyTotalRes = await pool.query(`
                SELECT month, SUM(quantity) as total FROM sales_view
                WHERE year = $1 GROUP BY month ORDER BY month
            `, [maxYear]);

            // 7. Önceki yıl partial toplam
            const prevPartialTotalRes = await pool.query(`
                SELECT SUM(quantity) as total FROM sales_view WHERE year = $1 AND month <= $2
            `, [prevYear, maxMonth]);

            // 8. Son yıl partial toplam
            const currPartialTotalRes = await pool.query(`
                SELECT SUM(quantity) as total FROM sales_view WHERE year = $1 AND month <= $2
            `, [maxYear, maxMonth]);

            // Veriyi düzenle
            const brands = {};
            const allBrands = await pool.query('SELECT id, name FROM brands ORDER BY name');
            allBrands.rows.forEach(b => {
                brands[b.id] = { id: b.id, name: b.name, yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
            });

            yearlyRes.rows.forEach(r => { if (brands[r.brand_id]) brands[r.brand_id].yearly[r.year] = parseInt(r.total); });
            monthlyRes.rows.forEach(r => { if (brands[r.brand_id]) brands[r.brand_id].months[r.month] = parseInt(r.total); });
            prevPartialRes.rows.forEach(r => { if (brands[r.brand_id]) brands[r.brand_id].prev_partial = parseInt(r.total); });
            currPartialRes.rows.forEach(r => { if (brands[r.brand_id]) brands[r.brand_id].curr_partial = parseInt(r.total); });

            // Toplam pazar
            const totals = { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 };
            yearlyTotalRes.rows.forEach(r => { totals.yearly[r.year] = parseInt(r.total); });
            monthlyTotalRes.rows.forEach(r => { totals.months[r.month] = parseInt(r.total); });
            totals.prev_partial = parseInt(prevPartialTotalRes.rows[0]?.total || 0);
            totals.curr_partial = parseInt(currPartialTotalRes.rows[0]?.total || 0);

            // Markaları curr_partial'a göre sırala (büyükten küçüğe)
            const sortedBrands = Object.values(brands)
                .filter(b => b.curr_partial > 0 || b.prev_partial > 0)
                .sort((a, b) => b.curr_partial - a.curr_partial);

            res.json({
                min_year: minYear,
                max_year: maxYear,
                prev_year: prevYear,
                max_month: maxMonth,
                years: Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i),
                brands: sortedBrands,
                totals
            });
        } catch (err) {
            console.error('Brand summary error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Toplam Pazar - Aylık karşılaştırma (2 yıl yan yana, marka bazlı)
    app.get('/api/sales/brand-ecosystem', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year, 10);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ min_year: null, max_year: null, prev_year: null, max_month: null, years: [], totals: { yearly: {}, months: {}, prev_partial: 0, curr_partial: 0 }, concentration: { active_distributors: 0, active_brands: 0, single_brand_channels: 0, top3_distributor_share_pct: 0, top5_brand_share_pct: 0, top_distributor_name: '', top_distributor_share_pct: 0, top_brand_name: '', top_brand_share_pct: 0, fastest_distributor_name: '', fastest_distributor_yoy_pct: null, fastest_brand_name: '', fastest_brand_yoy_pct: null }, distributors: [], brands: [] });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month, 10);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year, 10);
            const years = Array.from({ length: Math.max(prevYear - minYear + 1, 0) }, (_, index) => minYear + index);

            const distributorDefinitions = [
                { name: 'TURK TRAKTOR / CNH', slugs: ['newholland', 'case', 'fiat'] },
                { name: 'MAHINDRA / ERKUNT', slugs: ['erkunt'] },
                { name: 'SDF / DEUTZ-SAME', slugs: ['deutz', 'same'] },
                { name: 'KUTLUCAN / FENDT-VALTRA', slugs: ['fendt', 'valtra'] },
                { name: 'LANDINI / MCCORMICK', slugs: ['landini', 'mccormick'] }
            ];

            const distributorBySlug = new Map();
            distributorDefinitions.forEach(group => {
                group.slugs.forEach(slug => distributorBySlug.set(slug, group.name));
            });

            const [
                allBrandsRes,
                yearlyRes,
                monthlyRes,
                prevPartialRes,
                currPartialRes,
                yearlyTotalRes,
                monthlyTotalRes,
                prevPartialTotalRes,
                currPartialTotalRes
            ] = await Promise.all([
                pool.query('SELECT id, name, slug FROM brands ORDER BY name'),
                pool.query(`
                    SELECT b.id as brand_id, b.name as brand_name, b.slug as brand_slug, s.year, SUM(s.quantity) as total
                    FROM sales_view s
                    JOIN brands b ON s.brand_id = b.id
                    WHERE s.year >= $1 AND s.year <= $2
                    GROUP BY b.id, b.name, b.slug, s.year
                    ORDER BY b.name, s.year
                `, [minYear, prevYear]),
                pool.query(`
                    SELECT b.id as brand_id, b.name as brand_name, b.slug as brand_slug, s.month, SUM(s.quantity) as total
                    FROM sales_view s
                    JOIN brands b ON s.brand_id = b.id
                    WHERE s.year = $1
                    GROUP BY b.id, b.name, b.slug, s.month
                    ORDER BY b.name, s.month
                `, [maxYear]),
                pool.query(`
                    SELECT b.id as brand_id, SUM(s.quantity) as total
                    FROM sales_view s
                    JOIN brands b ON s.brand_id = b.id
                    WHERE s.year = $1 AND s.month <= $2
                    GROUP BY b.id
                `, [prevYear, maxMonth]),
                pool.query(`
                    SELECT b.id as brand_id, SUM(s.quantity) as total
                    FROM sales_view s
                    JOIN brands b ON s.brand_id = b.id
                    WHERE s.year = $1 AND s.month <= $2
                    GROUP BY b.id
                `, [maxYear, maxMonth]),
                pool.query(`
                    SELECT year, SUM(quantity) as total
                    FROM sales_view
                    WHERE year >= $1 AND year <= $2
                    GROUP BY year
                    ORDER BY year
                `, [minYear, prevYear]),
                pool.query(`
                    SELECT month, SUM(quantity) as total
                    FROM sales_view
                    WHERE year = $1
                    GROUP BY month
                    ORDER BY month
                `, [maxYear]),
                pool.query('SELECT SUM(quantity) as total FROM sales_view WHERE year = $1 AND month <= $2', [prevYear, maxMonth]),
                pool.query('SELECT SUM(quantity) as total FROM sales_view WHERE year = $1 AND month <= $2', [maxYear, maxMonth])
            ]);

            const brandsMap = new Map();
            allBrandsRes.rows.forEach(row => {
                const distributorName = distributorBySlug.get(row.slug) || row.name;
                brandsMap.set(row.id, {
                    id: parseInt(row.id, 10),
                    name: row.name,
                    slug: row.slug,
                    distributor_name: distributorName,
                    yearly: {},
                    months: {},
                    prev_partial: 0,
                    curr_partial: 0
                });
            });

            yearlyRes.rows.forEach(row => {
                const brand = brandsMap.get(row.brand_id);
                if (brand) brand.yearly[row.year] = parseInt(row.total, 10);
            });
            monthlyRes.rows.forEach(row => {
                const brand = brandsMap.get(row.brand_id);
                if (brand) brand.months[row.month] = parseInt(row.total, 10);
            });
            prevPartialRes.rows.forEach(row => {
                const brand = brandsMap.get(row.brand_id);
                if (brand) brand.prev_partial = parseInt(row.total, 10);
            });
            currPartialRes.rows.forEach(row => {
                const brand = brandsMap.get(row.brand_id);
                if (brand) brand.curr_partial = parseInt(row.total, 10);
            });

            const totals = {
                yearly: {},
                months: {},
                prev_partial: parseInt(prevPartialTotalRes.rows[0]?.total || 0, 10),
                curr_partial: parseInt(currPartialTotalRes.rows[0]?.total || 0, 10)
            };
            yearlyTotalRes.rows.forEach(row => {
                totals.yearly[row.year] = parseInt(row.total, 10);
            });
            monthlyTotalRes.rows.forEach(row => {
                totals.months[row.month] = parseInt(row.total, 10);
            });
            totals.yoy_pct = calculateYoY(totals.curr_partial, totals.prev_partial);

            const activeBrands = Array.from(brandsMap.values())
                .filter(brand => brand.curr_partial > 0 || brand.prev_partial > 0)
                .map(brand => ({
                    ...brand,
                    yoy_pct: calculateYoY(brand.curr_partial, brand.prev_partial),
                    market_share_pct: totals.curr_partial ? roundMetric((brand.curr_partial * 100) / totals.curr_partial, 1) : 0
                }));

            const distributorMap = new Map();
            activeBrands.forEach(brand => {
                if (!distributorMap.has(brand.distributor_name)) {
                    distributorMap.set(brand.distributor_name, {
                        name: brand.distributor_name,
                        yearly: {},
                        months: {},
                        prev_partial: 0,
                        curr_partial: 0,
                        brands: [],
                        slugs: new Set()
                    });
                }

                const distributor = distributorMap.get(brand.distributor_name);
                distributor.brands.push(brand);
                distributor.slugs.add(brand.slug);
                years.forEach(year => {
                    distributor.yearly[year] = (distributor.yearly[year] || 0) + (brand.yearly[year] || 0);
                });
                for (let month = 1; month <= maxMonth; month += 1) {
                    distributor.months[month] = (distributor.months[month] || 0) + (brand.months[month] || 0);
                }
                distributor.prev_partial += brand.prev_partial;
                distributor.curr_partial += brand.curr_partial;
            });

            const sortedDistributors = Array.from(distributorMap.values())
                .map(distributor => {
                    const brands = distributor.brands
                        .map(brand => ({
                            ...brand,
                            distributor_share_pct: distributor.curr_partial
                                ? roundMetric((brand.curr_partial * 100) / distributor.curr_partial, 1)
                                : 0
                        }))
                        .sort((a, b) => b.curr_partial - a.curr_partial);

                    return {
                        name: distributor.name,
                        slugs: Array.from(distributor.slugs),
                        yearly: distributor.yearly,
                        months: distributor.months,
                        prev_partial: distributor.prev_partial,
                        curr_partial: distributor.curr_partial,
                        yoy_pct: calculateYoY(distributor.curr_partial, distributor.prev_partial),
                        share_pct: totals.curr_partial ? roundMetric((distributor.curr_partial * 100) / totals.curr_partial, 1) : 0,
                        brand_count: brands.length,
                        top_brand_name: brands[0]?.name || '-',
                        top_brand_sales: brands[0]?.curr_partial || 0,
                        type: brands.length > 1 ? 'multi-brand' : 'single-brand',
                        brands
                    };
                })
                .sort((a, b) => b.curr_partial - a.curr_partial)
                .map((distributor, index) => ({ ...distributor, rank: index + 1 }));

            const distributorVolumeMap = new Map(sortedDistributors.map(distributor => [distributor.name, distributor.curr_partial]));
            const sortedBrands = activeBrands
                .map(brand => ({
                    ...brand,
                    distributor_share_pct: distributorVolumeMap.get(brand.distributor_name)
                        ? roundMetric((brand.curr_partial * 100) / distributorVolumeMap.get(brand.distributor_name), 1)
                        : 0
                }))
                .sort((a, b) => b.curr_partial - a.curr_partial)
                .map((brand, index) => ({ ...brand, rank: index + 1 }));

            const top3DistributorShare = totals.curr_partial
                ? roundMetric((sortedDistributors.slice(0, 3).reduce((sum, item) => sum + item.curr_partial, 0) * 100) / totals.curr_partial, 1)
                : 0;
            const top5BrandShare = totals.curr_partial
                ? roundMetric((sortedBrands.slice(0, 5).reduce((sum, item) => sum + item.curr_partial, 0) * 100) / totals.curr_partial, 1)
                : 0;

            const fastDistributor = sortedDistributors
                .filter(distributor => distributor.curr_partial >= 100 && distributor.yoy_pct !== null)
                .sort((a, b) => b.yoy_pct - a.yoy_pct)[0] || null;
            const fastBrand = sortedBrands
                .filter(brand => brand.curr_partial >= 50 && brand.yoy_pct !== null)
                .sort((a, b) => b.yoy_pct - a.yoy_pct)[0] || null;

            res.json({
                min_year: minYear,
                max_year: maxYear,
                prev_year: prevYear,
                max_month: maxMonth,
                years,
                totals,
                concentration: {
                    active_distributors: sortedDistributors.length,
                    active_brands: sortedBrands.length,
                    single_brand_channels: sortedDistributors.filter(distributor => distributor.brand_count === 1).length,
                    top3_distributor_share_pct: top3DistributorShare,
                    top5_brand_share_pct: top5BrandShare,
                    top_distributor_name: sortedDistributors[0]?.name || '',
                    top_distributor_share_pct: sortedDistributors[0]?.share_pct || 0,
                    top_brand_name: sortedBrands[0]?.name || '',
                    top_brand_share_pct: sortedBrands[0]?.market_share_pct || 0,
                    fastest_distributor_name: fastDistributor?.name || '',
                    fastest_distributor_yoy_pct: fastDistributor?.yoy_pct ?? null,
                    fastest_brand_name: fastBrand?.name || '',
                    fastest_brand_yoy_pct: fastBrand?.yoy_pct ?? null
                },
                distributors: sortedDistributors,
                brands: sortedBrands
            });
        } catch (err) {
            console.error('Brand ecosystem error:', err);
            res.status(500).json({ error: 'Sunucu hatasi' });
        }
    });

    app.get('/api/sales/total-market', authMiddleware, async (req, res) => {
        try {
            const { brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;

            // Son veri noktasını bul
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            // Veri yoksa (taze kurulum) NaN SQL parametresine gitmesin: boş yanıt dön
            if (!Number.isFinite(maxYear)) return res.json({ prev_year: null, curr_year: null, max_month: null, brand_name: null, months: [], total_prev: 0, total_curr: 0, total_delta: null, brand_prev: 0, brand_curr: 0, brand_delta: null });
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;

            // Toplam pazar (tüm markalar) - aylık
            const totalRes = await pool.query(`
                SELECT year, month, SUM(quantity) as total
                FROM sales_view
                WHERE year IN ($1, $2)
                GROUP BY year, month ORDER BY year, month
            `, [prevYear, maxYear]);

            // Seçili marka - aylık
            let brandRes = { rows: [] };
            let brandName = null;
            if (userBrandId) {
                brandRes = await pool.query(`
                    SELECT year, month, SUM(quantity) as total
                    FROM sales_view
                    WHERE year IN ($1, $2) AND brand_id = $3
                    GROUP BY year, month ORDER BY year, month
                `, [prevYear, maxYear, userBrandId]);
                const brandInfo = await pool.query('SELECT name FROM brands WHERE id = $1', [userBrandId]);
                brandName = brandInfo.rows[0]?.name || null;
            }

            // Verileri düzenle
            const totalMonths = {};
            totalRes.rows.forEach(r => {
                if (!totalMonths[r.month]) totalMonths[r.month] = {};
                totalMonths[r.month][r.year] = parseInt(r.total);
            });
            const brandMonths = {};
            brandRes.rows.forEach(r => {
                if (!brandMonths[r.month]) brandMonths[r.month] = {};
                brandMonths[r.month][r.year] = parseInt(r.total);
            });

            const data = [];
            let tPrev = 0, tCurr = 0, bPrev = 0, bCurr = 0;
            for (let m = 1; m <= maxMonth; m++) {
                const tp = totalMonths[m]?.[prevYear] || 0;
                const tc = totalMonths[m]?.[maxYear] || 0;
                const bp = brandMonths[m]?.[prevYear] || 0;
                const bc = brandMonths[m]?.[maxYear] || 0;
                tPrev += tp; tCurr += tc; bPrev += bp; bCurr += bc;
                data.push({
                    month: m,
                    total_prev: tp, total_curr: tc,
                    total_delta: tp > 0 ? parseFloat(((tc - tp) * 100 / tp).toFixed(1)) : null,
                    brand_prev: bp, brand_curr: bc,
                    brand_delta: bp > 0 ? parseFloat(((bc - bp) * 100 / bp).toFixed(1)) : null
                });
            }

            res.json({
                prev_year: prevYear,
                curr_year: maxYear,
                max_month: maxMonth,
                brand_name: brandName,
                months: data,
                total_prev: tPrev, total_curr: tCurr,
                total_delta: tPrev > 0 ? parseFloat(((tCurr - tPrev) * 100 / tPrev).toFixed(1)) : null,
                brand_prev: bPrev, brand_curr: bCurr,
                brand_delta: bPrev > 0 ? parseFloat(((bCurr - bPrev) * 100 / bPrev).toFixed(1)) : null
            });
        } catch (err) {
            console.error('Total market error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // İl bazlı satış verileri (filtreleme destekli)
    app.get('/api/sales/by-province', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id, cabin_type, drive_type, hp_range, gear_config } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
            const targetYear = year && year !== 'all' ? parseInt(year, 10) : null;

            await ensureProvincesSeeded();

            const normalizedBrandExpr = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tv.marka
                END
            `;
            const hpRangeExpr = `
                CASE
                    WHEN tk.motor_gucu_hp IS NULL THEN NULL
                    WHEN tk.motor_gucu_hp <= 39 THEN '1-39'
                    WHEN tk.motor_gucu_hp <= 49 THEN '40-49'
                    WHEN tk.motor_gucu_hp <= 54 THEN '50-54'
                    WHEN tk.motor_gucu_hp <= 59 THEN '55-59'
                    WHEN tk.motor_gucu_hp <= 69 THEN '60-69'
                    WHEN tk.motor_gucu_hp <= 79 THEN '70-79'
                    WHEN tk.motor_gucu_hp <= 89 THEN '80-89'
                    WHEN tk.motor_gucu_hp <= 99 THEN '90-99'
                    WHEN tk.motor_gucu_hp <= 109 THEN '100-109'
                    WHEN tk.motor_gucu_hp <= 119 THEN '110-119'
                    WHEN tk.motor_gucu_hp > 120 THEN '120+'
                    ELSE NULL
                END
            `;
            const cabinTypeExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%rops%' OR LOWER(COALESCE(tk.koruma, '')) LIKE '%roll%' THEN 'rollbar'
                    ELSE NULL
                END
            `;

            const provinceTotalsYearWhere = Number.isFinite(targetYear)
                ? 'WHERE tv_all.tescil_yil = $1'
                : '';

            let query = `
                WITH province_totals AS (
                    SELECT
                        p_total.id AS province_id,
                        SUM(tv_all.satis_adet) AS province_total_sales
                    FROM tuik_veri tv_all
                    JOIN provinces p_total
                        ON p_total.plate_code = LPAD(COALESCE(tv_all.sehir_kodu, 0)::text, 2, '0')
                    ${provinceTotalsYearWhere}
                    GROUP BY p_total.id
                )
                SELECT
                    p.name as province_name,
                    p.plate_code,
                    p.latitude,
                    p.longitude,
                    p.region,
                    b.name as brand_name,
                    b.slug as brand_slug,
                    b.primary_color,
                    COALESCE(pt.province_total_sales, 0) as province_total_sales,
                    ${userBrandId ? "COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi) as model_name," : ""}
                    SUM(tv.satis_adet) as total_sales
                FROM tuik_veri tv
                JOIN brands b
                    ON UPPER(b.name) = UPPER(${normalizedBrandExpr})
                JOIN provinces p
                    ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                LEFT JOIN teknik_veri tk
                    ON UPPER(tk.marka) = UPPER(${normalizedBrandExpr})
                   AND UPPER(tk.tuik_model_adi) = UPPER(tv.tuik_model_adi)
                LEFT JOIN province_totals pt
                    ON pt.province_id = p.id
                WHERE 1=1
            `;

            const params = [];
            if (Number.isFinite(targetYear)) {
                params.push(targetYear);
                query += ` AND tv.tescil_yil = $${params.length}`;
            }
            if (userBrandId) {
                params.push(userBrandId);
                query += ` AND b.id = $${params.length}`;
            }
            if (cabin_type) {
                params.push(cabin_type);
                query += ` AND ${cabinTypeExpr} = $${params.length}`;
            }
            if (drive_type) {
                params.push(String(drive_type).toLowerCase());
                query += ` AND LOWER(COALESCE(tk.cekis_tipi, '')) = $${params.length}`;
            }
            if (hp_range) {
                params.push(hp_range);
                query += ` AND ${hpRangeExpr} = $${params.length}`;
            }
            if (gear_config) {
                params.push(gear_config);
                query += ` AND COALESCE(tk.vites_sayisi, '') = $${params.length}`;
            }

            query += `
                GROUP BY
                    p.id, p.name, p.plate_code, p.latitude, p.longitude, p.region,
                    b.id, b.name, b.slug, b.primary_color, pt.province_total_sales
                    ${userBrandId ? ", COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi)" : ""}
                ORDER BY total_sales DESC
            `;

            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            console.error('Sales by province error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Aylık satış trendi
    app.get('/api/sales/monthly-trend', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
            const targetYear = year || new Date().getFullYear();

            let query = `
                SELECT s.month, b.name as brand_name, b.primary_color,
                       SUM(s.quantity) as total_sales
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1
            `;
            const params = [targetYear];
            if (userBrandId) {
                params.push(userBrandId);
                query += ` AND s.brand_id = $${params.length}`;
            }
            query += ' GROUP BY s.month, b.id, b.name, b.primary_color ORDER BY s.month, b.name';
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/monthly-trend');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Pazar payı
    app.get('/api/sales/market-share', authMiddleware, async (req, res) => {
        try {
            const { year, province_id } = req.query;
            const targetYear = year || new Date().getFullYear();

            let query = `
                SELECT b.name as brand_name, b.slug, b.primary_color,
                       SUM(s.quantity) as brand_sales,
                       ROUND(SUM(s.quantity) * 100.0 / NULLIF((SELECT SUM(quantity) FROM sales_view WHERE year = $1), 0), 2) as market_share_pct
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1
            `;
            const params = [targetYear];
            if (province_id) {
                params.push(province_id);
                query += ` AND s.province_id = $${params.length}`;
            }
            query += ' GROUP BY b.id, b.name, b.slug, b.primary_color ORDER BY brand_sales DESC';
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/market-share');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Kategori bazlı analiz (kabinli/rollbar, 2wd/4wd, tarla/bahçe)
    app.get('/api/sales/by-category', authMiddleware, async (req, res) => {
        try {
            const { year, dimension, brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
            const targetYear = year || new Date().getFullYear();

            const validDimensions = {
                'cabin_type': 's.cabin_type',
                'drive_type': 's.drive_type',
                'category': 's.category',
                'hp_range': 's.hp_range',
                'gear_config': 's.gear_config'
            };

            const dim = validDimensions[dimension] || 's.category';
            let query = `
                SELECT ${dim} as dimension_value, b.name as brand_name, b.primary_color,
                       SUM(s.quantity) as total_sales
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND ${dim} IS NOT NULL
            `;
            const params = [targetYear];
            if (userBrandId) {
                params.push(userBrandId);
                query += ` AND s.brand_id = $${params.length}`;
            }
            query += ` GROUP BY ${dim}, b.id, b.name, b.primary_color ORDER BY total_sales DESC`;
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/by-category');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // HP aralığı karşılaştırma
    app.get('/api/sales/hp-comparison', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id } = req.query;
            const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
            const targetYear = year || new Date().getFullYear();

            let query = `
                SELECT s.hp_range, b.name as brand_name, b.primary_color,
                       SUM(s.quantity) as total_sales
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.hp_range IS NOT NULL
            `;
            const params = [targetYear];
            if (userBrandId) {
                params.push(userBrandId);
                query += ` AND s.brand_id = $${params.length}`;
            }
            query += ' GROUP BY s.hp_range, b.id, b.name, b.primary_color ORDER BY s.hp_range, total_sales DESC';
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/hp-comparison');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Rakip karşılaştırma
    app.get('/api/sales/competitor-compare', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id, competitor_ids } = req.query;
            const userBrandId = req.user.role === 'admin' ? brand_id : req.user.brand_id;
            const targetYear = year || new Date().getFullYear();

            if (!userBrandId) return res.status(400).json({ error: 'brand_id gerekli' });

            const compIds = competitor_ids ? competitor_ids.split(',').map(Number) : [];
            const allBrandIds = [parseInt(userBrandId), ...compIds];

            const result = await pool.query(`
                SELECT b.name as brand_name, b.slug, b.primary_color,
                       s.category, s.cabin_type, s.drive_type, s.hp_range, s.gear_config,
                       SUM(s.quantity) as total_sales
                FROM sales_view s JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1 AND s.brand_id = ANY($2)
                GROUP BY b.id, b.name, b.slug, b.primary_color, s.category, s.cabin_type, s.drive_type, s.hp_range, s.gear_config
                ORDER BY b.name, total_sales DESC
            `, [targetYear, allBrandIds]);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/sales/competitor-compare');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

};
