'use strict';
// Seed/admin ve TARMAKBİR route'ları, server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerSeedAdmin(app, ctx) {
    const { pool, authMiddleware, adminOnly, errMsg } = ctx;

    // ============================================
    // SEED MODEL IMAGE GALLERY (admin)
    // ============================================
    app.post('/api/admin/seed-model-images', authMiddleware, async (req, res) => {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Sadece admin bu işlemi yapabilir' });
        }
        try {
            const { seedModelImages } = require('./scripts/seed-model-images');
            const result = await seedModelImages();
            res.json({
                success: true,
                message: `Model görseli seed tamamlandı: ${result.inserted} eklendi, ${result.updated} güncellendi, ${result.errors} hata`,
                ...result
            });
        } catch (err) {
            console.error('Seed model images error:', err);
            res.status(500).json({ error: 'Model görseli seed başarısız: ' + errMsg(err) });
        }
    });

    // ============================================
    // SEED TRACTOR MODELS (admin)
    // ============================================
    app.post('/api/admin/seed-models', authMiddleware, adminOnly, async (req, res) => {
        try {
            const modelCount = await pool.query('SELECT COUNT(*) FROM tractor_models');
            if (parseInt(modelCount.rows[0].count) > 0) {
                return res.json({ message: `Model verisi zaten mevcut: ${modelCount.rows[0].count} kayıt` });
            }

            const brandRows = await pool.query('SELECT id, slug FROM brands ORDER BY id');
            const brandMap = {};
            brandRows.rows.forEach(b => { brandMap[b.slug] = b.id; });

            const modelDefs = {
                'new-holland': [
                    { name: 'BOOMER 25', hp: 25, cat: 'bahce', price: 850000 },
                    { name: 'TT35', hp: 35, cat: 'bahce', price: 1050000 },
                    { name: 'TT4.55', hp: 45, cat: 'tarla', price: 1350000 },
                    { name: 'TT4.65', hp: 48, cat: 'tarla', price: 1480000 },
                    { name: 'TD5.65', hp: 52, cat: 'tarla', price: 1650000 },
                    { name: 'TD5.75', hp: 57, cat: 'tarla', price: 1850000 },
                    { name: 'TD5.90', hp: 65, cat: 'tarla', price: 2150000 },
                    { name: 'T4.75', hp: 75, cat: 'tarla', price: 2550000 },
                    { name: 'T5.90', hp: 85, cat: 'tarla', price: 2950000 },
                    { name: 'T5.110', hp: 95, cat: 'tarla', price: 3450000 },
                    { name: 'T6.125', hp: 105, cat: 'tarla', price: 4200000 },
                    { name: 'T6.155', hp: 115, cat: 'tarla', price: 4850000 },
                    { name: 'T7.210', hp: 125, cat: 'tarla', price: 5800000 },
                    { name: 'T7.315', hp: 145, cat: 'tarla', price: 7500000 }
                ],
                'case-ih': [
                    { name: 'FARMALL 45A', hp: 45, cat: 'tarla', price: 1300000 },
                    { name: 'FARMALL 55A', hp: 53, cat: 'tarla', price: 1600000 },
                    { name: 'FARMALL 65A', hp: 58, cat: 'tarla', price: 1900000 },
                    { name: 'FARMALL 75C', hp: 68, cat: 'tarla', price: 2200000 },
                    { name: 'FARMALL 90C', hp: 78, cat: 'tarla', price: 2650000 },
                    { name: 'FARMALL 110A', hp: 88, cat: 'tarla', price: 3100000 },
                    { name: 'LUXXUM 100', hp: 95, cat: 'tarla', price: 3600000 },
                    { name: 'LUXXUM 120', hp: 108, cat: 'tarla', price: 4350000 },
                    { name: 'MAXXUM 135', hp: 118, cat: 'tarla', price: 5100000 },
                    { name: 'PUMA 150', hp: 130, cat: 'tarla', price: 6200000 },
                    { name: 'PUMA 185', hp: 150, cat: 'tarla', price: 7800000 }
                ],
                'massey-ferguson': [
                    { name: 'MF 2605', hp: 42, cat: 'tarla', price: 1200000 },
                    { name: 'MF 2615', hp: 48, cat: 'tarla', price: 1400000 },
                    { name: 'MF 4707', hp: 52, cat: 'tarla', price: 1700000 },
                    { name: 'MF 4709', hp: 57, cat: 'tarla', price: 1950000 },
                    { name: 'MF 5710', hp: 65, cat: 'tarla', price: 2350000 },
                    { name: 'MF 5712', hp: 75, cat: 'tarla', price: 2750000 },
                    { name: 'MF 6712', hp: 85, cat: 'tarla', price: 3200000 },
                    { name: 'MF 6714', hp: 95, cat: 'tarla', price: 3700000 },
                    { name: 'MF 7715', hp: 105, cat: 'tarla', price: 4500000 },
                    { name: 'MF 7718', hp: 115, cat: 'tarla', price: 5200000 },
                    { name: 'MF 8727', hp: 130, cat: 'tarla', price: 6500000 }
                ],
                'john-deere': [
                    { name: '5045D', hp: 45, cat: 'tarla', price: 1450000 },
                    { name: '5055E', hp: 53, cat: 'tarla', price: 1750000 },
                    { name: '5065E', hp: 58, cat: 'tarla', price: 2050000 },
                    { name: '5075E', hp: 68, cat: 'tarla', price: 2450000 },
                    { name: '5085M', hp: 78, cat: 'tarla', price: 2900000 },
                    { name: '5100M', hp: 88, cat: 'tarla', price: 3400000 },
                    { name: '5115M', hp: 95, cat: 'tarla', price: 3900000 },
                    { name: '6105M', hp: 105, cat: 'tarla', price: 4800000 },
                    { name: '6120M', hp: 115, cat: 'tarla', price: 5500000 },
                    { name: '6155M', hp: 135, cat: 'tarla', price: 7200000 }
                ],
                'tumosan': [
                    { name: '4250', hp: 42, cat: 'tarla', price: 950000 },
                    { name: '5255', hp: 52, cat: 'tarla', price: 1200000 },
                    { name: '5265', hp: 57, cat: 'tarla', price: 1400000 },
                    { name: '6265', hp: 65, cat: 'tarla', price: 1700000 },
                    { name: '7270', hp: 75, cat: 'tarla', price: 2050000 },
                    { name: '8080', hp: 85, cat: 'tarla', price: 2400000 },
                    { name: '8595', hp: 95, cat: 'tarla', price: 2800000 },
                    { name: '10105', hp: 105, cat: 'tarla', price: 3300000 },
                    { name: '10120', hp: 115, cat: 'tarla', price: 3900000 }
                ],
                'hattat': [
                    { name: 'A45', hp: 45, cat: 'tarla', price: 900000 },
                    { name: 'B55', hp: 53, cat: 'tarla', price: 1150000 },
                    { name: 'B65', hp: 58, cat: 'tarla', price: 1350000 },
                    { name: 'C70', hp: 68, cat: 'tarla', price: 1650000 },
                    { name: 'C80', hp: 78, cat: 'tarla', price: 2000000 },
                    { name: 'D90', hp: 88, cat: 'tarla', price: 2350000 },
                    { name: 'T4100', hp: 98, cat: 'tarla', price: 2750000 },
                    { name: 'T4110', hp: 108, cat: 'tarla', price: 3200000 },
                    { name: 'T4120', hp: 118, cat: 'tarla', price: 3700000 }
                ],
                'erkunt': [
                    { name: 'KISMET 50', hp: 45, cat: 'tarla', price: 920000 },
                    { name: 'BEREKET 60', hp: 53, cat: 'tarla', price: 1180000 },
                    { name: 'NIMET 65', hp: 58, cat: 'tarla', price: 1380000 },
                    { name: 'NIMET 75', hp: 68, cat: 'tarla', price: 1680000 },
                    { name: 'ALP 80', hp: 78, cat: 'tarla', price: 2020000 },
                    { name: 'ALP 90', hp: 88, cat: 'tarla', price: 2380000 },
                    { name: 'KUDRET 100', hp: 98, cat: 'tarla', price: 2800000 },
                    { name: 'KUDRET 110', hp: 108, cat: 'tarla', price: 3250000 },
                    { name: 'SERVET 120', hp: 118, cat: 'tarla', price: 3750000 }
                ],
                'basak': [
                    { name: '2045', hp: 45, cat: 'tarla', price: 880000 },
                    { name: '2060', hp: 53, cat: 'tarla', price: 1100000 },
                    { name: '2070', hp: 58, cat: 'tarla', price: 1300000 },
                    { name: '2080', hp: 68, cat: 'tarla', price: 1600000 },
                    { name: '2085', hp: 78, cat: 'tarla', price: 1950000 },
                    { name: '2095', hp: 88, cat: 'tarla', price: 2300000 },
                    { name: '5095', hp: 98, cat: 'tarla', price: 2700000 },
                    { name: '5110', hp: 108, cat: 'tarla', price: 3150000 }
                ],
                'deutz-fahr': [
                    { name: '4050E', hp: 45, cat: 'tarla', price: 1350000 },
                    { name: '5065E', hp: 53, cat: 'tarla', price: 1650000 },
                    { name: '5070G', hp: 58, cat: 'tarla', price: 1950000 },
                    { name: '5080G', hp: 68, cat: 'tarla', price: 2300000 },
                    { name: '5100G', hp: 78, cat: 'tarla', price: 2700000 },
                    { name: '5110G', hp: 88, cat: 'tarla', price: 3150000 },
                    { name: '6120', hp: 98, cat: 'tarla', price: 3650000 },
                    { name: '6140', hp: 108, cat: 'tarla', price: 4200000 },
                    { name: '6160', hp: 118, cat: 'tarla', price: 4900000 },
                    { name: '7230 TTV', hp: 135, cat: 'tarla', price: 7000000 }
                ],
                'kubota': [
                    { name: 'B2420', hp: 24, cat: 'bahce', price: 650000 },
                    { name: 'B2650', hp: 26, cat: 'bahce', price: 750000 },
                    { name: 'L4240', hp: 42, cat: 'tarla', price: 1250000 },
                    { name: 'L5240', hp: 52, cat: 'tarla', price: 1600000 },
                    { name: 'M5660', hp: 56, cat: 'tarla', price: 1900000 },
                    { name: 'M6060', hp: 65, cat: 'tarla', price: 2250000 },
                    { name: 'M7060', hp: 75, cat: 'tarla', price: 2650000 },
                    { name: 'M8540', hp: 85, cat: 'tarla', price: 3100000 },
                    { name: 'M9540', hp: 95, cat: 'tarla', price: 3600000 },
                    { name: 'M7-132', hp: 105, cat: 'tarla', price: 4400000 },
                    { name: 'M7-152', hp: 115, cat: 'tarla', price: 5100000 },
                    { name: 'M7-172', hp: 130, cat: 'tarla', price: 6300000 }
                ],
                'landini': [
                    { name: '4-060', hp: 53, cat: 'tarla', price: 1550000 },
                    { name: '4-080', hp: 68, cat: 'tarla', price: 2100000 },
                    { name: '5-110', hp: 78, cat: 'tarla', price: 2550000 },
                    { name: '6-130', hp: 88, cat: 'tarla', price: 3050000 },
                    { name: '6-145', hp: 98, cat: 'tarla', price: 3550000 },
                    { name: '7-175', hp: 108, cat: 'tarla', price: 4300000 },
                    { name: '7-210', hp: 118, cat: 'tarla', price: 5000000 }
                ],
                'same': [
                    { name: 'EXPLORER 55', hp: 53, cat: 'tarla', price: 1500000 },
                    { name: 'EXPLORER 70', hp: 68, cat: 'tarla', price: 2050000 },
                    { name: 'EXPLORER 80', hp: 78, cat: 'tarla', price: 2500000 },
                    { name: 'VIRTUS 110', hp: 95, cat: 'tarla', price: 3400000 },
                    { name: 'IRON 120', hp: 108, cat: 'tarla', price: 4100000 },
                    { name: 'IRON 150', hp: 130, cat: 'tarla', price: 5800000 }
                ],
                'fendt': [
                    { name: '209 VARIO', hp: 75, cat: 'tarla', price: 3200000 },
                    { name: '211 VARIO', hp: 85, cat: 'tarla', price: 3800000 },
                    { name: '311 VARIO', hp: 95, cat: 'tarla', price: 4500000 },
                    { name: '313 VARIO', hp: 105, cat: 'tarla', price: 5300000 },
                    { name: '516 VARIO', hp: 118, cat: 'tarla', price: 6500000 },
                    { name: '720 VARIO', hp: 135, cat: 'tarla', price: 8500000 },
                    { name: '828 VARIO', hp: 160, cat: 'tarla', price: 11000000 }
                ],
                'claas': [
                    { name: 'ELIOS 230', hp: 68, cat: 'tarla', price: 2400000 },
                    { name: 'ARION 420', hp: 78, cat: 'tarla', price: 2900000 },
                    { name: 'ARION 440', hp: 88, cat: 'tarla', price: 3400000 },
                    { name: 'ARION 520', hp: 98, cat: 'tarla', price: 4000000 },
                    { name: 'ARION 540', hp: 108, cat: 'tarla', price: 4700000 },
                    { name: 'ARION 620', hp: 118, cat: 'tarla', price: 5600000 },
                    { name: 'AXION 850', hp: 150, cat: 'tarla', price: 9500000 }
                ],
                'valtra': [
                    { name: 'A84', hp: 68, cat: 'tarla', price: 2300000 },
                    { name: 'A104', hp: 78, cat: 'tarla', price: 2750000 },
                    { name: 'N114', hp: 88, cat: 'tarla', price: 3300000 },
                    { name: 'N154', hp: 98, cat: 'tarla', price: 3900000 },
                    { name: 'T154', hp: 108, cat: 'tarla', price: 4600000 },
                    { name: 'T194', hp: 118, cat: 'tarla', price: 5400000 },
                    { name: 'T234', hp: 140, cat: 'tarla', price: 7500000 }
                ],
                'solis': [
                    { name: 'SOLIS 20 DT', hp: 20, cat: 'bahce', price: 450000 },
                    { name: 'SOLIS 26 DT', hp: 26, cat: 'bahce', price: 550000 },
                    { name: 'SOLIS 50', hp: 45, cat: 'tarla', price: 850000 },
                    { name: 'SOLIS 60', hp: 55, cat: 'tarla', price: 1050000 },
                    { name: 'SOLIS 75', hp: 68, cat: 'tarla', price: 1350000 },
                    { name: 'SOLIS 90', hp: 78, cat: 'tarla', price: 1650000 }
                ],
                'antonio-carraro': [
                    { name: 'TIGRE 3200', hp: 25, cat: 'bahce', price: 750000 },
                    { name: 'TIGRE 4000', hp: 32, cat: 'bahce', price: 950000 },
                    { name: 'TIGRE 4400 F', hp: 38, cat: 'bahce', price: 1150000 },
                    { name: 'TGF 7800', hp: 48, cat: 'bahce', price: 1450000 },
                    { name: 'TRX 7800', hp: 55, cat: 'bahce', price: 1750000 },
                    { name: 'MACH 2', hp: 65, cat: 'bahce', price: 2100000 }
                ],
                'mccormick': [
                    { name: 'X2.55', hp: 53, cat: 'tarla', price: 1500000 },
                    { name: 'X4.70', hp: 68, cat: 'tarla', price: 2050000 },
                    { name: 'X5.85', hp: 78, cat: 'tarla', price: 2500000 },
                    { name: 'X6.55', hp: 88, cat: 'tarla', price: 3000000 },
                    { name: 'X7.480', hp: 98, cat: 'tarla', price: 3600000 },
                    { name: 'X7.650', hp: 108, cat: 'tarla', price: 4300000 },
                    { name: 'X7.670', hp: 118, cat: 'tarla', price: 5100000 }
                ],
                'fiat': [
                    { name: '55-46 DT', hp: 45, cat: 'tarla', price: 950000 },
                    { name: '60-56 DT', hp: 53, cat: 'tarla', price: 1200000 },
                    { name: '65-56 DT', hp: 58, cat: 'tarla', price: 1400000 },
                    { name: '70-66 DT', hp: 68, cat: 'tarla', price: 1700000 },
                    { name: '80-66 DT', hp: 78, cat: 'tarla', price: 2050000 }
                ],
                'yanmar': [
                    { name: 'YM2000', hp: 20, cat: 'bahce', price: 500000 },
                    { name: 'YM2210', hp: 28, cat: 'bahce', price: 620000 },
                    { name: 'EF453T', hp: 45, cat: 'tarla', price: 1100000 }
                ],
                'ferrari-tractors': [
                    { name: 'TC25F', hp: 25, cat: 'bahce', price: 650000 },
                    { name: 'TC30F', hp: 30, cat: 'bahce', price: 780000 },
                    { name: 'COBRAM 50', hp: 45, cat: 'bahce', price: 1100000 }
                ],
                'karatas': [
                    { name: 'KT 4048', hp: 45, cat: 'tarla', price: 800000 },
                    { name: 'KT 5055', hp: 53, cat: 'tarla', price: 1000000 },
                    { name: 'KT 6065', hp: 58, cat: 'tarla', price: 1200000 }
                ],
                'kioti': [
                    { name: 'CS2520', hp: 25, cat: 'bahce', price: 600000 },
                    { name: 'CK4510', hp: 45, cat: 'tarla', price: 1200000 },
                    { name: 'DK5510', hp: 53, cat: 'tarla', price: 1500000 },
                    { name: 'RX6620', hp: 58, cat: 'tarla', price: 1800000 },
                    { name: 'PX1053', hp: 68, cat: 'tarla', price: 2200000 }
                ],
                'tafe': [
                    { name: '5900 DI', hp: 45, cat: 'tarla', price: 800000 },
                    { name: '8502 DI', hp: 53, cat: 'tarla', price: 1000000 },
                    { name: '9502 DI', hp: 58, cat: 'tarla', price: 1200000 }
                ]
            };

            let insertCount = 0;
            for (const [slug, models] of Object.entries(modelDefs)) {
                const brandId = brandMap[slug];
                if (!brandId) continue;
                for (const m of models) {
                    const hpRange = m.hp < 40 ? '1-39' : m.hp < 50 ? '40-49' : m.hp < 55 ? '50-54' : m.hp < 60 ? '55-59' : m.hp < 70 ? '60-69' : m.hp < 80 ? '70-79' : m.hp < 90 ? '80-89' : m.hp < 100 ? '90-99' : m.hp < 110 ? '100-109' : m.hp < 120 ? '110-119' : '120+';
                    const cabin = m.hp >= 60 ? 'kabinli' : 'rollbar';
                    const drive = m.hp >= 50 ? '4WD' : (Math.random() > 0.5 ? '4WD' : '2WD');
                    const gear = m.hp >= 100 ? '16+16' : m.hp >= 70 ? '12+12' : '8+8';
                    await pool.query(
                        `INSERT INTO tractor_models (brand_id, model_name, category, cabin_type, drive_type, horsepower, hp_range, price_list_tl, gear_config, is_current_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT DO NOTHING`,
                        [brandId, m.name, m.cat, cabin, drive, m.hp, hpRange, m.price, gear]
                    );
                    insertCount++;
                }
            }

            res.json({ message: `${insertCount} model eklendi`, count: insertCount });
        } catch (err) {
            console.error('Seed models error:', err);
            res.status(500).json({ error: errMsg(err) });
        }
    });

    // ============================================
    // TARMAKBIR - Model Yılı Bazlı Aylık Satış
    // ============================================
    app.get('/api/sales/tarmakbir', authMiddleware, async (req, res) => {
        try {
            // Determine which year the user wants to view
            const latestRes = await pool.query('SELECT MAX(year) as max_year, MIN(year) as min_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0].max_year) || 2025;
            const minYear = parseInt(latestRes.rows[0].min_year) || 2019;

            // Selected year (the "data year" the user is viewing)
            const requestedYear = req.query.year ? parseInt(req.query.year) : maxYear;
            const selectedYear = !isNaN(requestedYear) ? Math.min(Math.max(requestedYear, minYear), maxYear) : maxYear;

            console.log(`TarmakBir Request: req=${req.query.year}, selected=${selectedYear}, range=${minYear}-${maxYear}`);

            // Get ALL unique registration years from the database for the rows
            const yearsRes = await pool.query('SELECT DISTINCT year FROM sales_view ORDER BY year DESC');
            const compareYears = yearsRes.rows.map(r => parseInt(r.year));

            // Get monthly sales for ALL registration years (Strictly filtering for only the last 2 model years per registration year)
            const salesRes = await pool.query(`
                SELECT year, month, SUM(quantity) as total
                FROM sales_view
                WHERE (year = model_year OR year = model_year + 1)
                  AND year = ANY($1)
                GROUP BY year, month
                ORDER BY year DESC, month
            `, [compareYears]);

            // Get Model Year breakdown for the SELECTED year (showing only latest 2 model years)
            const modelYearRes = await pool.query(`
                SELECT model_year, month, SUM(quantity) as total
                FROM sales_view
                WHERE year = $1 AND model_year IN ($1, $1 - 1)
                GROUP BY model_year, month
                ORDER BY model_year DESC, month
            `, [selectedYear]);

            // Organize main data: { year: { month: total, ... }, ... }
            const monthsData = {};
            compareYears.forEach(y => { monthsData[y] = {}; });
            salesRes.rows.forEach(r => {
                monthsData[parseInt(r.year)][parseInt(r.month)] = parseInt(r.total);
            });

            // Organize model year breakdown for selected year
            const modelBreakdown = {};
            modelYearRes.rows.forEach(r => {
                const my = r.model_year || 'Bilinmiyor';
                if (!modelBreakdown[my]) modelBreakdown[my] = {};
                modelBreakdown[my][parseInt(r.month)] = parseInt(r.total);
            });

            res.json({
                selected_year: selectedYear,
                registration_years: compareYears,
                months_data: monthsData,
                model_breakdown: modelBreakdown,
                max_month: 12,
                min_year: minYear,
                max_year: maxYear,
                available_years: compareYears // Use same list for dropdown
            });
        } catch (err) {
            console.error('TarmakBir error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.get('/api/sales/tarmakbir-total', authMiddleware, async (req, res) => {
        try {
            const latestRes = await pool.query('SELECT MAX(year) as max_year, MIN(year) as min_year FROM sales_data');
            const maxYear = parseInt(latestRes.rows[0].max_year) || 2025;
            const minYear = parseInt(latestRes.rows[0].min_year) || 2019;
            const requestedYear = req.query.year ? parseInt(req.query.year, 10) : maxYear;
            const selectedYear = !isNaN(requestedYear) ? Math.min(Math.max(requestedYear, minYear), maxYear) : maxYear;

            // Get sales by brand and month from raw sales_data to preserve the all-model-years view
            const salesRes = await pool.query(`
                SELECT b.name as brand_name, s.month, SUM(s.quantity) as total
                FROM sales_data s
                LEFT JOIN brands b ON s.brand_id = b.id
                WHERE s.year = $1
                GROUP BY b.name, s.month
                ORDER BY b.name ASC, s.month ASC
            `, [selectedYear]);

            // Organize data: { "JOHN DEERE": [total, jan, feb, ...], ... }
            const brandsData = {};
            const monthsTotal = Array(13).fill(0); // [0] unused, 1-12
            let grandTotalAll = 0;

            salesRes.rows.forEach(r => {
                const bName = r.brand_name || 'DİĞER';
                const m = parseInt(r.month);
                const val = parseInt(r.total);

                if (!brandsData[bName]) brandsData[bName] = Array(13).fill(0);
                brandsData[bName][m] = val;
                monthsTotal[m] += val;
                grandTotalAll += val;
            });

            // Compute row totals for brands
            Object.keys(brandsData).forEach(b => {
                let rSum = 0;
                for (let i = 1; i <= 12; i++) rSum += brandsData[b][i];
                brandsData[b][0] = rSum; // Row total stored at index 0
            });

            const yearsRes = await pool.query('SELECT DISTINCT year FROM sales_data ORDER BY year DESC');

            res.json({
                selected_year: selectedYear,
                brands_data: brandsData,
                months_total: monthsTotal,
                grand_total: grandTotalAll,
                available_years: yearsRes.rows.map(r => parseInt(r.year, 10)),
                min_year: minYear,
                max_year: maxYear,
                source_table: 'sales_data'
            });
        } catch (err) {
            console.error('TarmakBirTotal error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // MANUAL SEED ENDPOINT (admin only)
    // ============================================
    app.post('/api/admin/reseed-sales', authMiddleware, adminOnly, async (req, res) => {
        try {
            await pool.query('DELETE FROM sales_data');
            console.log('🗑️ Eski satış verisi silindi, yeniden seed ediliyor...');
            // Forward to seed-sales
            res.redirect(307, '/api/admin/seed-sales');
        } catch (err) {
            res.status(500).json({ error: errMsg(err) });
        }
    });

    app.post('/api/admin/trigger-import', authMiddleware, adminOnly, async (req, res) => {

        // Don't await synchronously for 2 minutes and risk HTTP timeout, run asynchronously
        const { importExcel } = require('./import-tuik.js');

        importExcel().then(result => {
            console.log('Online import finished:', result);
        }).catch(err => {
            console.error('Online import failed:', err);
        });

        res.json({ message: 'Veri yükleme/aktarma işlemi arka planda başlatıldı. Yaklaşık 2-3 dakika sürebilir.' });
    });

    app.post('/api/admin/seed-sales', authMiddleware, adminOnly, async (req, res) => {
        try {
            const salesCheck = await pool.query('SELECT COUNT(*) FROM sales_data');
            if (parseInt(salesCheck.rows[0].count) > 0) {
                return res.json({ message: `Satış verisi zaten mevcut: ${salesCheck.rows[0].count} kayıt` });
            }

            const brandRows = await pool.query('SELECT id, slug FROM brands ORDER BY id');
            const provRows = await pool.query('SELECT id FROM provinces ORDER BY id');
            const categories = ['tarla', 'bahce'];
            const cabinTypes = ['kabinli', 'rollbar'];
            const driveTypes = ['2WD', '4WD'];
            const hpRanges = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
            const gearConfigs = ['8+2', '8+8', '12+12', '16+16', '32+32', 'CVT'];
            const brandWeights = {
                'new-holland': 2.5, 'massey-ferguson': 2.0, 'john-deere': 1.8, 'case-ih': 1.5,
                'tumosan': 1.4, 'hattat': 1.3, 'erkunt': 1.2, 'basak': 1.1,
                'deutz-fahr': 1.0, 'kubota': 0.9, 'landini': 0.8, 'same': 0.7,
                'fendt': 0.6, 'claas': 0.5, 'valtra': 0.4, 'solis': 0.5,
                'antonio-carraro': 0.3, 'mccormick': 0.3, 'fiat': 0.2, 'yanmar': 0.2,
                'ferrari-tractors': 0.15, 'karatas': 0.15, 'kioti': 0.2, 'tafe': 0.15
            };

            let salesCount = 0;
            for (const brand of brandRows.rows) {
                const weight = brandWeights[brand.slug] || 0.5;
                const numProvinces = Math.min(81, Math.floor(20 + weight * 25));
                const shuffled = [...provRows.rows].sort(() => Math.random() - 0.5);
                const selectedProvs = shuffled.slice(0, numProvinces);
                let values = []; let placeholders = []; let paramIdx = 1;

                for (const prov of selectedProvs) {
                    for (let year = 2020; year <= 2025; year++) {
                        for (let month = 1; month <= 12; month++) {
                            if (year === 2025 && month > 5) continue;
                            const cat = categories[Math.floor(Math.random() * categories.length)];
                            const cabin = cabinTypes[Math.floor(Math.random() * cabinTypes.length)];
                            const drive = driveTypes[Math.floor(Math.random() * driveTypes.length)];
                            const hp = hpRanges[Math.floor(Math.random() * hpRanges.length)];
                            const gear = gearConfigs[Math.floor(Math.random() * gearConfigs.length)];
                            const seasonFactor = [0.6, 0.7, 1.0, 1.2, 1.1, 0.9, 0.8, 0.7, 0.9, 1.0, 0.8, 0.5][month - 1];
                            const qty = Math.max(1, Math.floor((Math.random() * 10 + 2) * weight * seasonFactor));
                            // model_year: ~70% same year, ~30% previous year (realistic distribution)
                            const modelYear = Math.random() < 0.7 ? year : year - 1;
                            placeholders.push(`($${paramIdx},$${paramIdx + 1},$${paramIdx + 2},$${paramIdx + 3},$${paramIdx + 4},$${paramIdx + 5},$${paramIdx + 6},$${paramIdx + 7},$${paramIdx + 8},$${paramIdx + 9},$${paramIdx + 10})`);
                            values.push(brand.id, prov.id, year, month, qty, cat, cabin, drive, hp, gear, modelYear);
                            paramIdx += 11; salesCount++;

                            if (placeholders.length >= 200) {
                                await pool.query(`INSERT INTO sales_data (brand_id,province_id,year,month,quantity,category,cabin_type,drive_type,hp_range,gear_config,model_year) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
                                placeholders = []; values = []; paramIdx = 1;
                            }
                        }
                    }
                }
                if (placeholders.length > 0) {
                    await pool.query(`INSERT INTO sales_data (brand_id,province_id,year,month,quantity,category,cabin_type,drive_type,hp_range,gear_config,model_year) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
                }
                console.log(`  ✅ ${brand.slug} seed tamamlandı`);
            }

            res.json({ message: `✅ ${salesCount} satış kaydı oluşturuldu` });
        } catch (err) {
            console.error('Seed error:', err);
            res.status(500).json({ error: errMsg(err) });
        }
    });
};
