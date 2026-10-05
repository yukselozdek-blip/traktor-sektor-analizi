'use strict';
const { logRouteError } = require('../lib/log-error');
// Bildirimler, n8n workflow listesi, dashboard ve admin kullanıcı route'ları, server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerDashboardAdmin(app, ctx) {
    const { bcrypt, pool, authMiddleware, adminOnly } = ctx;

    // ============================================
    // NOTIFICATIONS
    // ============================================
    app.get('/api/notifications', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM notifications
                WHERE (user_id = $1 OR (brand_id = $2 AND user_id IS NULL))
                ORDER BY created_at DESC LIMIT 50
            `, [req.user.id, req.user.brand_id]);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/notifications');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.put('/api/notifications/:id/read', authMiddleware, async (req, res) => {
        try {
            await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
            res.json({ success: true });
        } catch (err) {
            logRouteError(req, err, 'PUT /api/notifications/:id/read');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // N8N WORKFLOWS
    // ============================================
    app.get('/api/workflows', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM n8n_workflows ORDER BY title');
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/workflows');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // DASHBOARD DEEP DIVE
    // ============================================
    app.get('/api/dashboard/deep-dive', authMiddleware, async (req, res) => {
        try {
            const { year, brand_id, cabin_type, drive_type, hp_range, gear_config } = req.query;
            const targetYear = year && year !== 'all' ? parseInt(year, 10) : null;
            const focusBrandId = req.user.role === 'admin'
                ? (brand_id ? parseInt(brand_id, 10) : null)
                : (req.user.brand_id ? parseInt(req.user.brand_id, 10) : null);

            const monthNamesShort = ['Oca', '\u015eub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'A\u011fu', 'Eyl', 'Eki', 'Kas', 'Ara'];
            const monthNamesLong = ['Ocak', '\u015eubat', 'Mart', 'Nisan', 'May\u0131s', 'Haziran', 'Temmuz', 'A\u011fustos', 'Eyl\u00fcl', 'Ekim', 'Kas\u0131m', 'Aral\u0131k'];
            const categoryLabels = { tarla: 'Tarla', bahce: 'Bah\u00e7e' };
            const cabinLabels = { kabinli: 'Kabinli', rollbar: 'Rollbar' };

            const normalizedBrandExpr = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'K\u0130OT\u0130'
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
            const driveTypeExpr = `UPPER(COALESCE(tk.cekis_tipi, ''))`;
            const gearConfigExpr = `COALESCE(tk.vites_sayisi, '')`;
            const categoryExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' OR LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah\u00e7e%' THEN 'bahce'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                    ELSE NULL
                END
            `;

            const buildRowsQuery = (requestedYear) => {
                const params = [];
                let where = 'WHERE 1=1';

                if (Number.isFinite(requestedYear)) {
                    params.push(requestedYear);
                    where += ` AND tv.tescil_yil = $${params.length}`;
                }
                if (cabin_type) {
                    params.push(cabin_type);
                    where += ` AND ${cabinTypeExpr} = $${params.length}`;
                }
                if (drive_type) {
                    params.push(String(drive_type).toUpperCase());
                    where += ` AND ${driveTypeExpr} = $${params.length}`;
                }
                if (hp_range) {
                    params.push(hp_range);
                    where += ` AND ${hpRangeExpr} = $${params.length}`;
                }
                if (gear_config) {
                    params.push(gear_config);
                    where += ` AND ${gearConfigExpr} = $${params.length}`;
                }

                return {
                    query: `
                        SELECT
                            tv.tescil_yil AS year,
                            tv.tescil_ay AS month,
                            p.id AS province_id,
                            p.name AS province_name,
                            p.region AS region,
                            b.id AS brand_id,
                            b.name AS brand_name,
                            b.slug AS brand_slug,
                            b.primary_color,
                            COALESCE(NULLIF(tk.model, ''), tv.tuik_model_adi) AS model_name,
                            ${categoryExpr} AS category,
                            ${cabinTypeExpr} AS cabin_type,
                            ${driveTypeExpr} AS drive_type,
                            ${hpRangeExpr} AS hp_range,
                            ${gearConfigExpr} AS gear_config,
                            tk.motor_gucu_hp AS horsepower,
                            tv.satis_adet AS quantity
                        FROM tuik_veri tv
                        JOIN brands b
                            ON UPPER(b.name) = UPPER(${normalizedBrandExpr})
                        JOIN provinces p
                            ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                        LEFT JOIN teknik_veri tk
                            ON UPPER(tk.marka) = UPPER(${normalizedBrandExpr})
                           AND UPPER(tk.tuik_model_adi) = UPPER(tv.tuik_model_adi)
                        ${where}
                    `,
                    params
                };
            };

            const normalizeRows = (rows) => rows.map(row => ({
                year: parseInt(row.year, 10),
                month: parseInt(row.month, 10),
                province_id: parseInt(row.province_id, 10),
                province_name: row.province_name,
                region: row.region,
                brand_id: parseInt(row.brand_id, 10),
                brand_name: row.brand_name,
                brand_slug: row.brand_slug,
                primary_color: row.primary_color,
                model_name: row.model_name || '-',
                category: row.category || null,
                cabin_type: row.cabin_type || null,
                drive_type: row.drive_type || null,
                hp_range: row.hp_range || null,
                gear_config: row.gear_config || null,
                horsepower: row.horsepower == null ? null : parseFloat(row.horsepower),
                quantity: parseInt(row.quantity, 10) || 0
            }));

            const sumQty = (items) => items.reduce((sum, item) => sum + (item.quantity || 0), 0);
            const sumTotalSales = (items) => items.reduce((sum, item) => sum + (item.total_sales || 0), 0);
            const countDistinct = (items, selector) => new Set(items.map(selector).filter(Boolean)).size;
            const safePct = (value, total, digits = 1) => {
                if (!total) return 0;
                return parseFloat(((value * 100) / total).toFixed(digits));
            };

            const currentQuery = buildRowsQuery(targetYear);
            const currentRows = normalizeRows((await pool.query(currentQuery.query, currentQuery.params)).rows);
            const previousRows = Number.isFinite(targetYear)
                ? normalizeRows((await pool.query(buildRowsQuery(targetYear - 1).query, buildRowsQuery(targetYear - 1).params)).rows)
                : [];

            const contextRows = focusBrandId ? currentRows.filter(row => row.brand_id === focusBrandId) : currentRows;
            const contextPrevRows = focusBrandId ? previousRows.filter(row => row.brand_id === focusBrandId) : previousRows;
            const marketTotal = sumQty(currentRows);
            const contextTotal = sumQty(contextRows);
            const maxMonth = Number.isFinite(targetYear) && currentRows.length
                ? Math.max(...currentRows.map(row => row.month || 0))
                : 12;
            const previousMarketTotal = Number.isFinite(targetYear)
                ? sumQty(previousRows.filter(row => !maxMonth || row.month <= maxMonth))
                : null;
            const previousContextTotal = Number.isFinite(targetYear)
                ? sumQty(contextPrevRows.filter(row => !maxMonth || row.month <= maxMonth))
                : null;

            const marketYoyPct = previousMarketTotal ? safePct(marketTotal - previousMarketTotal, previousMarketTotal, 1) : null;
            const contextYoyPct = previousContextTotal ? safePct(contextTotal - previousContextTotal, previousContextTotal, 1) : null;

            const brandMap = new Map();
            currentRows.forEach(row => {
                const existing = brandMap.get(row.brand_id) || {
                    brand_id: row.brand_id,
                    brand_name: row.brand_name,
                    slug: row.brand_slug,
                    primary_color: row.primary_color,
                    total_sales: 0,
                    provinces: new Set()
                };
                existing.total_sales += row.quantity;
                existing.provinces.add(row.province_id);
                brandMap.set(row.brand_id, existing);
            });

            const brandRanking = Array.from(brandMap.values())
                .map(item => ({
                    brand_id: item.brand_id,
                    brand_name: item.brand_name,
                    slug: item.slug,
                    primary_color: item.primary_color,
                    total_sales: item.total_sales,
                    province_count: item.provinces.size,
                    market_share_pct: safePct(item.total_sales, marketTotal, 2)
                }))
                .sort((a, b) => b.total_sales - a.total_sales);

            const selectedBrand = focusBrandId
                ? (brandRanking.find(item => item.brand_id === focusBrandId) || null)
                : null;
            const leaderBrand = brandRanking[0] || null;

            const provinceMap = new Map();
            contextRows.forEach(row => {
                const current = provinceMap.get(row.province_id) || {
                    province_id: row.province_id,
                    province_name: row.province_name,
                    region: row.region,
                    total_sales: 0
                };
                current.total_sales += row.quantity;
                provinceMap.set(row.province_id, current);
            });
            const topProvinces = Array.from(provinceMap.values())
                .sort((a, b) => b.total_sales - a.total_sales)
                .slice(0, 10)
                .map(item => ({
                    ...item,
                    share_pct: safePct(item.total_sales, contextTotal, 1)
                }));

            const modelMap = new Map();
            contextRows.forEach(row => {
                const key = focusBrandId ? row.model_name : `${row.brand_id}::${row.model_name}`;
                const existing = modelMap.get(key) || {
                    brand_name: row.brand_name,
                    model_name: row.model_name,
                    total_sales: 0,
                    horsepower_sum: 0,
                    horsepower_qty: 0
                };
                existing.total_sales += row.quantity;
                if (Number.isFinite(row.horsepower)) {
                    existing.horsepower_sum += row.horsepower * row.quantity;
                    existing.horsepower_qty += row.quantity;
                }
                modelMap.set(key, existing);
            });
            const topModels = Array.from(modelMap.values())
                .sort((a, b) => b.total_sales - a.total_sales)
                .slice(0, 10)
                .map(item => ({
                    brand_name: item.brand_name,
                    model_name: item.model_name,
                    total_sales: item.total_sales,
                    avg_hp: item.horsepower_qty ? parseFloat((item.horsepower_sum / item.horsepower_qty).toFixed(1)) : null,
                    share_pct: safePct(item.total_sales, contextTotal, 1)
                }));

            const buildMix = (rows, keySelector, labelSelector, limit = 8) => {
                const map = new Map();
                rows.forEach(row => {
                    const key = keySelector(row);
                    if (!key) return;
                    const existing = map.get(key) || {
                        key,
                        label: labelSelector(key, row),
                        total_sales: 0
                    };
                    existing.total_sales += row.quantity;
                    map.set(key, existing);
                });
                return Array.from(map.values())
                    .sort((a, b) => b.total_sales - a.total_sales)
                    .slice(0, limit)
                    .map(item => ({
                        ...item,
                        share_pct: safePct(item.total_sales, contextTotal, 1)
                    }));
            };

            const categoryMix = buildMix(contextRows, row => row.category, key => categoryLabels[key] || key, 4);
            const cabinMix = buildMix(contextRows, row => row.cabin_type, key => cabinLabels[key] || key, 4);
            const driveMix = buildMix(contextRows, row => row.drive_type, key => key, 4);
            const hpMix = buildMix(contextRows, row => row.hp_range, key => `${key} HP`, 8);
            const gearMix = buildMix(contextRows, row => row.gear_config, key => key, 6);

            const hpAccumulator = contextRows.reduce((acc, row) => {
                if (Number.isFinite(row.horsepower)) {
                    acc.weighted += row.horsepower * row.quantity;
                    acc.total += row.quantity;
                }
                return acc;
            }, { weighted: 0, total: 0 });

            const avgHp = hpAccumulator.total
                ? parseFloat((hpAccumulator.weighted / hpAccumulator.total).toFixed(1))
                : null;
            const ratio4wdPct = contextTotal
                ? safePct(sumQty(contextRows.filter(row => row.drive_type === '4WD')), contextTotal, 1)
                : 0;

            const monthlyTrend = monthNamesShort.map((label, index) => {
                const month = index + 1;
                const marketSales = sumQty(currentRows.filter(row => row.month === month));
                const contextSales = sumQty(contextRows.filter(row => row.month === month));
                const prevMarketSales = Number.isFinite(targetYear)
                    ? sumQty(previousRows.filter(row => row.month === month))
                    : null;
                const prevContextSales = Number.isFinite(targetYear)
                    ? sumQty(contextPrevRows.filter(row => row.month === month))
                    : null;
                return {
                    month,
                    label,
                    market_sales: marketSales,
                    context_sales: contextSales,
                    prev_market_sales: prevMarketSales,
                    prev_context_sales: prevContextSales
                };
            });

            const availableYears = Array.from(new Set(currentRows.map(row => row.year))).sort((a, b) => a - b);
            const minYear = availableYears[0] || targetYear || null;
            const maxYear = availableYears[availableYears.length - 1] || targetYear || null;
            const periodLabel = Number.isFinite(targetYear)
                ? `${targetYear} ${maxMonth && maxMonth < 12 ? `Ocak-${monthNamesLong[Math.max(0, maxMonth - 1)]}` : 'tam yil'}`
                : (minYear && maxYear ? `${minYear}-${maxYear} birikimli gorunum` : 'Tum yillar');

            res.json({
                filters: {
                    year: Number.isFinite(targetYear) ? String(targetYear) : 'all',
                    brand_id: focusBrandId || null,
                    cabin_type: cabin_type || '',
                    drive_type: drive_type ? String(drive_type).toUpperCase() : '',
                    hp_range: hp_range || '',
                    gear_config: gear_config || ''
                },
                period: {
                    target_year: targetYear,
                    max_month: maxMonth,
                    label: periodLabel,
                    previous_market_sales: previousMarketTotal,
                    previous_context_sales: previousContextTotal,
                    market_yoy_pct: marketYoyPct,
                    context_yoy_pct: contextYoyPct
                },
                overview: {
                    market_sales: marketTotal,
                    context_sales: contextTotal,
                    market_share_pct: selectedBrand ? selectedBrand.market_share_pct : null,
                    leader_share_pct: leaderBrand ? leaderBrand.market_share_pct : null,
                    active_provinces: countDistinct(contextRows, row => row.province_id),
                    brand_count: countDistinct(currentRows, row => row.brand_id),
                    model_count: countDistinct(contextRows, row => `${row.brand_id}::${row.model_name}`),
                    avg_hp: avgHp,
                    ratio_4wd_pct: ratio4wdPct
                },
                selected_brand: selectedBrand,
                leader_brand: leaderBrand,
                highlights: {
                    top_category: categoryMix[0] || null,
                    top_cabin: cabinMix[0] || null,
                    top_drive: driveMix[0] || null,
                    top_hp: hpMix[0] || null,
                    top_province: topProvinces[0] || null,
                    top_model: topModels[0] || null
                },
                trend_mode: selectedBrand ? 'focus-brand' : (Number.isFinite(targetYear) ? 'market-yoy' : 'market-aggregate'),
                monthly_trend: monthlyTrend,
                market_share: brandRanking.slice(0, 10),
                brand_ranking: brandRanking.slice(0, 15),
                top_provinces: topProvinces,
                top_models: topModels,
                category_mix: categoryMix,
                cabin_mix: cabinMix,
                drive_mix: driveMix,
                hp_mix: hpMix,
                gear_mix: gearMix,
                totals: {
                    market_share_total: sumTotalSales(brandRanking),
                    context_total: contextTotal
                }
            });
        } catch (err) {
            console.error('Dashboard deep dive error:', err);
            res.status(500).json({ error: 'Sunucu hatasi' });
        }
    });

    // ============================================
    // DASHBOARD SUMMARY
    // ============================================
    app.get('/api/dashboard', authMiddleware, async (req, res) => {
        try {
            const userBrandId = req.user.brand_id;
            const { year } = req.query;
            const currentYear = year ? parseInt(year) : new Date().getFullYear();

            const [totalSales, brandSales, provinceCount, marketShare, topProvinces, monthlyTrend] = await Promise.all([
                pool.query('SELECT SUM(quantity) as total FROM sales_view WHERE year = $1', [currentYear]),
                userBrandId
                    ? pool.query('SELECT SUM(quantity) as total FROM sales_view WHERE year = $1 AND brand_id = $2', [currentYear, userBrandId])
                    : pool.query('SELECT SUM(quantity) as total FROM sales_view WHERE year = $1', [currentYear]),
                userBrandId
                    ? pool.query('SELECT COUNT(DISTINCT province_id) as count FROM sales_view WHERE year = $1 AND brand_id = $2', [currentYear, userBrandId])
                    : pool.query('SELECT COUNT(DISTINCT province_id) as count FROM sales_view WHERE year = $1', [currentYear]),
                userBrandId
                    ? pool.query(`SELECT ROUND(SUM(CASE WHEN brand_id = $2 THEN quantity ELSE 0 END) * 100.0 / NULLIF(SUM(quantity), 0), 2) as share FROM sales_view WHERE year = $1`, [currentYear, userBrandId])
                    : null,
                userBrandId
                    ? pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_view s JOIN provinces p ON s.province_id = p.id WHERE s.year = $1 AND s.brand_id = $2 GROUP BY p.name ORDER BY total DESC LIMIT 10`, [currentYear, userBrandId])
                    : pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_view s JOIN provinces p ON s.province_id = p.id WHERE s.year = $1 GROUP BY p.name ORDER BY total DESC LIMIT 10`, [currentYear]),
                userBrandId
                    ? pool.query(`SELECT month, SUM(quantity) as total FROM sales_view WHERE year = $1 AND brand_id = $2 GROUP BY month ORDER BY month`, [currentYear, userBrandId])
                    : pool.query(`SELECT month, SUM(quantity) as total FROM sales_view WHERE year = $1 GROUP BY month ORDER BY month`, [currentYear])
            ]);

            res.json({
                total_market_sales: parseInt(totalSales.rows[0]?.total || 0),
                brand_sales: parseInt(brandSales.rows[0]?.total || 0),
                active_provinces: parseInt(provinceCount.rows[0]?.count || 0),
                market_share: marketShare ? parseFloat(marketShare.rows[0]?.share || 0) : null,
                top_provinces: topProvinces.rows,
                monthly_trend: monthlyTrend.rows,
                year: currentYear
            });
        } catch (err) {
            console.error('Dashboard error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // ADMIN ENDPOINTS
    // ============================================
    app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT u.id, u.email, u.full_name, u.role, u.brand_id, u.company_name, u.city, u.is_active, u.last_login, u.created_at,
                       b.name as brand_name
                FROM users u LEFT JOIN brands b ON u.brand_id = b.id
                ORDER BY u.created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/admin/users');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
        try {
            const { password_hash, full_name, role, brand_id, company_name, city } = req.body || {};
            const { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } = require('../config');
            const { validateProfileText, SAFE_EMAIL } = require('../lib/validate');
            const email = String(req.body?.email || '').trim().toLowerCase();
            if (!SAFE_EMAIL.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta girin' });
            if (!PASSWORD_POLICY.test(String(password_hash || ''))) return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
            if (role !== undefined && !['admin', 'brand_user'].includes(role)) return res.status(400).json({ error: 'Geçersiz rol' });
            const textErr = validateProfileText(req.body, ['full_name', 'company_name', 'city']);
            if (textErr) return res.status(400).json({ error: textErr });
            const hash = await bcrypt.hash(String(password_hash), 12);
            const result = await pool.query(`
                INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name, city)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, full_name, role, brand_id
            `, [email, hash, full_name, role || 'brand_user', brand_id, company_name, city]);
            res.json(result.rows[0]);
        } catch (err) {
            logRouteError(req, err, 'POST /api/admin/users');
            if (err.code === '23505') return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

};
