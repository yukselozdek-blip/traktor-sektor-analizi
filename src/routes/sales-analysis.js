'use strict';
// Bölgesel mekanizasyon endeksi, benchmark ve marka karşılaştırma route'ları, server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerSalesAnalysis(app, ctx) {
    const { pool, authMiddleware, formatPeriodLabel, roundMetric, calculateYoY, getBrandSqlAliases, requireFeature } = ctx;

    // ============================================
    // REGIONAL MECHANIZATION INDEX
    // ============================================
    app.get('/api/sales/regional-index', authMiddleware, async (req, res) => {
        try {
            const { year, metric } = req.query;
            const latestRes = await pool.query('SELECT MAX(tescil_yil) as max_year FROM tuik_veri');
            const maxYear = parseInt(latestRes.rows[0].max_year, 10);
            const targetYear = year ? parseInt(year, 10) : maxYear;
            const latestMonthRes = await pool.query('SELECT COALESCE(MAX(tescil_ay), 12) as max_month FROM tuik_veri WHERE tescil_yil = $1', [targetYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month || 12, 10);
            const trendYears = [targetYear - 2, targetYear - 1, targetYear].filter(item => item > 0);

            const normalizedBrandExprTv = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tv.marka
                END
            `;
            const normalizedBrandExprTk = `
                CASE
                    WHEN UPPER(tk.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tk.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tk.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tk.marka
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
                    ELSE '120+'
                END
            `;
            const categoryExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' OR LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahçe%' THEN 'bahce'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                    ELSE NULL
                END
            `;
            const driveExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%4wd%' OR LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%4x4%' OR LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%4 wd%' THEN '4WD'
                    WHEN LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%2wd%' OR LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%2x4%' OR LOWER(COALESCE(tk.cekis_tipi, '')) LIKE '%2 wd%' THEN '2WD'
                    ELSE NULL
                END
            `;
            const cabinExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%rops%' OR LOWER(COALESCE(tk.koruma, '')) LIKE '%roll%' THEN 'rollbar'
                    ELSE NULL
                END
            `;
            const gearExpr = `NULLIF(TRIM(COALESCE(tk.vites_sayisi, '')), '')`;

            // Province info
            const provRes = await pool.query(`SELECT id, name, plate_code, region, latitude, longitude, population, agricultural_area_hectare, primary_crops, soil_type, climate_zone, annual_rainfall_mm, avg_temperature, elevation_m FROM provinces ORDER BY name`);

            const [salesRes, trendRes] = await Promise.all([
                pool.query(`
                    WITH teknik_match AS (
                        SELECT DISTINCT ON (UPPER(${normalizedBrandExprTk}), UPPER(COALESCE(tk.tuik_model_adi, '')))
                            UPPER(${normalizedBrandExprTk}) AS brand_key,
                            UPPER(COALESCE(tk.tuik_model_adi, '')) AS model_key,
                            tk.motor_gucu_hp,
                            tk.kullanim_alani,
                            tk.cekis_tipi,
                            tk.koruma,
                            tk.vites_sayisi
                        FROM teknik_veri tk
                        ORDER BY UPPER(${normalizedBrandExprTk}), UPPER(COALESCE(tk.tuik_model_adi, '')), tk.motor_gucu_hp DESC NULLS LAST
                    )
                    SELECT
                        p.id AS province_id,
                        ${categoryExpr} AS category,
                        ${hpRangeExpr} AS hp_range,
                        ${driveExpr} AS drive_type,
                        ${cabinExpr} AS cabin_type,
                        ${gearExpr} AS gear_config,
                        SUM(tv.satis_adet)::int AS total
                    FROM tuik_veri tv
                    JOIN provinces p
                        ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    LEFT JOIN teknik_match tk
                        ON tk.brand_key = UPPER(${normalizedBrandExprTv})
                       AND tk.model_key = UPPER(COALESCE(tv.tuik_model_adi, ''))
                    WHERE tv.tescil_yil = $1
                      AND tv.tescil_ay <= $2
                      AND (tv.model_yili IS NULL OR tv.tescil_yil = tv.model_yili OR tv.tescil_yil = tv.model_yili + 1)
                    GROUP BY p.id, ${categoryExpr}, ${hpRangeExpr}, ${driveExpr}, ${cabinExpr}, ${gearExpr}
                `, [targetYear, maxMonth]),
                pool.query(`
                    SELECT
                        p.id AS province_id,
                        tv.tescil_yil AS year,
                        SUM(tv.satis_adet)::int AS total
                    FROM tuik_veri tv
                    JOIN provinces p
                        ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    WHERE tv.tescil_yil = ANY($1)
                      AND tv.tescil_ay <= $2
                      AND (tv.model_yili IS NULL OR tv.tescil_yil = tv.model_yili OR tv.tescil_yil = tv.model_yili + 1)
                    GROUP BY p.id, tv.tescil_yil
                `, [trendYears, maxMonth])
            ]);
            const trendMap = {};
            trendRes.rows.forEach(r => {
                if (!trendMap[r.province_id]) trendMap[r.province_id] = {};
                trendMap[r.province_id][r.year] = parseInt(r.total);
            });

            // Build province data
            const provData = {};
            salesRes.rows.forEach(r => {
                const pid = r.province_id;
                if (!provData[pid]) provData[pid] = { total: 0, bahce: 0, tarla: 0, hp: {}, drive: {}, cabin: {}, gear: {} };
                const qty = parseInt(r.total);
                provData[pid].total += qty;
                if (r.category === 'bahce') provData[pid].bahce += qty;
                if (r.category === 'tarla') provData[pid].tarla += qty;
                provData[pid].hp[r.hp_range] = (provData[pid].hp[r.hp_range] || 0) + qty;
                provData[pid].drive[r.drive_type] = (provData[pid].drive[r.drive_type] || 0) + qty;
                provData[pid].cabin[r.cabin_type] = (provData[pid].cabin[r.cabin_type] || 0) + qty;
                provData[pid].gear[r.gear_config] = (provData[pid].gear[r.gear_config] || 0) + qty;
            });

            // Compute avg HP per province
            const hpMidpoints = { '1-39': 25, '40-49': 45, '50-54': 52, '55-59': 57, '60-69': 65, '70-79': 75, '80-89': 85, '90-99': 95, '100-109': 105, '110-119': 115, '120+': 130 };

            const provinces = provRes.rows.map(p => {
                const d = provData[p.id] || { total: 0, bahce: 0, tarla: 0, hp: {}, drive: {}, cabin: {}, gear: {} };
                // Avg HP
                let hpSum = 0, hpCount = 0;
                Object.entries(d.hp).forEach(([range, qty]) => { hpSum += (hpMidpoints[range] || 60) * qty; hpCount += qty; });
                const avgHp = hpCount > 0 ? hpSum / hpCount : 0;
                // Dominant HP
                const dominantHp = Object.entries(d.hp).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
                // Bahce ratio
                const bahceRatio = d.total > 0 ? (d.bahce / d.total * 100) : 0;
                const tarlaRatio = d.total > 0 ? (d.tarla / d.total * 100) : 0;
                // 4WD ratio
                const ratio4wd = d.total > 0 ? ((d.drive['4WD'] || 0) / d.total * 100) : 0;
                // Cabin ratio
                const cabinRatio = d.total > 0 ? ((d.cabin['kabinli'] || 0) / d.total * 100) : 0;
                // Mechanization index: tractors per 1000 ha
                const mechIndex = p.agricultural_area_hectare && p.agricultural_area_hectare > 0
                    ? (d.total / (parseFloat(p.agricultural_area_hectare) / 1000)) : 0;
                // Growth trend
                const trend = trendMap[p.id] || {};
                const prevYearSales = trend[targetYear - 1] || 0;
                const currYearSales = trend[targetYear] || 0;
                const yoyGrowth = prevYearSales > 0 ? ((currYearSales - prevYearSales) / prevYearSales * 100) : 0;

                // HP distribution for this province
                const hpDist = {};
                Object.entries(d.hp).forEach(([range, qty]) => { hpDist[range] = { qty, pct: d.total > 0 ? qty / d.total * 100 : 0 }; });

                return {
                    id: p.id, name: p.name, plate_code: p.plate_code, region: p.region,
                    lat: parseFloat(p.latitude), lng: parseFloat(p.longitude),
                    population: p.population,
                    agricultural_area: p.agricultural_area_hectare ? parseFloat(p.agricultural_area_hectare) : null,
                    primary_crops: p.primary_crops, soil_type: p.soil_type,
                    climate_zone: p.climate_zone,
                    rainfall: p.annual_rainfall_mm ? parseFloat(p.annual_rainfall_mm) : null,
                    avg_temp: p.avg_temperature ? parseFloat(p.avg_temperature) : null,
                    elevation: p.elevation_m,
                    total: d.total, bahce: d.bahce, tarla: d.tarla,
                    avgHp: Math.round(avgHp), dominantHp, bahceRatio, tarlaRatio,
                    ratio4wd, cabinRatio, mechIndex: Math.round(mechIndex * 10) / 10,
                    yoyGrowth: Math.round(yoyGrowth * 10) / 10,
                    hpDist,
                    trend: trendYears.map(y => ({ year: y, sales: trend[y] || 0 }))
                };
            });

            res.json({ year: targetYear, maxMonth, provinces, trendYears });
        } catch (err) {
            console.error('Regional index error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // MODEL-REGION COMPATIBILITY
    // ============================================
    app.get('/api/sales/model-region-legacy', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = [];
            for (let y = minYear; y <= maxYear; y++) years.push(y);

            // Province info with agriculture
            const provRes = await pool.query(`SELECT id, name, plate_code, region, latitude, longitude, population, agricultural_area_hectare, primary_crops, soil_type, climate_zone, annual_rainfall_mm, avg_temperature, elevation_m FROM provinces ORDER BY name`);
            const provMap = {};
            provRes.rows.forEach(p => { provMap[p.id] = p; });

            // Brands with their HP ranges and categories
            const brandRes = await pool.query('SELECT id, name, slug, primary_color FROM brands WHERE is_active = true ORDER BY name');

            // Models with prices
            const modelRes = await pool.query(`SELECT m.id, m.brand_id, m.model_name, m.horsepower, m.hp_range, m.category, m.cabin_type, m.drive_type, m.gear_config, m.price_usd, b.name as brand_name, b.primary_color FROM tractor_models m JOIN brands b ON m.brand_id = b.id WHERE m.is_current_model = true ORDER BY b.name, m.horsepower`);

            // Sales by province, brand, year with details
            const salesRes = await pool.query(`
                SELECT s.province_id, s.brand_id, s.year, s.category, s.hp_range, s.cabin_type, s.drive_type, s.gear_config,
                       SUM(s.quantity) as total
                FROM sales_view s
                GROUP BY s.province_id, s.brand_id, s.year, s.category, s.hp_range, s.cabin_type, s.drive_type, s.gear_config
            `);

            // Build brand-province-year matrix
            const bpMatrix = {}; // brand_id -> province_id -> year -> total
            const brandProvCat = {}; // brand_id -> province_id -> {bahce, tarla, total, hps, ...}
            salesRes.rows.forEach(r => {
                const bid = r.brand_id, pid = r.province_id, yr = r.year;
                const qty = parseInt(r.total);
                if (!bpMatrix[bid]) bpMatrix[bid] = {};
                if (!bpMatrix[bid][pid]) bpMatrix[bid][pid] = {};
                bpMatrix[bid][pid][yr] = (bpMatrix[bid][pid][yr] || 0) + qty;

                if (!brandProvCat[bid]) brandProvCat[bid] = {};
                if (!brandProvCat[bid][pid]) brandProvCat[bid][pid] = { total: 0, bahce: 0, tarla: 0, hps: {}, years: {} };
                const bpc = brandProvCat[bid][pid];
                bpc.total += qty;
                if (r.category === 'bahce') bpc.bahce += qty;
                if (r.category === 'tarla') bpc.tarla += qty;
                bpc.hps[r.hp_range] = (bpc.hps[r.hp_range] || 0) + qty;
                bpc.years[yr] = (bpc.years[yr] || 0) + qty;
            });

            // Total market by province by year
            const marketByProv = {};
            salesRes.rows.forEach(r => {
                const pid = r.province_id, yr = r.year;
                if (!marketByProv[pid]) marketByProv[pid] = {};
                marketByProv[pid][yr] = (marketByProv[pid][yr] || 0) + parseInt(r.total);
            });

            // For each brand, compute top regions and compatibility scores
            const brands = brandRes.rows.map(b => {
                const provStats = [];
                const bData = brandProvCat[b.id] || {};

                Object.entries(bData).forEach(([pid, data]) => {
                    const prov = provMap[pid];
                    if (!prov) return;
                    const mktData = marketByProv[pid] || {};

                    // Market share in this province (all years combined)
                    let totalMarket = 0;
                    Object.values(mktData).forEach(v => totalMarket += v);
                    const marketShareAll = totalMarket > 0 ? (data.total / totalMarket * 100) : 0;

                    // Current year market share
                    const currBrand = data.years[maxYear] || 0;
                    const currMarket = mktData[maxYear] || 0;
                    const marketShareCurr = currMarket > 0 ? (currBrand / currMarket * 100) : 0;

                    // Trend: CAGR-like
                    const firstYear = years.find(y => data.years[y] > 0);
                    const lastYearSales = data.years[maxYear] || 0;
                    const prevYearSales = data.years[maxYear - 1] || 0;
                    const yoyGrowth = prevYearSales > 0 ? ((lastYearSales - prevYearSales) / prevYearSales * 100) : 0;

                    // Revenue estimate (using avg model price for this brand)
                    const brandModels = modelRes.rows.filter(m => m.brand_id == b.id && m.price_usd);
                    const avgPrice = brandModels.length > 0 ? brandModels.reduce((s, m) => s + parseFloat(m.price_usd), 0) / brandModels.length : 0;
                    const estimatedRevenue = data.total * avgPrice;
                    const currRevenue = currBrand * avgPrice;

                    provStats.push({
                        province_id: parseInt(pid),
                        name: prov.name,
                        plate_code: prov.plate_code,
                        region: prov.region,
                        lat: parseFloat(prov.latitude),
                        lng: parseFloat(prov.longitude),
                        soil_type: prov.soil_type,
                        climate_zone: prov.climate_zone,
                        primary_crops: prov.primary_crops,
                        rainfall: prov.annual_rainfall_mm ? parseFloat(prov.annual_rainfall_mm) : null,
                        elevation: prov.elevation_m,
                        total: data.total,
                        bahce: data.bahce,
                        tarla: data.tarla,
                        yearlyTrend: years.map(y => ({ year: y, sales: data.years[y] || 0 })),
                        marketShareAll: Math.round(marketShareAll * 10) / 10,
                        marketShareCurr: Math.round(marketShareCurr * 10) / 10,
                        yoyGrowth: Math.round(yoyGrowth * 10) / 10,
                        estimatedRevenue,
                        currRevenue,
                        dominantHp: Object.entries(data.hps).sort((a, b) => b[1] - a[1])[0]?.[0] || '-'
                    });
                });

                provStats.sort((a, b) => b.total - a.total);
                const totalBrandSales = provStats.reduce((s, p) => s + p.total, 0);
                const totalRevenue = provStats.reduce((s, p) => s + p.estimatedRevenue, 0);

                return {
                    id: b.id, name: b.name, slug: b.slug, color: b.primary_color,
                    totalSales: totalBrandSales,
                    totalRevenue,
                    models: modelRes.rows.filter(m => m.brand_id == b.id).map(m => ({
                        name: m.model_name, hp: parseFloat(m.horsepower), price: m.price_usd ? parseFloat(m.price_usd) : null,
                        category: m.category, hp_range: m.hp_range
                    })),
                    topProvinces: provStats.slice(0, 15),
                    provinceCount: provStats.filter(p => p.total > 0).length
                };
            });

            res.json({ years, max_year: maxYear, max_month: maxMonth, brands });
        } catch (err) {
            console.error('Model-region error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // TECHNICAL BENCHMARKING & GAP ANALYSIS
    // ============================================
    app.get('/api/sales/benchmark', authMiddleware, async (req, res) => {
        try {
            const { brand1_id, brand2_id } = req.query;
            if (!brand1_id || !brand2_id) return res.status(400).json({ error: 'brand1_id ve brand2_id gerekli' });

            {
                const requestedIds = [parseInt(brand1_id, 10), parseInt(brand2_id, 10)].filter(Number.isFinite);
                const compareLatestRes = await pool.query('SELECT MAX(tescil_yil) as max_year FROM tuik_veri');
                const compareMaxYear = parseInt(compareLatestRes.rows[0].max_year, 10);
                const compareLatestMonthRes = await pool.query('SELECT MAX(tescil_ay) as max_month FROM tuik_veri WHERE tescil_yil = $1', [compareMaxYear]);
                const compareMaxMonth = parseInt(compareLatestMonthRes.rows[0].max_month, 10);
                const comparePrevYear = compareMaxYear - 1;
                const compareMinYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
                const compareMinYear = parseInt(compareMinYearRes.rows[0].min_year, 10);
                const compareYears = Array.from({ length: Math.max(compareMaxYear - compareMinYear + 1, 0) }, (_, index) => compareMinYear + index);
                const compareHpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
                const compareHpMidpoints = { '1-39': 25, '40-49': 45, '50-54': 52, '55-59': 57, '60-69': 65, '70-79': 75, '80-89': 85, '90-99': 95, '100-109': 105, '110-119': 115, '120+': 130 };

                const [compareBrandRes, compareMarketYearlyRes, compareMarketCurrentRes, compareMarketPrevRes, compareMarketHpRes] = await Promise.all([
                    pool.query(`
                        SELECT id, name, slug, primary_color, secondary_color, country_of_origin, parent_company
                        FROM brands
                        WHERE id = ANY($1::int[])
                    `, [requestedIds]),
                    pool.query(`
                        SELECT year, SUM(quantity)::int AS total
                        FROM sales_view
                        GROUP BY year
                        ORDER BY year
                    `),
                    pool.query(`
                        SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                        FROM sales_view
                        WHERE year = $1 AND month <= $2
                    `, [compareMaxYear, compareMaxMonth]),
                    pool.query(`
                        SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                        FROM sales_view
                        WHERE year = $1 AND month <= $2
                    `, [comparePrevYear, compareMaxMonth]),
                    pool.query(`
                        SELECT hp_range, SUM(quantity)::int AS total
                        FROM sales_view
                        WHERE year = $1 AND month <= $2 AND hp_range IS NOT NULL
                        GROUP BY hp_range
                    `, [compareMaxYear, compareMaxMonth])
                ]);

                const compareBrandMap = new Map(compareBrandRes.rows.map(row => [parseInt(row.id, 10), row]));
                const compareFirstBrand = compareBrandMap.get(requestedIds[0]);
                const compareSecondBrand = compareBrandMap.get(requestedIds[1]);
                if (!compareFirstBrand || !compareSecondBrand) {
                    return res.status(404).json({ error: 'Marka bulunamadi' });
                }

                const compareMarketYearly = {};
                compareYears.forEach(year => { compareMarketYearly[year] = 0; });
                compareMarketYearlyRes.rows.forEach(row => {
                    compareMarketYearly[parseInt(row.year, 10)] = parseInt(row.total, 10) || 0;
                });
                const compareMarketCurrent = parseInt(compareMarketCurrentRes.rows[0]?.total_sales || 0, 10);
                const compareMarketPrevious = parseInt(compareMarketPrevRes.rows[0]?.total_sales || 0, 10);
                const compareMarketHp = {};
                compareMarketHpRes.rows.forEach(row => {
                    compareMarketHp[row.hp_range] = parseInt(row.total, 10) || 0;
                });

                async function buildDeepCompareBrandData(brand) {
                    const brandAliases = getBrandSqlAliases(brand);
                    const [
                        currentSalesRes,
                        previousSalesRes,
                        yearlyRes,
                        monthlyRes,
                        hpRes,
                        categoryRes,
                        driveRes,
                        cabinRes,
                        gearRes,
                        provinceRes,
                        technicalSummaryRes,
                        topModelsRes,
                        catalogRes,
                        featureComboRes
                    ] = await Promise.all([
                        pool.query(`
                            SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                        `, [brand.id, comparePrevYear, compareMaxMonth]),
                        pool.query(`
                            SELECT year, SUM(quantity)::int AS total
                            FROM sales_view
                            WHERE brand_id = $1
                            GROUP BY year
                            ORDER BY year
                        `, [brand.id]),
                        pool.query(`
                            SELECT month, SUM(quantity)::int AS total
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY month
                            ORDER BY month
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT hp_range, SUM(quantity)::int AS total
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3 AND hp_range IS NOT NULL
                            GROUP BY hp_range
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT COALESCE(category, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY category
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT UPPER(COALESCE(drive_type, 'belirsiz')) AS label, SUM(quantity)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY drive_type
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT LOWER(COALESCE(cabin_type, 'belirsiz')) AS label, SUM(quantity)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY cabin_type
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT COALESCE(gear_config, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY gear_config
                        `, [brand.id, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            SELECT
                                tv.tescil_yil AS year,
                                p.id AS province_id,
                                p.name AS province_name,
                                p.region,
                                SUM(tv.satis_adet)::int AS total_sales
                            FROM tuik_veri tv
                            JOIN provinces p
                                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                            WHERE UPPER(tv.marka) = ANY($1::text[])
                              AND tv.tescil_yil IN ($2, $3)
                              AND tv.tescil_ay <= $4
                            GROUP BY tv.tescil_yil, p.id, p.name, p.region
                            ORDER BY tv.tescil_yil ASC, total_sales DESC, p.name ASC
                        `, [brandAliases, comparePrevYear, compareMaxYear, compareMaxMonth]),
                        pool.query(`
                            WITH grouped_models AS (
                                SELECT
                                    COALESCE(NULLIF(model, ''), tuik_model_adi) AS model_name,
                                    ROUND(AVG(motor_gucu_hp)::numeric, 1) AS avg_hp,
                                    MIN(fiyat_usd) FILTER (WHERE fiyat_usd IS NOT NULL AND fiyat_usd > 0) AS min_price_usd,
                                    MAX(fiyat_usd) FILTER (WHERE fiyat_usd IS NOT NULL AND fiyat_usd > 0) AS max_price_usd
                                FROM teknik_veri
                                WHERE UPPER(marka) = ANY($1::text[])
                                GROUP BY COALESCE(NULLIF(model, ''), tuik_model_adi)
                            )
                            SELECT
                                COUNT(*)::int AS technical_model_count,
                                (SELECT COUNT(*)::int FROM teknik_veri WHERE UPPER(marka) = ANY($1::text[])) AS variant_count,
                                ROUND(AVG(avg_hp)::numeric, 1) AS avg_hp,
                                (SELECT ROUND(AVG(fiyat_usd)::numeric, 2) FROM teknik_veri WHERE UPPER(marka) = ANY($1::text[]) AND fiyat_usd IS NOT NULL AND fiyat_usd > 0) AS avg_price_usd,
                                MIN(min_price_usd) AS min_price_usd,
                                MAX(max_price_usd) AS max_price_usd
                            FROM grouped_models
                        `, [brandAliases]),
                        pool.query(`
                            SELECT
                                COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi) AS model_name,
                                SUM(tv.satis_adet)::int AS total_sales,
                                ROUND(AVG(tk.motor_gucu_hp)::numeric, 1) AS avg_hp,
                                MIN(tk.fiyat_usd) FILTER (WHERE tk.fiyat_usd IS NOT NULL AND tk.fiyat_usd > 0) AS min_price_usd,
                                MAX(tk.fiyat_usd) FILTER (WHERE tk.fiyat_usd IS NOT NULL AND tk.fiyat_usd > 0) AS max_price_usd,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(COALESCE(tk.cekis_tipi, ''))), '') AS drive_types,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(tk.koruma, '')), '') AS protections,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(tk.vites_sayisi, '')), '') AS gear_configs,
                                MAX(NULLIF(tk.emisyon_seviyesi, '')) AS emission_standard
                            FROM tuik_veri tv
                            LEFT JOIN teknik_veri tk
                                ON UPPER(tk.marka) = ANY($4::text[])
                               AND UPPER(tk.tuik_model_adi) = UPPER(tv.tuik_model_adi)
                            WHERE UPPER(tv.marka) = ANY($1::text[])
                              AND tv.tescil_yil = $2
                              AND tv.tescil_ay <= $3
                            GROUP BY COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi)
                            ORDER BY total_sales DESC, model_name ASC
                            LIMIT 16
                        `, [brandAliases, compareMaxYear, compareMaxMonth, brandAliases]),
                        pool.query(`
                            SELECT
                                COALESCE(NULLIF(model, ''), tuik_model_adi) AS model_name,
                                ROUND(AVG(motor_gucu_hp)::numeric, 1) AS avg_hp,
                                MIN(fiyat_usd) FILTER (WHERE fiyat_usd IS NOT NULL AND fiyat_usd > 0) AS min_price_usd,
                                MAX(fiyat_usd) FILTER (WHERE fiyat_usd IS NOT NULL AND fiyat_usd > 0) AS max_price_usd,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(COALESCE(cekis_tipi, ''))), '') AS drive_types,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(koruma, '')), '') AS protections,
                                ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(vites_sayisi, '')), '') AS gear_configs,
                                MAX(NULLIF(emisyon_seviyesi, '')) AS emission_standard,
                                MAX(NULLIF(mensei, '')) AS origin
                            FROM teknik_veri
                            WHERE UPPER(marka) = ANY($1::text[])
                            GROUP BY COALESCE(NULLIF(model, ''), tuik_model_adi)
                            ORDER BY avg_hp ASC NULLS LAST, model_name ASC
                            LIMIT 28
                        `, [brandAliases]),
                        pool.query(`
                            SELECT
                                UPPER(COALESCE(drive_type, '-')) AS drive_type,
                                LOWER(COALESCE(cabin_type, '-')) AS cabin_type,
                                LOWER(COALESCE(category, '-')) AS category,
                                SUM(quantity)::int AS total_sales
                            FROM sales_view
                            WHERE brand_id = $1 AND year = $2 AND month <= $3
                            GROUP BY drive_type, cabin_type, category
                        `, [brand.id, compareMaxYear, compareMaxMonth])
                    ]);

                    const currentSales = parseInt(currentSalesRes.rows[0]?.total_sales || 0, 10);
                    const prevSales = parseInt(previousSalesRes.rows[0]?.total_sales || 0, 10);
                    const yoyGrowth = calculateYoY(currentSales, prevSales);

                    const yearly = {};
                    compareYears.forEach(year => { yearly[year] = 0; });
                    yearlyRes.rows.forEach(row => {
                        yearly[parseInt(row.year, 10)] = parseInt(row.total, 10) || 0;
                    });

                    const monthly = {};
                    for (let month = 1; month <= compareMaxMonth; month++) monthly[month] = 0;
                    monthlyRes.rows.forEach(row => {
                        monthly[parseInt(row.month, 10)] = parseInt(row.total, 10) || 0;
                    });

                    const marketShare = {};
                    compareYears.forEach(year => {
                        marketShare[year] = compareMarketYearly[year] > 0 ? roundMetric((yearly[year] * 100) / compareMarketYearly[year], 2) : 0;
                    });
                    const currentShare = compareMarketCurrent > 0 ? roundMetric((currentSales * 100) / compareMarketCurrent, 2) : 0;
                    const previousShare = compareMarketPrevious > 0 ? roundMetric((prevSales * 100) / compareMarketPrevious, 2) : 0;
                    const shareDeltaPp = roundMetric(currentShare - previousShare, 2);

                    const hpBag = {};
                    hpRes.rows.forEach(row => { hpBag[row.hp_range] = parseInt(row.total, 10) || 0; });
                    let salesWeightedHpRaw = 0;
                    const hpDist = compareHpOrder.map(hp => {
                        const qty = hpBag[hp] || 0;
                        salesWeightedHpRaw += (compareHpMidpoints[hp] || 60) * qty;
                        return {
                            hp,
                            qty,
                            pct: currentSales > 0 ? roundMetric((qty * 100) / currentSales, 1) : 0,
                            marketSharePct: (compareMarketHp[hp] || 0) > 0 ? roundMetric((qty * 100) / compareMarketHp[hp], 1) : 0
                        };
                    });
                    const salesWeightedHp = currentSales > 0 ? roundMetric(salesWeightedHpRaw / currentSales, 1) : 0;

                    const categories = {};
                    categoryRes.rows.forEach(row => { categories[row.label || 'belirsiz'] = parseInt(row.total_sales, 10) || 0; });
                    const driveTypes = {};
                    driveRes.rows.forEach(row => { driveTypes[row.label || 'belirsiz'] = parseInt(row.total_sales, 10) || 0; });
                    const cabinTypes = {};
                    cabinRes.rows.forEach(row => { cabinTypes[row.label || 'belirsiz'] = parseInt(row.total_sales, 10) || 0; });
                    const gearTypes = {};
                    gearRes.rows.forEach(row => { gearTypes[row.label || 'belirsiz'] = parseInt(row.total_sales, 10) || 0; });

                    const provincePrevMap = new Map();
                    const provincesCurrent = [];
                    provinceRes.rows.forEach(row => {
                        const rowYear = parseInt(row.year, 10);
                        const quantity = parseInt(row.total_sales, 10) || 0;
                        if (rowYear === comparePrevYear) provincePrevMap.set(parseInt(row.province_id, 10), quantity);
                        if (rowYear === compareMaxYear) {
                            provincesCurrent.push({
                                id: parseInt(row.province_id, 10),
                                name: row.province_name,
                                region: row.region,
                                qty: quantity
                            });
                        }
                    });

                    const provinces = provincesCurrent
                        .map(item => {
                            const previousQty = provincePrevMap.get(item.id) || 0;
                            return {
                                name: item.name,
                                region: item.region,
                                qty: item.qty,
                                prev_qty: previousQty,
                                yoy_pct: calculateYoY(item.qty, previousQty),
                                share_pct: currentSales > 0 ? roundMetric((item.qty * 100) / currentSales, 1) : 0
                            };
                        })
                        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

                    const regionCurrentBag = {};
                    const regionPreviousBag = {};
                    provinces.forEach(item => {
                        regionCurrentBag[item.region] = (regionCurrentBag[item.region] || 0) + item.qty;
                        regionPreviousBag[item.region] = (regionPreviousBag[item.region] || 0) + (item.prev_qty || 0);
                    });
                    const regions = Object.keys(regionCurrentBag)
                        .map(region => ({
                            name: region,
                            qty: regionCurrentBag[region] || 0,
                            prev_qty: regionPreviousBag[region] || 0,
                            yoy_pct: calculateYoY(regionCurrentBag[region] || 0, regionPreviousBag[region] || 0),
                            share_pct: currentSales > 0 ? roundMetric(((regionCurrentBag[region] || 0) * 100) / currentSales, 1) : 0
                        }))
                        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));

                    const technicalSummary = technicalSummaryRes.rows[0] || {};
                    const avgPrice = technicalSummary.avg_price_usd ? parseFloat(technicalSummary.avg_price_usd) : 0;
                    const minPrice = technicalSummary.min_price_usd ? parseFloat(technicalSummary.min_price_usd) : 0;
                    const maxPrice = technicalSummary.max_price_usd ? parseFloat(technicalSummary.max_price_usd) : 0;
                    const portfolioAvgHp = technicalSummary.avg_hp ? parseFloat(technicalSummary.avg_hp) : 0;
                    const modelCount = parseInt(technicalSummary.technical_model_count || 0, 10);
                    const variantCount = parseInt(technicalSummary.variant_count || 0, 10);
                    const costPerHp = avgPrice > 0 && portfolioAvgHp > 0 ? roundMetric(avgPrice / portfolioAvgHp, 1) : 0;

                    const topModelSalesMap = new Map();
                    topModelsRes.rows.forEach(row => {
                        const modelName = row.model_name || 'Model';
                        topModelSalesMap.set(modelName, {
                            name: modelName,
                            currentSales: parseInt(row.total_sales, 10) || 0,
                            hp: row.avg_hp ? parseFloat(row.avg_hp) : null,
                            minPrice: row.min_price_usd ? parseFloat(row.min_price_usd) : 0,
                            maxPrice: row.max_price_usd ? parseFloat(row.max_price_usd) : 0,
                            price: row.min_price_usd ? parseFloat(row.min_price_usd) : (row.max_price_usd ? parseFloat(row.max_price_usd) : 0),
                            driveTypes: Array.isArray(row.drive_types) ? row.drive_types.filter(Boolean) : [],
                            protections: Array.isArray(row.protections) ? row.protections.filter(Boolean) : [],
                            gearConfigs: Array.isArray(row.gear_configs) ? row.gear_configs.filter(Boolean) : [],
                            emission: row.emission_standard || null
                        });
                    });

                    const catalogModels = catalogRes.rows.map(row => {
                        const modelName = row.model_name || 'Model';
                        const currentModel = topModelSalesMap.get(modelName);
                        const minModelPrice = row.min_price_usd ? parseFloat(row.min_price_usd) : (currentModel?.minPrice || 0);
                        const maxModelPrice = row.max_price_usd ? parseFloat(row.max_price_usd) : (currentModel?.maxPrice || 0);
                        const basePrice = minModelPrice || maxModelPrice || currentModel?.price || 0;
                        return {
                            name: modelName,
                            hp: row.avg_hp ? parseFloat(row.avg_hp) : (currentModel?.hp || null),
                            minPrice: minModelPrice,
                            maxPrice: maxModelPrice,
                            price: basePrice,
                            currentSales: currentModel?.currentSales || 0,
                            driveTypes: Array.isArray(row.drive_types) ? row.drive_types.filter(Boolean) : (currentModel?.driveTypes || []),
                            protections: Array.isArray(row.protections) ? row.protections.filter(Boolean) : (currentModel?.protections || []),
                            gearConfigs: Array.isArray(row.gear_configs) ? row.gear_configs.filter(Boolean) : (currentModel?.gearConfigs || []),
                            emission: row.emission_standard || currentModel?.emission || null,
                            origin: row.origin || null
                        };
                    });

                    const fallbackModels = Array.from(topModelSalesMap.values())
                        .filter(item => !catalogModels.some(model => model.name === item.name));
                    const models = [...catalogModels, ...fallbackModels]
                        .sort((a, b) => ((a.hp ?? 9999) - (b.hp ?? 9999)) || a.name.localeCompare(b.name));
                    const topModels = [...models]
                        .sort((a, b) => (b.currentSales - a.currentSales) || ((a.hp ?? 9999) - (b.hp ?? 9999)) || a.name.localeCompare(b.name))
                        .slice(0, 10);

                    const featureCombos = {};
                    let featureTotal = 0;
                    featureComboRes.rows.forEach(row => {
                        const key = `${String(row.drive_type || '-').toUpperCase()}_${String(row.cabin_type || '-').toLowerCase()}_${String(row.category || '-').toLowerCase()}`;
                        const total = parseInt(row.total_sales, 10) || 0;
                        featureCombos[key] = total;
                        featureTotal += total;
                    });

                    const top5ProvinceVolume = provinces.slice(0, 5).reduce((sum, item) => sum + item.qty, 0);

                    return {
                        periodLabel: formatPeriodLabel(compareMaxYear, compareMaxMonth, compareMaxYear, compareMaxMonth),
                        currPartial: currentSales,
                        prevPartial: prevSales,
                        currentSales,
                        prevSales,
                        yoyGrowth,
                        yoyPartial: yoyGrowth,
                        yearly,
                        monthly,
                        marketShare,
                        currentShare,
                        previousShare,
                        shareDeltaPp,
                        totalSales: currentSales,
                        hpDist,
                        hpSegments: hpDist,
                        categories,
                        driveTypes,
                        cabinTypes,
                        gearTypes,
                        topProvinces: provinces.slice(0, 10),
                        provinces,
                        topRegions: regions.slice(0, 8),
                        regions,
                        models,
                        topModels,
                        avgPrice,
                        minPrice,
                        maxPrice,
                        avgHp: portfolioAvgHp,
                        salesWeightedHp,
                        costPerHp,
                        modelCount,
                        variantCount,
                        activeProvinces: provinces.length,
                        top5ProvinceShare: currentSales > 0 ? roundMetric((top5ProvinceVolume * 100) / currentSales, 1) : 0,
                        featureCombos: {
                            total: featureTotal,
                            combos: featureCombos
                        }
                    };
                }

                const [compareFirstData, compareSecondData] = await Promise.all([
                    buildDeepCompareBrandData(compareFirstBrand),
                    buildDeepCompareBrandData(compareSecondBrand)
                ]);

                const compareDominanceRes = await pool.query(`
                    SELECT
                        p.id,
                        p.name,
                        p.plate_code,
                        p.latitude,
                        p.longitude,
                        p.region,
                        SUM(CASE WHEN UPPER(tv.marka) = ANY($1::text[]) THEN tv.satis_adet ELSE 0 END)::int AS s1,
                        SUM(CASE WHEN UPPER(tv.marka) = ANY($2::text[]) THEN tv.satis_adet ELSE 0 END)::int AS s2
                    FROM tuik_veri tv
                    JOIN provinces p
                        ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    WHERE tv.tescil_yil = $3
                      AND tv.tescil_ay <= $4
                      AND (UPPER(tv.marka) = ANY($1::text[]) OR UPPER(tv.marka) = ANY($2::text[]))
                    GROUP BY p.id, p.name, p.plate_code, p.latitude, p.longitude, p.region
                    ORDER BY p.name ASC
                `, [getBrandSqlAliases(compareFirstBrand), getBrandSqlAliases(compareSecondBrand), compareMaxYear, compareMaxMonth]);

                const dominanceMap = compareDominanceRes.rows
                    .map(row => {
                        const s1 = parseInt(row.s1, 10) || 0;
                        const s2 = parseInt(row.s2, 10) || 0;
                        const total = s1 + s2;
                        const diffPct = total > 0 ? ((s1 - s2) * 100) / total : 0;
                        let dominance = 'neutral';
                        if (diffPct >= 12) dominance = 'brand1';
                        else if (diffPct <= -12) dominance = 'brand2';
                        return {
                            id: parseInt(row.id, 10),
                            name: row.name,
                            plate_code: row.plate_code,
                            lat: row.latitude ? parseFloat(row.latitude) : null,
                            lng: row.longitude ? parseFloat(row.longitude) : null,
                            region: row.region,
                            s1,
                            s2,
                            total,
                            gap: Math.abs(s1 - s2),
                            dominance
                        };
                    })
                    .filter(item => item.total > 0);

                const provinceBattles = [...dominanceMap]
                    .sort((a, b) => b.total - a.total || b.gap - a.gap || a.name.localeCompare(b.name))
                    .slice(0, 20)
                    .map(item => ({
                        name: item.name,
                        region: item.region,
                        s1: item.s1,
                        s2: item.s2,
                        total: item.total,
                        gap: item.gap,
                        leader: item.s1 === item.s2 ? 'tie' : (item.s1 > item.s2 ? 'brand1' : 'brand2')
                    }));

                const provinceWins = {
                    brand1: dominanceMap.filter(item => item.s1 > item.s2).length,
                    brand2: dominanceMap.filter(item => item.s2 > item.s1).length,
                    tie: dominanceMap.filter(item => item.s1 === item.s2).length
                };

                const whitespaceSegments = compareHpOrder
                    .map(hp => {
                        const marketSales = compareMarketHp[hp] || 0;
                        const firstSegment = compareFirstData.hpDist.find(item => item.hp === hp) || { qty: 0, marketSharePct: 0 };
                        const secondSegment = compareSecondData.hpDist.find(item => item.hp === hp) || { qty: 0, marketSharePct: 0 };
                        const leaderKey = firstSegment.marketSharePct >= secondSegment.marketSharePct ? 'brand1' : 'brand2';
                        const leaderShare = Math.max(firstSegment.marketSharePct || 0, secondSegment.marketSharePct || 0);
                        const challengerKey = leaderKey === 'brand1' ? 'brand2' : 'brand1';
                        return {
                            hp,
                            marketSales,
                            brand1Sales: firstSegment.qty || 0,
                            brand2Sales: secondSegment.qty || 0,
                            brand1SharePct: firstSegment.marketSharePct || 0,
                            brand2SharePct: secondSegment.marketSharePct || 0,
                            leader: leaderKey,
                            challenger: challengerKey,
                            shareGapPp: roundMetric(Math.abs((firstSegment.marketSharePct || 0) - (secondSegment.marketSharePct || 0)), 1),
                            openVolume: Math.max(marketSales - Math.max(firstSegment.qty || 0, secondSegment.qty || 0), 0),
                            opportunityIndex: roundMetric((marketSales * (100 - leaderShare)) / 100, 1)
                        };
                    })
                    .filter(item => item.marketSales > 0)
                    .sort((a, b) => b.opportunityIndex - a.opportunityIndex || b.marketSales - a.marketSales);

                const featureLabels = {
                    '4WD_kabinli_tarla': '4WD + Kabin + Tarla',
                    '4WD_kabinli_bahce': '4WD + Kabin + Bahce',
                    '4WD_rollbar_tarla': '4WD + Rollbar + Tarla',
                    '4WD_rollbar_bahce': '4WD + Rollbar + Bahce',
                    '2WD_kabinli_tarla': '2WD + Kabin + Tarla',
                    '2WD_kabinli_bahce': '2WD + Kabin + Bahce',
                    '2WD_rollbar_tarla': '2WD + Rollbar + Tarla',
                    '2WD_rollbar_bahce': '2WD + Rollbar + Bahce'
                };
                const featureOverlap = Object.entries(featureLabels)
                    .map(([key, label]) => {
                        const b1 = compareFirstData.featureCombos.combos[key] || 0;
                        const b2 = compareSecondData.featureCombos.combos[key] || 0;
                        return {
                            key,
                            label,
                            b1,
                            b2,
                            p1: compareFirstData.featureCombos.total > 0 ? roundMetric((b1 * 100) / compareFirstData.featureCombos.total, 1) : 0,
                            p2: compareSecondData.featureCombos.total > 0 ? roundMetric((b2 * 100) / compareSecondData.featureCombos.total, 1) : 0
                        };
                    })
                    .filter(item => item.b1 > 0 || item.b2 > 0);

                const scorecard = [
                    { id: 'sales', label: `${compareMaxYear} ilk ${compareMaxMonth} ay satış`, v1: compareFirstData.currentSales, v2: compareSecondData.currentSales, better_when: 'higher' },
                    { id: 'share', label: 'Pazar payı', v1: compareFirstData.currentShare, v2: compareSecondData.currentShare, better_when: 'higher' },
                    { id: 'yoy', label: 'Yıllık momentum', v1: compareFirstData.yoyGrowth, v2: compareSecondData.yoyGrowth, better_when: 'higher' },
                    { id: 'reach', label: 'Aktif il', v1: compareFirstData.activeProvinces, v2: compareSecondData.activeProvinces, better_when: 'higher' },
                    { id: 'avg_hp', label: 'Satış ağırlıklı HP', v1: compareFirstData.salesWeightedHp, v2: compareSecondData.salesWeightedHp, better_when: 'higher' },
                    { id: 'cost_hp', label: 'Fiyat / HP', v1: compareFirstData.costPerHp, v2: compareSecondData.costPerHp, better_when: 'lower' },
                    { id: 'portfolio', label: 'Model genişliği', v1: compareFirstData.modelCount, v2: compareSecondData.modelCount, better_when: 'higher' },
                    { id: 'concentration', label: 'Top 5 il konsantrasyonu', v1: compareFirstData.top5ProvinceShare, v2: compareSecondData.top5ProvinceShare, better_when: 'lower' }
                ].map(item => {
                    let winner = 'tie';
                    if (item.v1 !== item.v2) {
                        winner = item.better_when === 'lower'
                            ? (item.v1 < item.v2 ? 'brand1' : 'brand2')
                            : (item.v1 > item.v2 ? 'brand1' : 'brand2');
                    }
                    return { ...item, winner };
                });

                const winnerScore = {
                    brand1: scorecard.filter(item => item.winner === 'brand1').length,
                    brand2: scorecard.filter(item => item.winner === 'brand2').length,
                    tie: scorecard.filter(item => item.winner === 'tie').length
                };

                return res.json({
                    period_label: formatPeriodLabel(compareMaxYear, compareMaxMonth, compareMaxYear, compareMaxMonth),
                    source_stack: ['sales_view', 'tuik_veri', 'teknik_veri'],
                    years: compareYears,
                    max_year: compareMaxYear,
                    max_month: compareMaxMonth,
                    prev_year: comparePrevYear,
                    hp_order: compareHpOrder,
                    market: {
                        current_total: compareMarketCurrent,
                        previous_total: compareMarketPrevious,
                        yoy_pct: calculateYoY(compareMarketCurrent, compareMarketPrevious),
                        yearly: compareMarketYearly
                    },
                    total_market: compareMarketYearly,
                    brand1: { ...compareFirstBrand, data: compareFirstData },
                    brand2: { ...compareSecondBrand, data: compareSecondData },
                    dominanceMap,
                    provinceBattles,
                    provinceWins,
                    mktHp: compareMarketHp,
                    whitespaceSegments,
                    featureOverlap,
                    scorecard,
                    winnerScore
                });
            }

            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            const mmRes = await pool.query('SELECT MAX(month) as mm FROM sales_view WHERE year=$1', [maxYear]);
            const maxMonth = parseInt(mmRes.rows[0].mm);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = [];
            for (let y = minYear; y <= maxYear; y++) years.push(y);

            const hpMidpoints = { '1-39': 25, '40-49': 45, '50-54': 52, '55-59': 57, '60-69': 65, '70-79': 75, '80-89': 85, '90-99': 95, '100-109': 105, '110-119': 115, '120+': 130 };
            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            // Brand info
            const b1 = (await pool.query('SELECT id,name,primary_color,country_of_origin,parent_company FROM brands WHERE id=$1', [brand1_id])).rows[0];
            const b2 = (await pool.query('SELECT id,name,primary_color,country_of_origin,parent_company FROM brands WHERE id=$1', [brand2_id])).rows[0];
            if (!b1 || !b2) return res.status(404).json({ error: 'Marka bulunamadı' });

            // Models with prices
            const m1 = (await pool.query('SELECT * FROM tractor_models WHERE brand_id=$1 AND is_current_model=true ORDER BY horsepower', [brand1_id])).rows;
            const m2 = (await pool.query('SELECT * FROM tractor_models WHERE brand_id=$1 AND is_current_model=true ORDER BY horsepower', [brand2_id])).rows;

            async function buildBrandBenchmark(brandId, models) {
                // Sales by hp_range, category, year, month, province
                const salesByDetail = await pool.query(`
                    SELECT s.year, s.month, s.hp_range, s.category, s.drive_type, s.cabin_type, s.gear_config,
                           s.province_id, p.name as province_name, p.region,
                           SUM(s.quantity) as total
                    FROM sales_view s JOIN provinces p ON s.province_id = p.id
                    WHERE s.brand_id = $1
                    GROUP BY s.year, s.month, s.hp_range, s.category, s.drive_type, s.cabin_type, s.gear_config, s.province_id, p.name, p.region
                `, [brandId]);

                // Aggregate
                const yearly = {}, monthly = {};
                const hpDist = {}, catDist = { bahce: 0, tarla: 0 }, driveDist = { '2WD': 0, '4WD': 0 };
                const cabinDist = { kabinli: 0, rollbar: 0 }, gearDist = {};
                const provSales = {}, provYearly = {};
                let totalQty = 0, hpWeightedSum = 0;

                years.forEach(y => { yearly[y] = 0; });
                for (let m = 1; m <= 12; m++) monthly[m] = 0;

                salesByDetail.rows.forEach(r => {
                    const qty = parseInt(r.total);
                    yearly[r.year] = (yearly[r.year] || 0) + qty;
                    if (r.year == maxYear) monthly[r.month] = (monthly[r.month] || 0) + qty;

                    totalQty += qty;
                    hpWeightedSum += (hpMidpoints[r.hp_range] || 60) * qty;
                    hpDist[r.hp_range] = (hpDist[r.hp_range] || 0) + qty;
                    catDist[r.category] = (catDist[r.category] || 0) + qty;
                    driveDist[r.drive_type] = (driveDist[r.drive_type] || 0) + qty;
                    cabinDist[r.cabin_type] = (cabinDist[r.cabin_type] || 0) + qty;
                    gearDist[r.gear_config] = (gearDist[r.gear_config] || 0) + qty;

                    if (!provSales[r.province_id]) provSales[r.province_id] = { name: r.province_name, region: r.region, total: 0 };
                    provSales[r.province_id].total += qty;
                    const pyk = `${r.province_id}_${r.year}`;
                    provYearly[pyk] = (provYearly[pyk] || 0) + qty;
                });

                const avgHp = totalQty > 0 ? Math.round(hpWeightedSum / totalQty) : 0;

                // Price stats from models
                const priceModels = models.filter(m => m.price_usd > 0);
                const avgPrice = priceModels.length > 0 ? priceModels.reduce((s, m) => s + parseFloat(m.price_usd), 0) / priceModels.length : 0;
                const avgHpModel = priceModels.length > 0 ? priceModels.reduce((s, m) => s + parseFloat(m.horsepower), 0) / priceModels.length : 0;
                const costPerHp = avgHpModel > 0 ? avgPrice / avgHpModel : 0;

                // HP segment detail (qty + pct)
                const hpSegments = hpOrder.map(hp => ({
                    hp, qty: hpDist[hp] || 0, pct: totalQty > 0 ? ((hpDist[hp] || 0) / totalQty * 100) : 0
                }));

                // Province top with yearly trend
                const provArr = Object.entries(provSales)
                    .map(([pid, d]) => ({
                        ...d, id: pid,
                        yearly: years.reduce((o, y) => { o[y] = provYearly[`${pid}_${y}`] || 0; return o; }, {})
                    }))
                    .sort((a, b) => b.total - a.total);

                // YoY for each year
                const yoyByYear = {};
                years.forEach((y, i) => {
                    if (i === 0) { yoyByYear[y] = 0; return; }
                    const prev = yearly[years[i - 1]] || 0;
                    yoyByYear[y] = prev > 0 ? ((yearly[y] - prev) / prev * 100) : 0;
                });

                // Partial year comparison
                let currPartial = 0, prevPartial = 0;
                salesByDetail.rows.forEach(r => {
                    const qty = parseInt(r.total);
                    if (r.year == maxYear && r.month <= maxMonth) currPartial += qty;
                    if (r.year == prevYear && r.month <= maxMonth) prevPartial += qty;
                });
                const yoyPartial = prevPartial > 0 ? ((currPartial - prevPartial) / prevPartial * 100) : 0;

                return {
                    totalQty, avgHp, avgPrice, costPerHp,
                    yearly, monthly, yoyByYear, currPartial, prevPartial, yoyPartial,
                    hpSegments, catDist, driveDist, cabinDist, gearDist,
                    provinces: provArr.slice(0, 20),
                    models: models.map(m => ({
                        name: m.model_name, hp: parseFloat(m.horsepower), price: m.price_usd ? parseFloat(m.price_usd) : 0,
                        category: m.category, cabin: m.cabin_type, drive: m.drive_type, gear: m.gear_config, hp_range: m.hp_range
                    }))
                };
            }

            // Total market by year and by province
            const mktYearRes = await pool.query('SELECT year, SUM(quantity) as total FROM sales_view GROUP BY year');
            const mktYearly = {};
            mktYearRes.rows.forEach(r => { mktYearly[r.year] = parseInt(r.total); });

            const mktProvRes = await pool.query(`
                SELECT s.province_id, p.name, SUM(s.quantity) as total
                FROM sales_view s JOIN provinces p ON s.province_id = p.id
                WHERE s.year = $1
                GROUP BY s.province_id, p.name ORDER BY total DESC
            `, [maxYear]);

            // Brand sales by province for dominance map
            const b1ProvRes = await pool.query('SELECT province_id, SUM(quantity) as total FROM sales_view WHERE brand_id=$1 AND year=$2 GROUP BY province_id', [brand1_id, maxYear]);
            const b2ProvRes = await pool.query('SELECT province_id, SUM(quantity) as total FROM sales_view WHERE brand_id=$1 AND year=$2 GROUP BY province_id', [brand2_id, maxYear]);
            const b1ProvMap = {}, b2ProvMap = {};
            b1ProvRes.rows.forEach(r => { b1ProvMap[r.province_id] = parseInt(r.total); });
            b2ProvRes.rows.forEach(r => { b2ProvMap[r.province_id] = parseInt(r.total); });

            // Provinces with lat/lng for map
            const provGeoRes = await pool.query('SELECT id, name, plate_code, latitude, longitude, region FROM provinces');
            const dominanceMap = provGeoRes.rows.map(p => {
                const s1 = b1ProvMap[p.id] || 0;
                const s2 = b2ProvMap[p.id] || 0;
                const total = s1 + s2;
                let dominance = 'neutral'; // neutral/brand1/brand2
                if (total > 0) {
                    const diff = (s1 - s2) / total * 100;
                    if (diff > 20) dominance = 'brand1';
                    else if (diff < -20) dominance = 'brand2';
                }
                return { id: p.id, name: p.name, plate_code: p.plate_code, lat: parseFloat(p.latitude), lng: parseFloat(p.longitude), region: p.region, s1, s2, dominance };
            }).filter(p => (p.s1 + p.s2) > 0);

            // HP segment market totals for segment share comparison
            const mktHpRes = await pool.query('SELECT hp_range, SUM(quantity) as total FROM sales_view WHERE year=$1 GROUP BY hp_range', [maxYear]);
            const mktHp = {};
            mktHpRes.rows.forEach(r => { mktHp[r.hp_range] = parseInt(r.total); });

            const [data1, data2] = await Promise.all([
                buildBrandBenchmark(brand1_id, m1),
                buildBrandBenchmark(brand2_id, m2)
            ]);

            // Market share by year
            const mktShare1 = {}, mktShare2 = {};
            years.forEach(y => {
                mktShare1[y] = mktYearly[y] > 0 ? (data1.yearly[y] / mktYearly[y] * 100) : 0;
                mktShare2[y] = mktYearly[y] > 0 ? (data2.yearly[y] / mktYearly[y] * 100) : 0;
            });

            // Segment market share (brand qty in segment / total market qty in segment)
            const segShare1 = {}, segShare2 = {};
            hpOrder.forEach(hp => {
                const mkt = mktHp[hp] || 0;
                const s1hp = data1.hpSegments.find(s => s.hp === hp)?.qty || 0;
                const s2hp = data2.hpSegments.find(s => s.hp === hp)?.qty || 0;
                segShare1[hp] = mkt > 0 ? (s1hp / mkt * 100) : 0;
                segShare2[hp] = mkt > 0 ? (s2hp / mkt * 100) : 0;
            });

            // Feature intersection (Venn-like data)
            async function getFeatureIntersection(brandId) {
                const r = await pool.query(`
                    SELECT drive_type, cabin_type, category,
                           SUM(quantity) as total
                    FROM sales_view WHERE brand_id=$1 AND year=$2
                    GROUP BY drive_type, cabin_type, category
                `, [brandId, maxYear]);
                const combos = {};
                let total = 0;
                r.rows.forEach(row => {
                    const key = `${row.drive_type}_${row.cabin_type}_${row.category}`;
                    combos[key] = parseInt(row.total);
                    total += parseInt(row.total);
                });
                return { combos, total };
            }
            const [feat1, feat2] = await Promise.all([
                getFeatureIntersection(brand1_id),
                getFeatureIntersection(brand2_id)
            ]);

            res.json({
                brand1: { ...b1, data: data1, mktShare: mktShare1, segShare: segShare1, features: feat1 },
                brand2: { ...b2, data: data2, mktShare: mktShare2, segShare: segShare2, features: feat2 },
                years, max_year: maxYear, max_month: maxMonth, prev_year: prevYear,
                mktYearly, dominanceMap, mktHp
            });

        } catch (err) {
            console.error('Benchmark error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // DYNAMIC BRAND COMPARISON
    // ============================================
    app.get('/api/sales/brand-compare', authMiddleware, requireFeature('competitor_analysis', 'brand_compare'), async (req, res) => {
        try {
            const { brand1_id, brand2_id } = req.query;
            if (!brand1_id || !brand2_id) return res.status(400).json({ error: 'brand1_id ve brand2_id gerekli' });

            const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year);
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [maxYear]);
            const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
            const prevYear = maxYear - 1;
            const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_view');
            const minYear = parseInt(minYearRes.rows[0].min_year);
            const years = [];
            for (let y = minYear; y <= maxYear; y++) years.push(y);

            // Get brand info
            const brand1Res = await pool.query('SELECT id, name, primary_color, secondary_color FROM brands WHERE id = $1', [brand1_id]);
            const brand2Res = await pool.query('SELECT id, name, primary_color, secondary_color FROM brands WHERE id = $1', [brand2_id]);
            if (!brand1Res.rows[0] || !brand2Res.rows[0]) return res.status(404).json({ error: 'Marka bulunamadı' });

            const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

            // Total market by year+month
            const marketRows = await pool.query(`SELECT year, month, SUM(quantity) as total FROM sales_view GROUP BY year, month`);
            const marketMap = {};
            marketRows.rows.forEach(r => { marketMap[`${r.year}_${r.month}`] = parseInt(r.total); });

            async function buildBrandData(brandId) {
                // Yearly+monthly sales
                const salesRows = await pool.query(`SELECT year, month, SUM(quantity) as total FROM sales_view WHERE brand_id = $1 GROUP BY year, month ORDER BY year, month`, [brandId]);
                const salesMap = {};
                salesRows.rows.forEach(r => { salesMap[`${r.year}_${r.month}`] = parseInt(r.total); });

                const yearly = {};
                years.forEach(y => {
                    let total = 0;
                    const limit = y === maxYear ? maxMonth : 12;
                    for (let m = 1; m <= limit; m++) total += (salesMap[`${y}_${m}`] || 0);
                    yearly[y] = total;
                });

                const monthly = {};
                for (let m = 1; m <= maxMonth; m++) monthly[m] = salesMap[`${maxYear}_${m}`] || 0;

                // Current partial vs prev partial (same month range)
                let currPartial = 0, prevPartial = 0;
                for (let m = 1; m <= maxMonth; m++) {
                    currPartial += (salesMap[`${maxYear}_${m}`] || 0);
                    prevPartial += (salesMap[`${prevYear}_${m}`] || 0);
                }
                const yoyGrowth = prevPartial > 0 ? ((currPartial - prevPartial) / prevPartial * 100) : 0;

                // Market share by year
                const marketShare = {};
                years.forEach(y => {
                    let mktTotal = 0;
                    const limit = y === maxYear ? maxMonth : 12;
                    for (let m = 1; m <= limit; m++) mktTotal += (marketMap[`${y}_${m}`] || 0);
                    marketShare[y] = mktTotal > 0 ? (yearly[y] / mktTotal * 100) : 0;
                });

                // HP distribution (current year partial)
                const hpRows = await pool.query(`SELECT hp_range, SUM(quantity) as total FROM sales_view WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY hp_range ORDER BY total DESC`, [brandId, maxYear, maxMonth]);
                const hpDist = hpRows.rows.map(r => ({ hp: r.hp_range, qty: parseInt(r.total) }));
                const hpTotal = hpDist.reduce((s, h) => s + h.qty, 0);
                hpDist.forEach(h => h.pct = hpTotal > 0 ? (h.qty / hpTotal * 100) : 0);

                // Category split
                const catRows = await pool.query(`SELECT category, SUM(quantity) as total FROM sales_view WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY category`, [brandId, maxYear, maxMonth]);
                const categories = {};
                catRows.rows.forEach(r => { categories[r.category] = parseInt(r.total); });

                // Top 5 provinces
                const provRows = await pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_view s JOIN provinces p ON s.province_id = p.id WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3 GROUP BY p.name ORDER BY total DESC LIMIT 5`, [brandId, maxYear, maxMonth]);
                const topProvinces = provRows.rows.map(r => ({ name: r.name, qty: parseInt(r.total) }));

                // Drive type split
                const driveRows = await pool.query(`SELECT drive_type, SUM(quantity) as total FROM sales_view WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY drive_type`, [brandId, maxYear, maxMonth]);
                const driveTypes = {};
                driveRows.rows.forEach(r => { driveTypes[r.drive_type] = parseInt(r.total); });

                // Models with prices from tractor_models
                const modelRows = await pool.query(`SELECT model_name, horsepower, price_usd, category, cabin_type, drive_type FROM tractor_models WHERE brand_id = $1 AND is_current_model = true ORDER BY horsepower`, [brandId]);
                const models = modelRows.rows.map(r => ({
                    name: r.model_name,
                    hp: parseFloat(r.horsepower),
                    price: r.price_usd ? parseFloat(r.price_usd) : null,
                    category: r.category,
                    cabin: r.cabin_type,
                    drive: r.drive_type
                }));

                // Avg price
                const priceModels = models.filter(m => m.price && m.price > 0);
                const avgPrice = priceModels.length > 0 ? priceModels.reduce((s, m) => s + m.price, 0) / priceModels.length : 0;
                const minPrice = priceModels.length > 0 ? Math.min(...priceModels.map(m => m.price)) : 0;
                const maxPrice = priceModels.length > 0 ? Math.max(...priceModels.map(m => m.price)) : 0;

                return {
                    yearly, monthly, currPartial, prevPartial, yoyGrowth,
                    marketShare, hpDist, categories, topProvinces, driveTypes,
                    models, avgPrice, minPrice, maxPrice,
                    totalSales: currPartial
                };
            }

            const [data1, data2] = await Promise.all([buildBrandData(brand1_id), buildBrandData(brand2_id)]);

            // Total market summary
            const totalMarketYearly = {};
            years.forEach(y => {
                let total = 0;
                const limit = y === maxYear ? maxMonth : 12;
                for (let m = 1; m <= limit; m++) total += (marketMap[`${y}_${m}`] || 0);
                totalMarketYearly[y] = total;
            });

            res.json({
                brand1: { ...brand1Res.rows[0], data: data1 },
                brand2: { ...brand2Res.rows[0], data: data2 },
                years, max_year: maxYear, max_month: maxMonth, prev_year: prevYear,
                total_market: totalMarketYearly
            });
        } catch (err) {
            console.error('Brand compare error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

};
