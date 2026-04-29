require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'traktor-sektor-super-secret-key-2024';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const WHATSAPP_QUERY_API_KEY = process.env.WHATSAPP_QUERY_API_KEY || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const MEDIA_WATCH_WEBHOOK_KEY = process.env.MEDIA_WATCH_WEBHOOK_KEY || process.env.WHATSAPP_QUERY_API_KEY || '';
const N8N_WHATSAPP_PROCESSOR_URL = (
    process.env.N8N_WHATSAPP_PROCESSOR_URL
    || (process.env.RAILWAY_SERVICE_N8N_URL ? `https://${process.env.RAILWAY_SERVICE_N8N_URL}/webhook/whatsapp-sales-assistant-process-v4` : '')
).replace(/\/$/, '');
const N8N_MODEL_INTEL_WEBHOOK_URL = (process.env.N8N_MODEL_INTEL_WEBHOOK_URL || '').replace(/\/$/, '');
const MODEL_IMAGE_BRIDGE_URL = (process.env.MODEL_IMAGE_BRIDGE_URL || 'http://127.0.0.1:3012').replace(/\/$/, '');

function shouldUseDatabaseSsl(connectionString) {
    if (process.env.NODE_ENV !== 'production' || !connectionString) return false;

    try {
        const hostname = (new URL(connectionString).hostname || '').toLowerCase();
        const localHosts = ['localhost', '127.0.0.1', 'postgres', 'host.docker.internal'];
        if (!hostname) return false;
        if (localHosts.includes(hostname)) return false;
        if (hostname.endsWith('.internal')) return false;
        return true;
    } catch {
        return false;
    }
}

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseDatabaseSsl(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : false
});

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
            return;
        }

        if (/\.(js|css)$/i.test(filePath)) {
            res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        }
    }
}));

// Prevent browser caching of HTML files
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
    }
    next();
});

app.get(['/giris/:brandSlug', '/login/:brandSlug', '/portal/:brandSlug'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

// ============================================
// AUTH MIDDLEWARE
// ============================================
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token gerekli' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Geçersiz token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Yetkisiz erişim' });
    next();
}

app.get('/api/auth/diagnostic', async (req, res) => {
    try {
        const users = await pool.query('SELECT id, email, role, full_name, (password_hash IS NOT NULL) as has_password_hash FROM users');
        const schema = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
        res.json({
            status: '✅ Sunucu Aktif',
            database_users: users.rows,
            database_schema: schema.rows.map(r => r.column_name),
            superuser_email: 'yukselozdek@gmail.com'
        });
    } catch (err) {
        res.status(500).json({ status: '❌ Hata', message: err.message });
    }
});

app.get('/api/sales/model-region', authMiddleware, async (req, res) => {
    try {
        await ensureProvincesSeeded();

        const requestedBrandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;
        const requestedModelKey = String(req.query.model_key || '').trim();
        const monthNames = ['Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran', 'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik'];
        const modelWindowFilter = `
            tv.tescil_yil IS NOT NULL
            AND tv.tescil_ay IS NOT NULL
            AND (tv.model_yili IS NULL OR tv.tescil_yil = tv.model_yili OR tv.tescil_yil = tv.model_yili + 1)
        `;
        const normalizedTuikBrandExpr = `
            CASE
                WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                ELSE UPPER(tv.marka)
            END
        `;
        const normalizedTeknikBrandExpr = `
            CASE
                WHEN UPPER(tk.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tk.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tk.marka) = 'KIOTI' THEN 'KİOTİ'
                ELSE UPPER(tk.marka)
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

        const latestPeriodRes = await pool.query(`
            SELECT MAX(MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1)) AS latest_period
            FROM tuik_veri tv
            WHERE ${modelWindowFilter}
        `);
        const latestPeriod = latestPeriodRes.rows[0]?.latest_period;
        if (!latestPeriod) {
            return res.json({
                meta: null,
                brands: [],
                selected_brand_id: null,
                selected_model_key: null,
                models: [],
                focus: null
            });
        }

        const latestDate = new Date(latestPeriod);
        const maxYear = latestDate.getUTCFullYear();
        const maxMonth = latestDate.getUTCMonth() + 1;
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query(`
            SELECT MIN(tv.tescil_yil) AS min_year
            FROM tuik_veri tv
            WHERE ${modelWindowFilter}
        `);
        const minYear = parseInt(minYearRes.rows[0]?.min_year || maxYear, 10);
        const years = Array.from({ length: Math.max(maxYear - minYear + 1, 1) }, (_, index) => minYear + index);

        const [provinceRes, supportRes, catalogRes] = await Promise.all([
            pool.query(`
                SELECT
                    id, name, plate_code, region, latitude, longitude, population,
                    agricultural_area_hectare, primary_crops, soil_type, climate_zone,
                    annual_rainfall_mm, avg_temperature, elevation_m
                FROM provinces
                ORDER BY name
            `),
            pool.query(`
                SELECT
                    spc.province_id,
                    STRING_AGG(sp.program_name, ', ' ORDER BY sp.program_name) AS support_programs
                FROM support_program_coverage spc
                JOIN support_programs sp ON sp.id = spc.program_id
                WHERE sp.status IN ('announced', 'active')
                GROUP BY spc.province_id
            `),
            pool.query(`
                WITH model_base AS (
                    SELECT
                        b.id AS brand_id,
                        b.name AS brand_name,
                        b.slug AS brand_slug,
                        b.primary_color,
                        tv.tuik_model_adi,
                        COALESCE(NULLIF(MAX(tk.model), ''), tv.tuik_model_adi) AS model_name,
                        ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) AS horsepower,
                        ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) AS price_usd,
                        COALESCE(
                            MODE() WITHIN GROUP (
                                ORDER BY CASE
                                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah%' THEN 'bahce'
                                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%hib%' THEN 'hibrit'
                                    ELSE 'tarla'
                                END
                            ),
                            'tarla'
                        ) AS category,
                        COALESCE(
                            MODE() WITHIN GROUP (ORDER BY UPPER(COALESCE(NULLIF(tk.cekis_tipi, ''), '4WD'))),
                            '4WD'
                        ) AS drive_type,
                        COALESCE(
                            MODE() WITHIN GROUP (
                                ORDER BY CASE
                                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                                    ELSE 'rollbar'
                                END
                            ),
                            'rollbar'
                        ) AS cabin_type,
                        COALESCE(
                            MODE() WITHIN GROUP (ORDER BY COALESCE(NULLIF(tk.vites_sayisi, ''), 'Standart')),
                            'Standart'
                        ) AS gear_config,
                        SUM(tv.satis_adet)::int AS total_sales,
                        SUM(CASE WHEN tv.tescil_yil = $1 AND tv.tescil_ay <= $2 THEN tv.satis_adet ELSE 0 END)::int AS current_year_sales,
                        SUM(CASE WHEN tv.tescil_yil = $3 AND tv.tescil_ay <= $2 THEN tv.satis_adet ELSE 0 END)::int AS prev_year_sales,
                        COUNT(DISTINCT p.id)::int AS province_count,
                        COUNT(DISTINCT p.region)::int AS region_count
                    FROM tuik_veri tv
                    JOIN brands b
                      ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                    LEFT JOIN provinces p
                      ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                    LEFT JOIN teknik_veri tk
                      ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
                     AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
                    WHERE ${modelWindowFilter}
                    GROUP BY b.id, b.name, b.slug, b.primary_color, tv.tuik_model_adi
                )
                SELECT
                    *,
                    CASE
                        WHEN horsepower IS NULL THEN NULL
                        WHEN horsepower <= 39 THEN '1-39'
                        WHEN horsepower <= 49 THEN '40-49'
                        WHEN horsepower <= 54 THEN '50-54'
                        WHEN horsepower <= 59 THEN '55-59'
                        WHEN horsepower <= 69 THEN '60-69'
                        WHEN horsepower <= 79 THEN '70-79'
                        WHEN horsepower <= 89 THEN '80-89'
                        WHEN horsepower <= 99 THEN '90-99'
                        WHEN horsepower <= 109 THEN '100-109'
                        WHEN horsepower <= 119 THEN '110-119'
                        ELSE '120+'
                    END AS hp_range
                FROM model_base
                ORDER BY total_sales DESC, brand_name ASC, model_name ASC
            `, [maxYear, maxMonth, prevYear])
        ]);

        const supportMap = new Map(supportRes.rows.map(row => [Number(row.province_id), row.support_programs]));
        const provinceMap = new Map(provinceRes.rows.map(row => {
            const enriched = enrichProvinceWithReference({
                ...row,
                primary_crops: row.primary_crops || [],
                support_programs: supportMap.get(Number(row.id)) || ''
            });
            return [Number(row.id), { ...enriched, support_programs: supportMap.get(Number(row.id)) || '' }];
        }));

        const modelCatalog = catalogRes.rows.map(row => ({
            brand_id: Number(row.brand_id),
            brand_name: row.brand_name,
            brand_slug: row.brand_slug,
            primary_color: row.primary_color,
            model_key: row.tuik_model_adi,
            tuik_model_adi: row.tuik_model_adi,
            model_name: row.model_name || row.tuik_model_adi,
            horsepower: row.horsepower == null ? null : Number(row.horsepower),
            hp_range: row.hp_range || hpRangeFromHorsepower(row.horsepower),
            category: row.category || 'tarla',
            drive_type: row.drive_type || '4WD',
            cabin_type: row.cabin_type || 'rollbar',
            gear_config: row.gear_config || 'Standart',
            price_usd: row.price_usd == null ? null : Number(row.price_usd),
            total_sales: Number(row.total_sales || 0),
            current_year_sales: Number(row.current_year_sales || 0),
            prev_year_sales: Number(row.prev_year_sales || 0),
            province_count: Number(row.province_count || 0),
            region_count: Number(row.region_count || 0),
            yoy_growth_pct: calculateYoY(Number(row.current_year_sales || 0), Number(row.prev_year_sales || 0))
        })).filter(row => row.total_sales > 0);

        if (!modelCatalog.length) {
            return res.json({
                meta: {
                    max_year: maxYear,
                    max_month: maxMonth,
                    prev_year: prevYear,
                    years,
                    latest_period_label: `${maxYear} ${monthNames[maxMonth - 1]}`,
                    latest_window_label: `${maxYear} Ocak-${monthNames[maxMonth - 1]}`,
                    model_window_note: 'Model bazlı veriler N ve N-1 kuralına göre tuik_veri üzerinden okunur.'
                },
                brands: [],
                selected_brand_id: null,
                selected_model_key: null,
                models: [],
                focus: null
            });
        }

        const brandAggregateMap = new Map();
        modelCatalog.forEach(model => {
            if (!brandAggregateMap.has(model.brand_id)) {
                brandAggregateMap.set(model.brand_id, {
                    id: model.brand_id,
                    name: model.brand_name,
                    slug: model.brand_slug,
                    primary_color: model.primary_color,
                    total_sales: 0,
                    model_count: 0,
                    current_year_sales: 0,
                    prev_year_sales: 0,
                    top_model_name: model.model_name,
                    top_model_sales: model.total_sales
                });
            }
            const brand = brandAggregateMap.get(model.brand_id);
            brand.total_sales += model.total_sales;
            brand.model_count += 1;
            brand.current_year_sales += model.current_year_sales;
            brand.prev_year_sales += model.prev_year_sales;
            if (model.total_sales > brand.top_model_sales) {
                brand.top_model_name = model.model_name;
                brand.top_model_sales = model.total_sales;
            }
        });

        const brands = Array.from(brandAggregateMap.values())
            .map(item => ({
                ...item,
                yoy_growth_pct: calculateYoY(item.current_year_sales, item.prev_year_sales)
            }))
            .sort((left, right) => right.total_sales - left.total_sales || String(left.name || '').localeCompare(String(right.name || ''), 'tr'));

        let selectedBrandId = requestedBrandId && brands.some(item => item.id === requestedBrandId)
            ? requestedBrandId
            : (req.user?.role !== 'admin' && req.user?.brand_id && brands.some(item => item.id === Number(req.user.brand_id))
                ? Number(req.user.brand_id)
                : brands[0]?.id);

        let selectedBrandModels = modelCatalog
            .filter(item => item.brand_id === selectedBrandId)
            .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'));

        if (!selectedBrandModels.length) {
            selectedBrandId = modelCatalog[0].brand_id;
            selectedBrandModels = modelCatalog
                .filter(item => item.brand_id === selectedBrandId)
                .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'));
        }

        let selectedModel = selectedBrandModels.find(item => item.model_key === requestedModelKey)
            || selectedBrandModels.find(item => String(item.tuik_model_adi || '').toUpperCase() === requestedModelKey.toUpperCase())
            || selectedBrandModels[0];

        if (!selectedModel) {
            selectedModel = modelCatalog[0];
            selectedBrandId = selectedModel.brand_id;
            selectedBrandModels = modelCatalog
                .filter(item => item.brand_id === selectedBrandId)
                .sort((left, right) => right.total_sales - left.total_sales || String(left.model_name || '').localeCompare(String(right.model_name || ''), 'tr'));
        }

        const [modelProvinceSalesRes, provinceMarketRes] = await Promise.all([
            pool.query(`
                SELECT
                    p.id AS province_id,
                    p.name AS province_name,
                    p.plate_code,
                    p.region,
                    p.latitude,
                    p.longitude,
                    p.population,
                    p.agricultural_area_hectare,
                    p.primary_crops,
                    p.soil_type,
                    p.climate_zone,
                    p.annual_rainfall_mm,
                    p.avg_temperature,
                    p.elevation_m,
                    tv.tescil_yil,
                    tv.tescil_ay,
                    SUM(tv.satis_adet)::int AS total_sales
                FROM tuik_veri tv
                JOIN brands b
                  ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                JOIN provinces p
                  ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                WHERE b.id = $1
                  AND UPPER(COALESCE(tv.tuik_model_adi, '')) = UPPER($2)
                  AND ${modelWindowFilter}
                GROUP BY
                    p.id, p.name, p.plate_code, p.region, p.latitude, p.longitude, p.population,
                    p.agricultural_area_hectare, p.primary_crops, p.soil_type, p.climate_zone,
                    p.annual_rainfall_mm, p.avg_temperature, p.elevation_m,
                    tv.tescil_yil, tv.tescil_ay
                ORDER BY tv.tescil_yil, tv.tescil_ay, p.name
            `, [selectedBrandId, selectedModel.model_key]),
            pool.query(`
                SELECT
                    p.id AS province_id,
                    SUM(CASE WHEN tv.tescil_yil = $1 AND tv.tescil_ay <= $2 THEN tv.satis_adet ELSE 0 END)::int AS current_market_sales,
                    SUM(CASE WHEN tv.tescil_yil = $3 AND tv.tescil_ay <= $2 THEN tv.satis_adet ELSE 0 END)::int AS prev_market_sales,
                    SUM(tv.satis_adet)::int AS total_market_sales
                FROM tuik_veri tv
                JOIN provinces p
                  ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
                WHERE ${modelWindowFilter}
                GROUP BY p.id
            `, [maxYear, maxMonth, prevYear])
        ]);

        const marketMap = new Map(provinceMarketRes.rows.map(row => [Number(row.province_id), {
            current_market_sales: Number(row.current_market_sales || 0),
            prev_market_sales: Number(row.prev_market_sales || 0),
            total_market_sales: Number(row.total_market_sales || 0)
        }]));

        const modelProvinceMap = new Map();
        const monthlyCurveMap = new Map();
        modelProvinceSalesRes.rows.forEach(row => {
            const provinceId = Number(row.province_id);
            const province = provinceMap.get(provinceId) || enrichProvinceWithReference({
                id: provinceId,
                name: row.province_name,
                plate_code: row.plate_code,
                region: row.region,
                latitude: row.latitude,
                longitude: row.longitude,
                population: row.population,
                agricultural_area_hectare: row.agricultural_area_hectare,
                primary_crops: row.primary_crops || [],
                soil_type: row.soil_type,
                climate_zone: row.climate_zone,
                annual_rainfall_mm: row.annual_rainfall_mm,
                avg_temperature: row.avg_temperature,
                elevation_m: row.elevation_m,
                support_programs: supportMap.get(provinceId) || ''
            });

            if (!modelProvinceMap.has(provinceId)) {
                modelProvinceMap.set(provinceId, {
                    province_id: provinceId,
                    province_name: province.name,
                    plate_code: province.plate_code,
                    region: province.region,
                    latitude: province.latitude,
                    longitude: province.longitude,
                    population: province.population,
                    agricultural_area_hectare: province.agricultural_area_hectare,
                    soil_type: province.soil_type,
                    climate_zone: province.climate_zone,
                    annual_rainfall_mm: province.annual_rainfall_mm,
                    avg_temperature: province.avg_temperature,
                    elevation_m: province.elevation_m,
                    primary_crops: province.primary_crops,
                    support_programs: province.support_programs || '',
                    yearly: new Map(),
                    monthly: new Map(),
                    total_sales: 0
                });
            }

            const provinceItem = modelProvinceMap.get(provinceId);
            const sales = Number(row.total_sales || 0);
            const year = Number(row.tescil_yil);
            const month = Number(row.tescil_ay);
            provinceItem.total_sales += sales;
            provinceItem.yearly.set(year, (provinceItem.yearly.get(year) || 0) + sales);
            provinceItem.monthly.set(`${year}-${String(month).padStart(2, '0')}`, (provinceItem.monthly.get(`${year}-${String(month).padStart(2, '0')}`) || 0) + sales);
            monthlyCurveMap.set(`${year}-${String(month).padStart(2, '0')}`, (monthlyCurveMap.get(`${year}-${String(month).padStart(2, '0')}`) || 0) + sales);
        });

        const provinceMarketMax = Array.from(marketMap.values()).reduce((maxValue, item) => Math.max(maxValue, Number(item.current_market_sales || 0)), 0);
        const provinceInsights = Array.from(provinceMap.values()).map(province => {
            const modelSales = modelProvinceMap.get(Number(province.id));
            const compatibility = computeModelProvinceCompatibility(selectedModel, province);
            const market = marketMap.get(Number(province.id)) || { current_market_sales: 0, prev_market_sales: 0, total_market_sales: 0 };
            const totalSales = Number(modelSales?.total_sales || 0);
            const currentPartialSales = Array.from(modelSales?.monthly?.entries() || [])
                .filter(([key]) => {
                    const [yearText, monthText] = key.split('-');
                    return Number(yearText) === maxYear && Number(monthText) <= maxMonth;
                })
                .reduce((sum, [, value]) => sum + Number(value || 0), 0);
            const prevPartialSales = Array.from(modelSales?.monthly?.entries() || [])
                .filter(([key]) => {
                    const [yearText, monthText] = key.split('-');
                    return Number(yearText) === prevYear && Number(monthText) <= maxMonth;
                })
                .reduce((sum, [, value]) => sum + Number(value || 0), 0);
            const provinceSharePct = Number(market.current_market_sales || 0) > 0
                ? Number(((currentPartialSales * 100) / Number(market.current_market_sales || 0)).toFixed(2))
                : 0;
            const marketNorm = provinceMarketMax > 0 ? Number(market.current_market_sales || 0) / provinceMarketMax : 0;
            const supportBonus = province.support_programs ? 6 : 0;
            const penetrationPenalty = Number(market.current_market_sales || 0) > 0
                ? Math.min(1, currentPartialSales / Number(market.current_market_sales || 1))
                : 0;
            const opportunityScore = Math.max(0, Math.min(100, Number(((compatibility.score * 0.68) + (marketNorm * 24) + supportBonus - (penetrationPenalty * 22)).toFixed(1))));
            const yoyGrowthPct = prevPartialSales > 0 ? Number((((currentPartialSales - prevPartialSales) / prevPartialSales) * 100).toFixed(1)) : null;

            return {
                province_id: Number(province.id),
                province_name: province.name,
                plate_code: province.plate_code,
                region: province.region,
                latitude: province.latitude == null ? null : Number(province.latitude),
                longitude: province.longitude == null ? null : Number(province.longitude),
                total_sales: totalSales,
                current_sales: currentPartialSales,
                prev_sales: prevPartialSales,
                yoy_growth_pct: yoyGrowthPct,
                province_market_units: Number(market.current_market_sales || 0),
                province_share_pct: provinceSharePct,
                fit_score: compatibility.score,
                fit_label: compatibility.label,
                opportunity_score: opportunityScore,
                mission_label: buildModelRegionMission({
                    fitScore: compatibility.score,
                    modelSharePct: provinceSharePct,
                    yoyPct: yoyGrowthPct,
                    opportunityScore
                }),
                dominant_crop: compatibility.dominant_crop,
                reference_label: compatibility.reference_label,
                soil_type: compatibility.soil_type,
                climate_zone: compatibility.climate_zone,
                annual_rainfall_mm: compatibility.annual_rainfall_mm,
                avg_temperature: compatibility.avg_temperature,
                elevation_m: compatibility.elevation_m,
                agricultural_area_hectare: compatibility.agricultural_area_hectare,
                primary_crops: compatibility.primary_crops,
                recommended_hp_range: compatibility.recommended_hp_range,
                recommended_drive_type: compatibility.recommended_drive_type,
                recommended_tractor_type: compatibility.recommended_tractor_type,
                fit_note: compatibility.note,
                support_programs: province.support_programs || '',
                yearly_trend: years.map(year => ({
                    year,
                    sales: Number(modelSales?.yearly?.get(year) || 0)
                }))
            };
        });

        const soldProvinceArena = provinceInsights
            .filter(item => item.total_sales > 0)
            .sort((left, right) => right.total_sales - left.total_sales || right.fit_score - left.fit_score || String(left.province_name || '').localeCompare(String(right.province_name || ''), 'tr'));

        const whitespaceProvinces = provinceInsights
            .filter(item => item.opportunity_score >= 58 && item.current_sales <= Math.max(12, item.province_market_units * 0.06))
            .sort((left, right) => right.opportunity_score - left.opportunity_score || right.province_market_units - left.province_market_units || String(left.province_name || '').localeCompare(String(right.province_name || ''), 'tr'))
            .slice(0, 8);

        const regionMap = new Map();
        soldProvinceArena.forEach(item => {
            const regionKey = item.region || 'Bilinmiyor';
            if (!regionMap.has(regionKey)) {
                regionMap.set(regionKey, {
                    region: regionKey,
                    total_sales: 0,
                    current_sales: 0,
                    prev_sales: 0,
                    province_count: 0,
                    fit_weighted: 0,
                    dominant_crop_map: new Map()
                });
            }
            const region = regionMap.get(regionKey);
            region.total_sales += item.total_sales;
            region.current_sales += item.current_sales;
            region.prev_sales += item.prev_sales;
            region.province_count += 1;
            region.fit_weighted += item.fit_score * Math.max(item.total_sales, 1);
            if (!region.dominant_crop_map.has(item.dominant_crop)) region.dominant_crop_map.set(item.dominant_crop, 0);
            region.dominant_crop_map.set(item.dominant_crop, region.dominant_crop_map.get(item.dominant_crop) + item.total_sales);
        });

        const totalModelSales = soldProvinceArena.reduce((sum, item) => sum + item.total_sales, 0);
        const totalCurrentSales = soldProvinceArena.reduce((sum, item) => sum + item.current_sales, 0);
        const totalPrevSales = soldProvinceArena.reduce((sum, item) => sum + item.prev_sales, 0);
        const totalCurrentMarket = provinceInsights.reduce((sum, item) => sum + Number(item.province_market_units || 0), 0);
        const regionLadder = Array.from(regionMap.values())
            .map(region => {
                const avgFitScore = region.total_sales > 0 ? Number((region.fit_weighted / region.total_sales).toFixed(1)) : 0;
                const dominantCrop = Array.from(region.dominant_crop_map.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || null;
                const sharePct = totalModelSales > 0 ? Number(((region.total_sales * 100) / totalModelSales).toFixed(1)) : 0;
                const yoyGrowthPct = region.prev_sales > 0 ? Number((((region.current_sales - region.prev_sales) / region.prev_sales) * 100).toFixed(1)) : null;
                const regionOpportunityScore = Math.max(0, Math.min(100, Number(((avgFitScore * 0.72) + (sharePct * 0.25)).toFixed(1))));
                return {
                    region: region.region,
                    total_sales: region.total_sales,
                    current_sales: region.current_sales,
                    prev_sales: region.prev_sales,
                    share_pct: sharePct,
                    yoy_growth_pct: yoyGrowthPct,
                    province_count: region.province_count,
                    avg_fit_score: avgFitScore,
                    dominant_crop: dominantCrop,
                    mission_label: buildModelRegionMission({
                        fitScore: avgFitScore,
                        modelSharePct: sharePct,
                        yoyPct: yoyGrowthPct,
                        opportunityScore: regionOpportunityScore
                    })
                };
            })
            .sort((left, right) => right.total_sales - left.total_sales || right.avg_fit_score - left.avg_fit_score || String(left.region || '').localeCompare(String(right.region || ''), 'tr'));

        const dominantRegion = regionLadder[0] || null;
        const dominantCrop = soldProvinceArena[0]?.dominant_crop || dominantRegion?.dominant_crop || null;
        const supportDrivenUnits = soldProvinceArena.filter(item => item.support_programs).reduce((sum, item) => sum + Number(item.current_sales || 0), 0);
        const supportDrivenSharePct = totalCurrentSales > 0 ? Number(((supportDrivenUnits * 100) / totalCurrentSales).toFixed(1)) : 0;
        const avgProvinceSharePct = soldProvinceArena.length > 0
            ? Number((soldProvinceArena.reduce((sum, item) => sum + Number(item.province_share_pct || 0), 0) / soldProvinceArena.length).toFixed(1))
            : 0;

        const siblingStack = selectedBrandModels
            .filter(item => item.model_key !== selectedModel.model_key)
            .map(item => {
                const hpDistance = Math.abs(Number(item.horsepower || 0) - Number(selectedModel.horsepower || 0));
                let roleNote = 'Portföy tamamlayıcı';
                if (hpDistance <= 8) roleNote = 'Aynı koridorda saha ikizi';
                else if (Number(item.horsepower || 0) > Number(selectedModel.horsepower || 0)) roleNote = 'Daha yüksek güç koridoru';
                else if (Number(item.horsepower || 0) < Number(selectedModel.horsepower || 0)) roleNote = 'Daha ekonomik alt koridor';
                return { ...item, hp_distance: hpDistance, role_note: roleNote };
            })
            .sort((left, right) => left.hp_distance - right.hp_distance || right.total_sales - left.total_sales)
            .slice(0, 6);

        const monthlyCurve = Array.from(monthlyCurveMap.entries())
            .map(([periodKey, totalUnits]) => {
                const [yearText, monthText] = periodKey.split('-');
                return {
                    year: Number(yearText),
                    month: Number(monthText),
                    period_label: `${monthNames[Number(monthText) - 1]} ${yearText}`,
                    total_units: Number(totalUnits || 0)
                };
            })
            .sort((left, right) => (left.year - right.year) || (left.month - right.month))
            .slice(-24);

        const hpBand = parseHpBand(selectedModel.hp_range || hpRangeFromHorsepower(selectedModel.horsepower));
        const hpMin = Number.isFinite(hpBand.min) ? Math.max(1, hpBand.min - 5) : Math.max(1, Number(selectedModel.horsepower || 0) - 12);
        const hpMax = Number.isFinite(hpBand.max) ? hpBand.max + 5 : Number(selectedModel.horsepower || 0) + 12;
        const focusRegions = Array.from(new Set(soldProvinceArena.slice(0, 8).map(item => item.region).filter(Boolean))).slice(0, 3);
        const rivalParams = [selectedBrandId, selectedModel.hp_range || '', hpMin, hpMax];
        const regionClause = focusRegions.length > 0 ? ` AND p.region = ANY($5::text[])` : '';
        if (focusRegions.length > 0) rivalParams.push(focusRegions);
        const rivalRes = await pool.query(`
            SELECT
                b.name AS brand_name,
                b.primary_color,
                tv.tuik_model_adi,
                COALESCE(NULLIF(MAX(tk.model), ''), tv.tuik_model_adi) AS model_name,
                SUM(tv.satis_adet)::int AS total_sales,
                COALESCE(MODE() WITHIN GROUP (ORDER BY p.region), 'Bilinmiyor') AS dominant_region
            FROM tuik_veri tv
            JOIN brands b
              ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            JOIN provinces p
              ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            LEFT JOIN teknik_veri tk
              ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
             AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
            WHERE b.id <> $1
              ${regionClause}
              AND ${modelWindowFilter}
              AND (
                    ($2 <> '' AND ${hpRangeExpr} = $2)
                    OR ($3 > 0 AND $4 > 0 AND tk.motor_gucu_hp BETWEEN $3 AND $4)
                  )
            GROUP BY b.name, b.primary_color, tv.tuik_model_adi
            ORDER BY total_sales DESC, brand_name ASC, model_name ASC
            LIMIT 8
        `, rivalParams);

        const rivalStack = rivalRes.rows.map(row => ({
            brand_name: row.brand_name,
            primary_color: row.primary_color,
            model_key: row.tuik_model_adi,
            model_name: row.model_name || row.tuik_model_adi,
            total_sales: Number(row.total_sales || 0),
            dominant_region: row.dominant_region
        }));

        const agroCards = [
            {
                label: 'Doğal habitat',
                value: dominantRegion?.region || '-',
                note: dominantRegion
                    ? `${dominantRegion.share_pct}% model yoğunluğu ile ${dominantRegion.region} ana habitat olarak ayrışıyor.`
                    : 'Bölgesel habitat henüz oluşmadı.',
                tone: 'is-up'
            },
            {
                label: 'Agro eksen',
                value: dominantCrop || '-',
                note: dominantCrop
                    ? `${dominantCrop} etrafında saha uyumu kuruluyor ve ürün deseni modeli taşıyor.`
                    : 'Ürün ekseni henüz netleşmedi.',
                tone: 'is-opportunity'
            },
            {
                label: 'Mekanik duruş',
                value: `${selectedModel.hp_range || '-'} · ${selectedModel.drive_type || '-'} · ${selectedModel.category || '-'}`,
                note: `${selectedModel.cabin_type || '-'} kabin ve ${selectedModel.gear_config || 'Standart'} şanzımanla operasyona çıkıyor.`,
                tone: 'is-analysis'
            },
            {
                label: 'Beyaz alan',
                value: `${whitespaceProvinces.length} il`,
                note: whitespaceProvinces[0]
                    ? `${whitespaceProvinces[0].province_name} en yüksek fırsat skoru ile ilk hamle ili.`
                    : 'Beyaz alan adayı oluşmadı.',
                tone: 'is-forecast'
            }
        ];

        const selectedBrand = brands.find(item => item.id === selectedBrandId) || brands[0];

        res.json({
            meta: {
                max_year: maxYear,
                max_month: maxMonth,
                prev_year: prevYear,
                years,
                latest_period_label: `${maxYear} ${monthNames[maxMonth - 1]}`,
                latest_window_label: `${maxYear} Ocak-${monthNames[maxMonth - 1]}`,
                model_window_note: 'Model bazlı veriler N ve N-1 kuralına göre tuik_veri üzerinden okunur.'
            },
            brands,
            selected_brand_id: selectedBrandId,
            selected_model_key: selectedModel.model_key,
            models: selectedBrandModels,
            focus: {
                brand: selectedBrand,
                model: selectedModel,
                overview: {
                    total_sales: totalModelSales,
                    current_year_sales: totalCurrentSales,
                    prev_year_sales: totalPrevSales,
                    yoy_growth_pct: calculateYoY(totalCurrentSales, totalPrevSales),
                    active_provinces: soldProvinceArena.length,
                    active_regions: new Set(soldProvinceArena.map(item => item.region).filter(Boolean)).size,
                    avg_price_usd: selectedModel.price_usd,
                    estimated_revenue_usd: selectedModel.price_usd ? Number((totalModelSales * selectedModel.price_usd).toFixed(2)) : null,
                    national_model_share_pct: totalCurrentMarket > 0 ? Number(((totalCurrentSales * 100) / totalCurrentMarket).toFixed(2)) : 0,
                    avg_province_share_pct: avgProvinceSharePct,
                    dominant_region: dominantRegion?.region || null,
                    dominant_crop: dominantCrop,
                    support_driven_share_pct: supportDrivenSharePct,
                    fit_label: soldProvinceArena[0]?.fit_label || 'Uyum hesaplandı',
                    latest_window_label: `${maxYear} Ocak-${monthNames[maxMonth - 1]}`
                },
                agro_cards: agroCards,
                monthly_curve: monthlyCurve,
                region_ladder: regionLadder,
                province_arena: soldProvinceArena.slice(0, 12),
                whitespace_provinces: whitespaceProvinces,
                sibling_stack: siblingStack,
                rival_stack: rivalStack
            }
        });
    } catch (err) {
        console.error('Model-region error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// WHATSAPP / N8N QUERY HELPERS
// ============================================
const MONTH_NAMES_TR = ['Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran', 'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik'];
const BRAND_ALIAS_MAP = {
    'tumosan': ['tumosan'],
    'basak': ['basak'],
    'new-holland': ['new holland', 'newholland'],
    'case-ih': ['case ih', 'caseih'],
    'john-deere': ['john deere', 'johndeere'],
    'massey-ferguson': ['massey ferguson', 'masseyferguson'],
    'deutz-fahr': ['deutz fahr', 'deutzfahr'],
    'antonio-carraro': ['antonio carraro', 'antoniocarraro'],
    'ferrari-tractors': ['ferrari traktor', 'ferrari tractor']
};
const BRAND_SQL_ALIAS_MAP = {
    'tumosan': ['TUMOSAN', 'TÜMOSAN'],
    'basak': ['BASAK', 'BAŞAK'],
    'karatas': ['KARATAS', 'KARATAŞ'],
    'kioti': ['KIOTI', 'KİOTİ'],
    'new-holland': ['NEW HOLLAND'],
    'john-deere': ['JOHN DEERE'],
    'massey-ferguson': ['MASSEY FERGUSON'],
    'antonio-carraro': ['ANTONIO CARRARO'],
    'case': ['CASE', 'CASE IH'],
    'deutz': ['DEUTZ', 'DEUTZ-FAHR']
};

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchText(value = '') {
    return value
        .toString()
        .toLowerCase()
        .replace(/[\u0131\u0069\u0307]/g, 'i')
        .replace(/\u00f6/g, 'o')
        .replace(/\u00fc/g, 'u')
        .replace(/\u015f/g, 's')
        .replace(/\u011f/g, 'g')
        .replace(/\u00e7/g, 'c')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function formatNumberTR(value) {
    return new Intl.NumberFormat('tr-TR').format(Number(value || 0));
}

function formatShare(value) {
    return Number(value || 0).toFixed(1).replace('.', ',');
}

function formatPeriodLabel(year, monthCount, latestYear, latestMonth) {
    if (year === latestYear && latestMonth < 12) {
        return `${year} (${MONTH_NAMES_TR[0]}-${MONTH_NAMES_TR[latestMonth - 1]} dönemi)`;
    }
    if (monthCount > 0 && monthCount < 12) {
        return `${year} (${monthCount} ay kayıtlı)`;
    }
    return `${year}`;
}

function parsePortalJson(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }
    return fallback;
}

const TURKISH_SERVER_COPY_REPLACEMENTS = [
    [/\bPazara gore\b/g, 'Pazara göre'],
    [/\bpazara gore\b/g, 'pazara göre'],
    [/\bPazar payi\b/g, 'Pazar payı'],
    [/\bpazar payi\b/g, 'pazar payı'],
    [/\bportfoyunu\b/g, 'portföyünü'],
    [/\bportfoyundeki\b/g, 'portföyündeki'],
    [/\bPortfoy\b/g, 'Portföy'],
    [/\bportfoy\b/g, 'portföy'],
    [/\bDagilim\b/g, 'Dağılım'],
    [/\bdagilim\b/g, 'dağılım'],
    [/\bSiralama\b/g, 'Sıralama'],
    [/\bsira\b/g, 'sıra'],
    [/\bSira\b/g, 'Sıra'],
    [/\bSektor\b/g, 'Sektör'],
    [/\bsektor\b/g, 'sektör'],
    [/\bBolgesel\b/g, 'Bölgesel'],
    [/\bbolgesel\b/g, 'bölgesel'],
    [/\bGuncel\b/g, 'Güncel'],
    [/\bguncel\b/g, 'güncel'],
    [/\bGecmis\b/g, 'Geçmiş'],
    [/\bgecmis\b/g, 'geçmiş'],
    [/\bKarsilastirma\b/g, 'Karşılaştırma'],
    [/\bkarsilastirma\b/g, 'karşılaştırma'],
    [/\bCanli\b/g, 'Canlı'],
    [/\bcanli\b/g, 'canlı'],
    [/\bakislarini\b/g, 'akışlarını'],
    [/\bakislar\b/g, 'akışlar'],
    [/\bakisi\b/g, 'akışı'],
    [/\bAkisi\b/g, 'Akışı'],
    [/\bbaglantilari\b/g, 'bağlantıları'],
    [/\bBaglantilari\b/g, 'Bağlantıları'],
    [/\bbaglantilar\b/g, 'bağlantılar'],
    [/\bBaglantilar\b/g, 'Bağlantılar'],
    [/\bbaglantisi\b/g, 'bağlantısı'],
    [/\bbaglanti\b/g, 'bağlantı'],
    [/\bbaglanir\b/g, 'bağlanır'],
    [/\bbaglam\b/g, 'bağlam'],
    [/\bbagli\b/g, 'bağlı'],
    [/\bbirlesimi\b/g, 'birleşimi'],
    [/\bbirlestirildi\b/g, 'birleştirildi'],
    [/\bbirlestiren\b/g, 'birleştiren'],
    [/\bbulusturan\b/g, 'buluşturan'],
    [/\bbulusturur\b/g, 'buluşturur'],
    [/\bzenginlestirilir\b/g, 'zenginleştirilir'],
    [/\bgoreli\b/g, 'göreli'],
    [/\bgore\b/g, 'göre'],
    [/\bsaglam\b/g, 'sağlam'],
    [/\bkaldi\b/g, 'kaldı'],
    [/\bayni\b/g, 'aynı'],
    [/\bAyni\b/g, 'Aynı'],
    [/\bdonemde\b/g, 'dönemde'],
    [/\bdoneme\b/g, 'döneme'],
    [/\bdonemi\b/g, 'dönemi'],
    [/\bdonem\b/g, 'dönem'],
    [/\byukari\b/g, 'yukarı'],
    [/\bdondu\b/g, 'döndü'],
    [/\bgucu\b/g, 'gücü'],
    [/\bguc\b/g, 'güç'],
    [/\bguclu\b/g, 'güçlü'],
    [/\bBahce\b/g, 'Bahçe'],
    [/\bbahce\b/g, 'bahçe'],
    [/\bayagi\b/g, 'ayağı'],
    [/\bolusturuyor\b/g, 'oluşturuyor'],
    [/\bolusturan\b/g, 'oluşturan'],
    [/\bsikismayan\b/g, 'sıkışmayan'],
    [/\byaygin\b/g, 'yaygın'],
    [/\bYaygin\b/g, 'Yaygın'],
    [/\bmarkanin\b/g, 'markanın'],
    [/\bMarkanin\b/g, 'Markanın'],
    [/\bis birligi\b/g, 'iş birliği'],
    [/\bIs birligi\b/g, 'İş birliği'],
    [/\baksini\b/g, 'aksını'],
    [/\buretiyor\b/g, 'üretiyor'],
    [/\buretir\b/g, 'üretir'],
    [/\bureten\b/g, 'üreten'],
    [/\buretim\b/g, 'üretim'],
    [/\bUretim\b/g, 'Üretim'],
    [/\burunleri\b/g, 'ürünleri'],
    [/\bUrunleri\b/g, 'Ürünleri'],
    [/\burunler\b/g, 'ürünler'],
    [/\burun\b/g, 'ürün'],
    [/\bUrun\b/g, 'Ürün'],
    [/\bozel\b/g, 'özel'],
    [/\bOzel\b/g, 'Özel'],
    [/\bone cikiyor\b/g, 'öne çıkıyor'],
    [/\bone cikti\b/g, 'öne çıktı'],
    [/\bone cikariyor\b/g, 'öne çıkarıyor'],
    [/\bone cikarir\b/g, 'öne çıkarır'],
    [/\bone cikar\b/g, 'öne çıkar'],
    [/\boncesi\b/g, 'öncesi'],
    [/\bonceki\b/g, 'önceki'],
    [/\bsonrasi\b/g, 'sonrası'],
    [/\bGiris\b/g, 'Giriş'],
    [/\bgiris\b/g, 'giriş'],
    [/\bzayif\b/g, 'zayıf'],
    [/\bicin\b/g, 'için'],
    [/\bIcin\b/g, 'İçin'],
    [/\bveritabani\b/g, 'veritabanı'],
    [/\bkaynaklari\b/g, 'kaynakları'],
    [/\bkaydi\b/g, 'kaydı'],
    [/\bkayit\b/g, 'kayıt'],
    [/\bguncellemeleri\b/g, 'güncellemeleri'],
    [/\bguncelleme\b/g, 'güncelleme'],
    [/\bGuncelleme\b/g, 'Güncelleme'],
    [/\bkatmanlari\b/g, 'katmanları'],
    [/\bkatmani\b/g, 'katmanı'],
    [/\bKatmani\b/g, 'Katmanı'],
    [/\btarafindaki\b/g, 'tarafındaki'],
    [/\btarafinda\b/g, 'tarafında'],
    [/\bcekis\b/g, 'çekiş'],
    [/\bdegisim\b/g, 'değişim'],
    [/\bdegisimlerini\b/g, 'değişimlerini'],
    [/\bgorunumu\b/g, 'görünümü'],
    [/\bgorunurlugunu\b/g, 'görünürlüğünü'],
    [/\bgorunur\b/g, 'görünür'],
    [/\bgorebilir\b/g, 'görebilir'],
    [/\bYonetim\b/g, 'Yönetim'],
    [/\byonetim\b/g, 'yönetim'],
    [/\bFirsat\b/g, 'Fırsat'],
    [/\bfirsat\b/g, 'fırsat'],
    [/\bIklim\b/g, 'İklim'],
    [/\bIl\b/g, 'İl'],
    [/\bSubat\b/g, 'Şubat'],
    [/\bMayis\b/g, 'Mayıs'],
    [/\bAgustos\b/g, 'Ağustos'],
    [/\bKasim\b/g, 'Kasım'],
    [/\bAralik\b/g, 'Aralık'],
    [/\bIstanbul\b/g, 'İstanbul'],
    [/\bTurkiye\b/g, 'Türkiye'],
    [/\bTUIK\b/g, 'TÜİK'],
    [/\bTUMOSAN\b/g, 'TÜMOSAN'],
    [/\bBASAK\b/g, 'BAŞAK'],
    [/\bTraktor\b/g, 'Traktör'],
    [/\btraktor\b/g, 'traktör'],
    [/\btarim\b/g, 'tarım'],
    [/\bTarim\b/g, 'Tarım'],
    [/\byillik\b/g, 'yıllık'],
    [/\bYillik\b/g, 'Yıllık'],
    [/\byil\b/g, 'yıl'],
    [/\bYil\b/g, 'Yıl'],
    [/\baylik\b/g, 'aylık'],
    [/\bAylik\b/g, 'Aylık'],
    [/\bagi\b/g, 'ağı'],
    [/\bAgi\b/g, 'Ağı'],
    [/\berisimi\b/g, 'erişimi'],
    [/\bErisimi\b/g, 'Erişimi'],
    [/\bkapali\b/g, 'kapalı'],
    [/\bgenis\b/g, 'geniş'],
    [/\bGenis\b/g, 'Geniş'],
    [/\bodakli\b/g, 'odaklı'],
    [/\bOdakli\b/g, 'Odaklı'],
    [/\bbazli\b/g, 'bazlı'],
    [/\bBazli\b/g, 'Bazlı'],
    [/\bsiniflari\b/g, 'sınıfları'],
    [/\btoplanmis\b/g, 'toplanmış'],
    [/\balani\b/g, 'alanı'],
    [/\baltyapisi\b/g, 'altyapısı'],
    [/\byapisi\b/g, 'yapısı'],
    [/\bcalisan\b/g, 'çalışan'],
    [/\bCikarilmis\b/g, 'Çıkarılmış'],
    [/\bKurulus\b/g, 'Kuruluş'],
    [/\bTarihce\b/g, 'Tarihçe'],
    [/\bOrtaklik\b/g, 'Ortaklık'],
    [/\bYatirimci\b/g, 'Yatırımcı'],
    [/\byatirimci\b/g, 'yatırımcı'],
    [/\bIletisim\b/g, 'İletişim'],
    [/\biletisim\b/g, 'iletişim'],
    [/\bUst\b/g, 'Üst'],
    [/\bust\b/g, 'üst'],
    [/\bBagimsiz\b/g, 'Bağımsız'],
    [/\bBaskani\b/g, 'Başkanı'],
    [/\bBaskan\b/g, 'Başkan'],
    [/\bBulent\b/g, 'Bülent'],
    [/\bAygun\b/g, 'Aygün'],
    [/\bIsmail\b/g, 'İsmail'],
    [/\bYUKSEK\b/g, 'YÜKSEK'],
    [/\bKazim\b/g, 'Kazım'],
    [/\bDiger\b/g, 'Diğer'],
    [/\bUyesi\b/g, 'Üyesi'],
    [/\buyesi\b/g, 'üyesi']
];

const TURKISH_DISPLAY_SKIP_KEYS = new Set([
    'id', 'brand_id', 'province_id', 'slug', 'brand_slug', 'db_slug',
    'url', 'entry_url', 'website_url', 'brand_website', 'dealer_locator_url',
    'price_list_url', 'portal_url', 'cta_url', 'source_url', 'photo_source_url',
    'logo_url', 'image_url', 'contact_email', 'email', 'phone', 'contact_phone',
    'whatsapp_url', 'handle', 'item_type', 'tone', 'source', 'key'
]);

function normalizeTurkishDisplayText(value = '') {
    let text = String(value ?? '');
    TURKISH_SERVER_COPY_REPLACEMENTS.forEach(([pattern, replacement]) => {
        text = text.replace(pattern, replacement);
    });
    return text;
}

function normalizeTurkishDisplayObject(value, key = '') {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        return TURKISH_DISPLAY_SKIP_KEYS.has(key) ? value : normalizeTurkishDisplayText(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => normalizeTurkishDisplayObject(item, key));
    }
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                normalizeTurkishDisplayObject(entryValue, entryKey)
            ])
        );
    }
    return value;
}

function normalizePortalArray(value) {
    const parsed = parsePortalJson(value, []);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

function roundMetric(value, digits = 1) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number(numeric.toFixed(digits));
}

function calculateYoY(currentValue, previousValue) {
    const current = Number(currentValue || 0);
    const previous = Number(previousValue || 0);
    if (!previous) return null;
    return Number((((current - previous) * 100) / previous).toFixed(1));
}

function getBrandSqlAliases(brand = {}) {
    const canonical = getCanonicalBrandPortalSlug(brand.slug || brand.name || '');
    const aliases = new Set();

    (BRAND_SQL_ALIAS_MAP[canonical] || []).forEach(alias => aliases.add(String(alias).toUpperCase()));
    if (brand.name) aliases.add(String(brand.name).toUpperCase());
    if (brand.db_slug) aliases.add(String(brand.db_slug).toUpperCase());

    return Array.from(aliases).filter(Boolean);
}

function normalizePortalSlug(value = '') {
    return normalizeSearchText(value).replace(/\s+/g, '-');
}

function getCanonicalBrandPortalSlug(value = '') {
    const normalized = normalizeSearchText(value);
    const canonicalMap = {
        'tumosan': 'tumosan',
        'basak': 'basak',
        'new holland': 'new-holland',
        'john deere': 'john-deere',
        'massey ferguson': 'massey-ferguson',
        'antonio carraro': 'antonio-carraro',
        'case': 'case',
        'deutz': 'deutz',
        'erkunt': 'erkunt',
        'hattat': 'hattat',
        'kubota': 'kubota',
        'landini': 'landini',
        'same': 'same',
        'solis': 'solis',
        'fendt': 'fendt',
        'valtra': 'valtra',
        'claas': 'claas',
        'fiat': 'fiat',
        'yanmar': 'yanmar',
        'ferrari': 'ferrari',
        'mccormick': 'mccormick',
        'kioti': 'kioti',
        'tafe': 'tafe',
        'karatas': 'karatas'
    };

    return canonicalMap[normalized] || normalizePortalSlug(value);
}

function getBrandPortalSlugCandidates(brandRow) {
    return Array.from(new Set([
        String(brandRow.brand_slug || brandRow.slug || ''),
        normalizePortalSlug(brandRow.brand_slug || brandRow.slug || ''),
        normalizePortalSlug(brandRow.brand_name || brandRow.name || ''),
        getCanonicalBrandPortalSlug(brandRow.brand_name || brandRow.name || '')
    ].filter(Boolean)));
}

function buildPortalProfile(brandRow, options = {}) {
    const modelCount = Number(options.modelCount || 0);
    const heroStats = normalizePortalArray(brandRow.hero_stats_json);
    const socialLinks = normalizePortalArray(brandRow.social_links_json);
    const productLines = normalizePortalArray(brandRow.product_lines_json);
    const focusRegions = normalizePortalArray(brandRow.focus_regions_json);
    const sourceNotes = normalizePortalArray(brandRow.source_notes_json);

    if (!heroStats.length) {
        if (modelCount > 0) {
            heroStats.push({ label: 'Aktif model', value: String(modelCount), note: 'Mevcut katalog' });
        }
        if (brandRow.country_of_origin) {
            heroStats.push({ label: 'Ulke', value: brandRow.country_of_origin, note: 'Marka kaydi' });
        }
        if (brandRow.parent_company) {
            heroStats.push({ label: 'Grup', value: brandRow.parent_company, note: 'Marka kaydi' });
        }
    }

    if (!socialLinks.length && (brandRow.website_url || brandRow.brand_website)) {
        socialLinks.push({
            platform: 'Website',
            handle: (brandRow.website_url || brandRow.brand_website || '').replace(/^https?:\/\//, ''),
            url: brandRow.website_url || brandRow.brand_website
        });
    }

    if (!productLines.length && modelCount > 0) {
        productLines.push({
            label: 'Model portfoyu',
            items: [`${modelCount} aktif model katalogdan geliyor`]
        });
    }

    if (!focusRegions.length && Array.isArray(options.topRegions) && options.topRegions.length > 0) {
        options.topRegions.slice(0, 4).forEach(regionItem => {
            focusRegions.push({
                region: regionItem.region_name,
                note: `${formatNumberTR(regionItem.total_sales)} adet ile son dönemde öne çıkıyor`
            });
        });
    }

    const websiteUrl = brandRow.website_url || brandRow.brand_website || '';

    return {
        tagline: brandRow.tagline || `${brandRow.brand_name} için özel marka deneyimi`,
        hero_title: brandRow.hero_title || `${brandRow.brand_name} Marka Merkezi`,
        hero_subtitle: brandRow.hero_subtitle || `${brandRow.brand_name} ekibi için marka, ürün ve saha bilgisini bir araya getiren yönetim katmanı.`,
        overview: brandRow.overview || brandRow.brand_description || `${brandRow.brand_name} markasına ait resmi bağlantılar, ürün portföyü ve saha sinyalleri bu alanda toplanır.`,
        website_url: websiteUrl,
        dealer_locator_url: brandRow.dealer_locator_url || '',
        price_list_url: brandRow.price_list_url || '',
        portal_url: brandRow.portal_url || '',
        contact_phone: brandRow.contact_phone || '',
        contact_email: brandRow.contact_email || '',
        whatsapp_url: brandRow.whatsapp_url || '',
        headquarters: brandRow.headquarters || '',
        hero_stats: heroStats.slice(0, 6),
        social_links: socialLinks.slice(0, 8),
        product_lines: productLines.slice(0, 6),
        focus_regions: focusRegions.slice(0, 6),
        source_notes: sourceNotes.slice(0, 8),
        updated_at: brandRow.portal_updated_at || null
    };
}

function buildPortalFallbackItems(brand, portalItems, showcaseModels, profile) {
    const normalizedItems = (portalItems || []).map(item => ({
        ...item,
        meta: parsePortalJson(item.meta_json, {})
    }));

    if (normalizedItems.length > 0) {
        return normalizedItems;
    }

    const fallbackItems = [];

    if (showcaseModels.length > 0) {
        const sampleNames = showcaseModels.slice(0, 3).map(model => model.model_name).join(', ');
        fallbackItems.push({
            item_type: 'product',
            title: `${brand.name} ürün vitrininde teknik odak`,
            summary: `${sampleNames} gibi güncel modeller katalogdan otomatik olarak öne çıkarılıyor.`,
            cta_label: 'Model listesi',
            cta_url: profile.website_url || '',
            published_at: null,
            priority: 10,
            is_featured: true,
            meta: { source: 'internal-model-catalog', tone: 'portfolio' }
        });
    }

    if (profile.dealer_locator_url) {
        fallbackItems.push({
            item_type: 'network',
            title: `${brand.name} bayi ve servis erişimi`,
            summary: 'Markanın resmi saha yapısı, dealer locator ve servis ağı bağlantıları üzerinden ulaşılabilir.',
            cta_label: 'Ağı aç',
            cta_url: profile.dealer_locator_url,
            published_at: null,
            priority: 20,
            is_featured: false,
            meta: { source: 'portal-profile', tone: 'network' }
        });
    }

    if (profile.website_url) {
        fallbackItems.push({
            item_type: 'corporate',
            title: `${brand.name} resmi dijital varlığı`,
            summary: 'Resmi site, ürün bağlantıları ve kurumsal kaynaklar login öncesi vitrine bağlanır.',
            cta_label: 'Resmi site',
            cta_url: profile.website_url,
            published_at: null,
            priority: 30,
            is_featured: false,
            meta: { source: 'portal-profile', tone: 'official' }
        });
    }

    return fallbackItems;
}

function buildPortalFallbackContacts(brand, portalContacts, profile) {
    if ((portalContacts || []).length > 0) {
        return portalContacts;
    }

    const fallbackContacts = [];

    if (profile.headquarters || profile.contact_phone || profile.contact_email) {
        fallbackContacts.push({
            contact_type: 'hq',
            label: `${brand.name} iletisim hatti`,
            city: '',
            title: 'Kurumsal temas noktasi',
            phone: profile.contact_phone || '',
            email: profile.contact_email || '',
            url: profile.website_url || '',
            sort_order: 1
        });
    }

    if (profile.dealer_locator_url) {
        fallbackContacts.push({
            contact_type: 'network',
            label: 'Bayi ve servis agi',
            city: 'Turkiye',
            title: 'Resmi saha erisimi',
            phone: profile.contact_phone || '',
            email: profile.contact_email || '',
            url: profile.dealer_locator_url,
            sort_order: 2
        });
    }

    return fallbackContacts;
}

async function getBrandPortalBase({ brandId = null, brandSlug = null } = {}) {
    const brandResult = await pool.query(`
        SELECT
            b.id AS brand_id,
            b.name AS brand_name,
            b.slug AS brand_slug,
            b.logo_url,
            b.primary_color,
            b.secondary_color,
            b.accent_color,
            b.text_color,
            b.country_of_origin,
            b.parent_company,
            b.website AS brand_website,
            b.description AS brand_description,
            p.tagline,
            p.hero_title,
            p.hero_subtitle,
            p.overview,
            p.website_url,
            p.dealer_locator_url,
            p.price_list_url,
            p.portal_url,
            p.contact_phone,
            p.contact_email,
            p.whatsapp_url,
            p.headquarters,
            p.hero_stats_json,
            p.social_links_json,
            p.product_lines_json,
            p.focus_regions_json,
            p.source_notes_json,
            p.updated_at AS portal_updated_at
        FROM brands b
        LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
        WHERE b.is_active = true
        ${brandId ? 'AND b.id = $1' : ''}
        ORDER BY b.name
    `, brandId ? [brandId] : []);

    if (brandResult.rows.length === 0) {
        return null;
    }

    let brandRow = null;
    if (brandId) {
        brandRow = brandResult.rows[0];
    } else {
        const requestedSlug = normalizePortalSlug(brandSlug);
        brandRow = brandResult.rows.find(row => getBrandPortalSlugCandidates(row).includes(requestedSlug)) || null;
    }

    if (!brandRow) {
        return null;
    }

    const brandIdInt = parseInt(brandRow.brand_id, 10);
    const canonicalSlug = getCanonicalBrandPortalSlug(brandRow.brand_name);

    const [itemsRes, contactsRes, showcaseModelsRes, catalogSummaryRes] = await Promise.all([
        pool.query(`
            SELECT item_type, title, summary, cta_label, cta_url, image_url, meta_json, published_at, priority, is_featured
            FROM brand_portal_items
            WHERE brand_id = $1 AND is_active = true
            ORDER BY is_featured DESC, priority ASC, COALESCE(published_at, created_at) DESC
            LIMIT 12
        `, [brandIdInt]),
        pool.query(`
            SELECT contact_type, label, region_name, city, contact_name, title, phone, email, url, sort_order
            FROM brand_portal_contacts
            WHERE brand_id = $1 AND is_active = true
            ORDER BY sort_order ASC, label ASC
        `, [brandIdInt]),
        pool.query(`
            SELECT model_name, horsepower, price_usd, category, drive_type, cabin_type, gear_config
            FROM tractor_models
            WHERE brand_id = $1 AND is_current_model = true
            ORDER BY horsepower DESC NULLS LAST, model_name ASC
            LIMIT 8
        `, [brandIdInt]),
        pool.query(`
            SELECT
                COUNT(*)::int AS model_count,
                ROUND(AVG(horsepower)::numeric, 1) AS avg_hp,
                MAX(horsepower) AS max_hp,
                MIN(price_usd) FILTER (WHERE price_usd IS NOT NULL AND price_usd > 0) AS min_price_usd,
                MAX(price_usd) FILTER (WHERE price_usd IS NOT NULL AND price_usd > 0) AS max_price_usd
            FROM tractor_models
            WHERE brand_id = $1 AND is_current_model = true
        `, [brandIdInt])
    ]);

    const catalogSummaryRow = catalogSummaryRes.rows[0] || {};
    const catalogSummary = {
        model_count: parseInt(catalogSummaryRow.model_count || 0, 10),
        avg_hp: roundMetric(catalogSummaryRow.avg_hp, 1),
        max_hp: roundMetric(catalogSummaryRow.max_hp, 1),
        min_price_usd: roundMetric(catalogSummaryRow.min_price_usd, 0),
        max_price_usd: roundMetric(catalogSummaryRow.max_price_usd, 0)
    };

    const brand = {
        id: brandIdInt,
        name: brandRow.brand_name,
        slug: canonicalSlug,
        db_slug: brandRow.brand_slug,
        logo_url: brandRow.logo_url,
        primary_color: brandRow.primary_color,
        secondary_color: brandRow.secondary_color,
        accent_color: brandRow.accent_color,
        text_color: brandRow.text_color,
        country_of_origin: brandRow.country_of_origin,
        parent_company: brandRow.parent_company
    };

    const profile = buildPortalProfile(brandRow, { modelCount: catalogSummary.model_count });
    const showcaseModels = showcaseModelsRes.rows.map(model => ({
        ...model,
        horsepower: roundMetric(model.horsepower, 1),
        price_usd: roundMetric(model.price_usd, 0)
    }));

    const items = buildPortalFallbackItems(brand, itemsRes.rows, showcaseModels, profile);
    const contacts = buildPortalFallbackContacts(brand, contactsRes.rows, profile);

    return {
        brand,
        profile,
        items,
        contacts,
        showcase_models: showcaseModels,
        catalog_summary: catalogSummary
    };
}

async function getLatestSalesPeriod() {
    const latestYearRes = await pool.query('SELECT MAX(year) AS max_year FROM sales_view');
    const maxYear = parseInt(latestYearRes.rows[0]?.max_year || 0, 10);
    if (!maxYear) {
        return { maxYear: null, maxMonth: null, prevYear: null };
    }

    const latestMonthRes = await pool.query('SELECT MAX(month) AS max_month FROM sales_view WHERE year = $1', [maxYear]);
    const maxMonth = parseInt(latestMonthRes.rows[0]?.max_month || 12, 10);

    return {
        maxYear,
        maxMonth,
        prevYear: maxYear - 1
    };
}

async function buildBrandExecutiveReport(brand, options = {}) {
    const canonicalSlug = getCanonicalBrandPortalSlug(brand?.slug || brand?.name || '');
    const curatedPortalSeed = require('./database/brand-portal-seed');
    const curatedReport = curatedPortalSeed?.[canonicalSlug]?.executive_report || {};
    const profile = options.profile || {};
    const portalItems = Array.isArray(options.items) ? options.items : [];
    const reportBrandName = brand?.name || 'Marka';

    const latestPeriod = {
        maxYear: parseInt(options.maxYear || 0, 10),
        maxMonth: parseInt(options.maxMonth || 0, 10),
        prevYear: parseInt(options.prevYear || 0, 10)
    };
    const resolvedPeriod = latestPeriod.maxYear && latestPeriod.maxMonth
        ? latestPeriod
        : await getLatestSalesPeriod();

    if (!resolvedPeriod.maxYear || !resolvedPeriod.maxMonth) {
        return {
            brand_slug: canonicalSlug,
            generated_at: new Date().toISOString(),
            latest_period: null,
            executive_kpis: [],
            storyline_cards: [],
            sales: null,
            portfolio: null,
            corporate: curatedReport.corporate || {},
            news: curatedReport.news || [],
            automation_roadmap: curatedReport.automation_roadmap || [
                {
                    title: `${reportBrandName} Pulse Agent`,
                    summary: 'Aylik TUIK tescil ritmini otomatik izler ve yonetime fark raporu uretir.',
                    owner: 'n8n + SQL'
                }
            ],
            source_links: curatedReport.source_links || profile.source_notes || [],
            freshness: []
        };
    }

    const maxYear = resolvedPeriod.maxYear;
    const maxMonth = resolvedPeriod.maxMonth;
    const prevYear = resolvedPeriod.prevYear || (maxYear - 1);
    const periodLabel = formatPeriodLabel(maxYear, maxMonth, maxYear, maxMonth);
    const brandAliases = getBrandSqlAliases(brand);

    const [
        currentSalesRes,
        previousSalesRes,
        currentMarketRes,
        previousMarketRes,
        rankingRes,
        yearlyBrandRes,
        yearlyMarketRes,
        monthlyBrandRes,
        monthlyMarketRes,
        currentProvinceRes,
        previousProvinceRes,
        currentRegionRes,
        previousRegionRes,
        categoryRes,
        cabinRes,
        driveRes,
        hpRes,
        gearRes,
        technicalSummaryRes,
        configurationSplitRes,
        topModelsRes,
        technicalMatrixRes
    ] = await Promise.all([
        pool.query(`
            SELECT
                COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales,
                COUNT(DISTINCT p.id)::int AS active_provinces
            FROM tuik_veri tv
            JOIN provinces p
                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
        `, [brandAliases, maxYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
            FROM tuik_veri tv
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
        `, [brandAliases, prevYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(SUM(satis_adet), 0)::int AS total_sales
            FROM tuik_veri
            WHERE tescil_yil = $1 AND tescil_ay <= $2
        `, [maxYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(SUM(satis_adet), 0)::int AS total_sales
            FROM tuik_veri
            WHERE tescil_yil = $1 AND tescil_ay <= $2
        `, [prevYear, maxMonth]),
        pool.query(`
            WITH ranked AS (
                SELECT
                    brand_id,
                    SUM(quantity)::int AS total_sales,
                    DENSE_RANK() OVER (ORDER BY SUM(quantity) DESC) AS ranking
                FROM sales_view
                WHERE year = $1 AND month <= $2
                GROUP BY brand_id
            )
            SELECT ranking, total_sales
            FROM ranked
            WHERE brand_id = $3
        `, [maxYear, maxMonth, brand.id]),
        pool.query(`
            SELECT year, SUM(quantity)::int AS brand_sales
            FROM sales_view
            WHERE brand_id = $1
            GROUP BY year
            ORDER BY year
        `, [brand.id]),
        pool.query(`
            SELECT year, SUM(quantity)::int AS market_sales
            FROM sales_view
            GROUP BY year
            ORDER BY year
        `),
        pool.query(`
            SELECT year, month, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year IN ($2, $3)
            GROUP BY year, month
            ORDER BY year, month
        `, [brand.id, prevYear, maxYear]),
        pool.query(`
            SELECT year, month, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE year IN ($1, $2)
            GROUP BY year, month
            ORDER BY year, month
        `, [prevYear, maxYear]),
        pool.query(`
            SELECT p.id AS province_id, p.name AS province_name, p.region, SUM(tv.satis_adet)::int AS total_sales
            FROM tuik_veri tv
            JOIN provinces p
                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
            GROUP BY p.id, p.name, p.region
            ORDER BY total_sales DESC, p.name ASC
        `, [brandAliases, maxYear, maxMonth]),
        pool.query(`
            SELECT p.id AS province_id, p.name AS province_name, p.region, SUM(tv.satis_adet)::int AS total_sales
            FROM tuik_veri tv
            JOIN provinces p
                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
            GROUP BY p.id, p.name, p.region
            ORDER BY total_sales DESC, p.name ASC
        `, [brandAliases, prevYear, maxMonth]),
        pool.query(`
            SELECT p.region AS region_name, SUM(tv.satis_adet)::int AS total_sales
            FROM tuik_veri tv
            JOIN provinces p
                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
            GROUP BY p.region
            ORDER BY total_sales DESC, p.region ASC
        `, [brandAliases, maxYear, maxMonth]),
        pool.query(`
            SELECT p.region AS region_name, SUM(tv.satis_adet)::int AS total_sales
            FROM tuik_veri tv
            JOIN provinces p
                ON p.plate_code = LPAD(COALESCE(tv.sehir_kodu, 0)::text, 2, '0')
            WHERE UPPER(tv.marka) = ANY($1::text[])
              AND tv.tescil_yil = $2
              AND tv.tescil_ay <= $3
            GROUP BY p.region
            ORDER BY total_sales DESC, p.region ASC
        `, [brandAliases, prevYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(category, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY category
            ORDER BY total_sales DESC, label ASC
        `, [brand.id, maxYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(cabin_type, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY cabin_type
            ORDER BY total_sales DESC, label ASC
        `, [brand.id, maxYear, maxMonth]),
        pool.query(`
            SELECT UPPER(COALESCE(drive_type, 'belirsiz')) AS label, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY drive_type
            ORDER BY total_sales DESC, label ASC
        `, [brand.id, maxYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(hp_range, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY hp_range
            ORDER BY total_sales DESC, label ASC
        `, [brand.id, maxYear, maxMonth]),
        pool.query(`
            SELECT COALESCE(gear_config, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY gear_config
            ORDER BY total_sales DESC, label ASC
        `, [brand.id, maxYear, maxMonth]),
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
                COALESCE(koruma, '-') AS protection,
                UPPER(COALESCE(cekis_tipi, '-')) AS drive_type,
                COUNT(*)::int AS model_count
            FROM teknik_veri
            WHERE UPPER(marka) = ANY($1::text[])
            GROUP BY COALESCE(koruma, '-'), UPPER(COALESCE(cekis_tipi, '-'))
            ORDER BY model_count DESC, protection ASC
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
            LIMIT 12
        `, [brandAliases, maxYear, maxMonth, brandAliases]),
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
            LIMIT 18
        `, [brandAliases])
    ]);

    const currentSalesRow = currentSalesRes.rows[0] || {};
    const technicalSummaryRow = technicalSummaryRes.rows[0] || {};
    const currentSales = parseInt(currentSalesRow.total_sales || 0, 10);
    const previousSales = parseInt(previousSalesRes.rows[0]?.total_sales || 0, 10);
    const currentMarket = parseInt(currentMarketRes.rows[0]?.total_sales || 0, 10);
    const previousMarket = parseInt(previousMarketRes.rows[0]?.total_sales || 0, 10);
    const activeProvinces = parseInt(currentSalesRow.active_provinces || 0, 10);
    const ranking = rankingRes.rows[0]?.ranking ? parseInt(rankingRes.rows[0].ranking, 10) : null;
    const currentShare = currentMarket ? roundMetric((currentSales * 100) / currentMarket, 2) : null;
    const previousShare = previousMarket ? roundMetric((previousSales * 100) / previousMarket, 2) : null;
    const shareDeltaPp = currentShare !== null && previousShare !== null ? roundMetric(currentShare - previousShare, 2) : null;
    const marketYoy = calculateYoY(currentMarket, previousMarket);
    const brandYoy = calculateYoY(currentSales, previousSales);
    const outperformancePp = marketYoy !== null && brandYoy !== null ? roundMetric(brandYoy - marketYoy, 1) : null;

    const marketYearlyMap = new Map(yearlyMarketRes.rows.map(row => [parseInt(row.year, 10), parseInt(row.market_sales, 10)]));
    const brandYearlyMap = new Map(yearlyBrandRes.rows.map(row => [parseInt(row.year, 10), parseInt(row.brand_sales, 10)]));
    const yearlyHistory = Array.from(marketYearlyMap.keys())
        .sort((a, b) => a - b)
        .slice(-5)
        .map(year => {
            const brandSales = brandYearlyMap.get(year) || 0;
            const marketSales = marketYearlyMap.get(year) || 0;
            return {
                year,
                brand_sales: brandSales,
                market_sales: marketSales,
                market_share_pct: marketSales ? roundMetric((brandSales * 100) / marketSales, 1) : null,
                yoy_pct: null,
                is_partial: year === maxYear
            };
        });

    yearlyHistory.forEach((item, index) => {
        if (index === 0) {
            item.yoy_pct = null;
            return;
        }
        item.yoy_pct = calculateYoY(item.brand_sales, yearlyHistory[index - 1].brand_sales);
    });

    const monthlyBrandMap = new Map(monthlyBrandRes.rows.map(row => [`${row.year}_${row.month}`, parseInt(row.total_sales, 10)]));
    const monthlyMarketMap = new Map(monthlyMarketRes.rows.map(row => [`${row.year}_${row.month}`, parseInt(row.total_sales, 10)]));
    const monthlyTrend = Array.from({ length: maxMonth }, (_, index) => {
        const month = index + 1;
        return {
            month,
            label: MONTH_NAMES_TR[index].slice(0, 3),
            current_sales: monthlyBrandMap.get(`${maxYear}_${month}`) || 0,
            previous_sales: monthlyBrandMap.get(`${prevYear}_${month}`) || 0,
            market_current_sales: monthlyMarketMap.get(`${maxYear}_${month}`) || 0,
            market_previous_sales: monthlyMarketMap.get(`${prevYear}_${month}`) || 0
        };
    });

    const previousProvinceMap = new Map(previousProvinceRes.rows.map(row => [parseInt(row.province_id, 10), parseInt(row.total_sales, 10)]));
    const topProvinces = currentProvinceRes.rows.map(row => {
        const provinceId = parseInt(row.province_id, 10);
        const totalSales = parseInt(row.total_sales, 10);
        const prevSales = previousProvinceMap.get(provinceId) || 0;
        return {
            province_id: provinceId,
            province_name: row.province_name,
            region: row.region,
            total_sales: totalSales,
            previous_sales: prevSales,
            share_pct: currentSales ? roundMetric((totalSales * 100) / currentSales, 1) : 0,
            yoy_pct: calculateYoY(totalSales, prevSales)
        };
    });

    const top3Qty = topProvinces.slice(0, 3).reduce((sum, item) => sum + item.total_sales, 0);
    const top10Qty = topProvinces.slice(0, 10).reduce((sum, item) => sum + item.total_sales, 0);
    const top3SharePct = currentSales ? roundMetric((top3Qty * 100) / currentSales, 1) : 0;
    const top10SharePct = currentSales ? roundMetric((top10Qty * 100) / currentSales, 1) : 0;

    const provinceMomentum = topProvinces
        .filter(item => item.total_sales >= 20)
        .sort((a, b) => (b.yoy_pct ?? -9999) - (a.yoy_pct ?? -9999));
    const provinceGainers = provinceMomentum.slice(0, 6);
    const provinceDecliners = topProvinces
        .filter(item => item.total_sales >= 20 && item.previous_sales >= 20)
        .sort((a, b) => (a.yoy_pct ?? 9999) - (b.yoy_pct ?? 9999))
        .slice(0, 6);

    const previousRegionMap = new Map(previousRegionRes.rows.map(row => [row.region_name, parseInt(row.total_sales, 10)]));
    const regionalMomentum = currentRegionRes.rows.map(row => {
        const currentTotal = parseInt(row.total_sales, 10);
        const previousTotal = previousRegionMap.get(row.region_name) || 0;
        return {
            region_name: row.region_name,
            current_sales: currentTotal,
            previous_sales: previousTotal,
            share_pct: currentSales ? roundMetric((currentTotal * 100) / currentSales, 1) : 0,
            yoy_pct: calculateYoY(currentTotal, previousTotal)
        };
    });

    const topRegionGrowth = regionalMomentum
        .filter(item => item.yoy_pct !== null)
        .sort((a, b) => b.yoy_pct - a.yoy_pct)[0] || null;
    const weakestRegionGrowth = regionalMomentum
        .filter(item => item.yoy_pct !== null)
        .sort((a, b) => a.yoy_pct - b.yoy_pct)[0] || null;

    const buildMixPayload = (rows) => rows.map(row => {
        const totalSales = parseInt(row.total_sales, 10);
        return {
            label: row.label,
            total_sales: totalSales,
            share_pct: currentSales ? roundMetric((totalSales * 100) / currentSales, 1) : 0
        };
    });

    const categoryMix = buildMixPayload(categoryRes.rows);
    const cabinMix = buildMixPayload(cabinRes.rows);
    const driveMix = buildMixPayload(driveRes.rows);
    const hpMix = buildMixPayload(hpRes.rows);
    const gearMix = buildMixPayload(gearRes.rows);

    const technicalModelCount = parseInt(technicalSummaryRow.technical_model_count || 0, 10);
    const technicalVariantCount = parseInt(technicalSummaryRow.variant_count || 0, 10);
    const technicalAvgHp = roundMetric(technicalSummaryRow.avg_hp, 1);
    const technicalAvgPrice = roundMetric(technicalSummaryRow.avg_price_usd, 0);
    const minPriceUsd = roundMetric(technicalSummaryRow.min_price_usd, 0);
    const maxPriceUsd = roundMetric(technicalSummaryRow.max_price_usd, 0);
    const pricePerHpUsd = technicalAvgPrice && technicalAvgHp ? roundMetric(technicalAvgPrice / technicalAvgHp, 0) : null;

    const configurationSplit = configurationSplitRes.rows.map(row => ({
        label: `${row.protection} ${row.drive_type}`.trim(),
        protection: row.protection,
        drive_type: row.drive_type,
        model_count: parseInt(row.model_count, 10)
    }));

    const topModels = topModelsRes.rows.map(row => ({
        model_name: row.model_name,
        total_sales: parseInt(row.total_sales, 10),
        share_pct: currentSales ? roundMetric((parseInt(row.total_sales, 10) * 100) / currentSales, 1) : 0,
        avg_hp: roundMetric(row.avg_hp, 1),
        min_price_usd: roundMetric(row.min_price_usd, 0),
        max_price_usd: roundMetric(row.max_price_usd, 0),
        drive_types: row.drive_types || [],
        protections: row.protections || [],
        gear_configs: row.gear_configs || [],
        emission_standard: row.emission_standard || ''
    }));

    const technicalMatrix = technicalMatrixRes.rows.map(row => ({
        model_name: row.model_name,
        avg_hp: roundMetric(row.avg_hp, 1),
        min_price_usd: roundMetric(row.min_price_usd, 0),
        max_price_usd: roundMetric(row.max_price_usd, 0),
        drive_types: row.drive_types || [],
        protections: row.protections || [],
        gear_configs: row.gear_configs || [],
        emission_standard: row.emission_standard || '',
        origin: row.origin || ''
    }));

    let resolvedTechnicalModelCount = technicalModelCount;
    let resolvedTechnicalVariantCount = technicalVariantCount;
    let resolvedTechnicalAvgHp = technicalAvgHp;
    let resolvedTechnicalAvgPrice = technicalAvgPrice;
    let resolvedMinPriceUsd = minPriceUsd;
    let resolvedMaxPriceUsd = maxPriceUsd;
    let resolvedPricePerHpUsd = pricePerHpUsd;
    let resolvedConfigurationSplit = configurationSplit;
    let resolvedTopModels = topModels;
    let resolvedTechnicalMatrix = technicalMatrix;

    if (!resolvedTechnicalModelCount) {
        const tractorModelFallbackRes = await pool.query(`
            SELECT
                model_name,
                horsepower,
                price_usd,
                category,
                cabin_type,
                drive_type,
                gear_config,
                price_list_tl
            FROM tractor_models
            WHERE brand_id = $1 AND is_current_model = true
            ORDER BY horsepower ASC NULLS LAST, model_name ASC
        `, [brand.id]);

        const fallbackModels = tractorModelFallbackRes.rows.map(row => ({
            model_name: row.model_name,
            avg_hp: roundMetric(row.horsepower, 1),
            min_price_usd: roundMetric(row.price_usd, 0),
            max_price_usd: roundMetric(row.price_usd, 0),
            drive_types: row.drive_type ? [String(row.drive_type).toUpperCase()] : [],
            protections: row.cabin_type ? [row.cabin_type] : [],
            gear_configs: row.gear_config ? [row.gear_config] : [],
            emission_standard: '',
            origin: brand.country_of_origin || ''
        }));

        const hpValues = fallbackModels.map(item => item.avg_hp).filter(Number.isFinite);
        const usdPrices = fallbackModels.flatMap(item => [item.min_price_usd]).filter(value => Number.isFinite(value) && value > 0);
        const fallbackPriceListTl = tractorModelFallbackRes.rows
            .map(row => row.price_list_tl == null ? null : Number(row.price_list_tl))
            .filter(value => Number.isFinite(value) && value > 0);

        resolvedTechnicalModelCount = fallbackModels.length;
        resolvedTechnicalVariantCount = fallbackModels.length;
        resolvedTechnicalAvgHp = hpValues.length ? roundMetric(hpValues.reduce((sum, value) => sum + value, 0) / hpValues.length, 1) : null;
        resolvedTechnicalAvgPrice = usdPrices.length ? roundMetric(usdPrices.reduce((sum, value) => sum + value, 0) / usdPrices.length, 0) : null;
        resolvedMinPriceUsd = usdPrices.length ? roundMetric(Math.min(...usdPrices), 0) : null;
        resolvedMaxPriceUsd = usdPrices.length ? roundMetric(Math.max(...usdPrices), 0) : null;
        resolvedPricePerHpUsd = resolvedTechnicalAvgPrice && resolvedTechnicalAvgHp
            ? roundMetric(resolvedTechnicalAvgPrice / resolvedTechnicalAvgHp, 0)
            : null;
        resolvedConfigurationSplit = Array.from(
            tractorModelFallbackRes.rows.reduce((map, row) => {
                const key = `${row.cabin_type || '-'}::${String(row.drive_type || '-').toUpperCase()}`;
                const existing = map.get(key) || {
                    label: `${row.cabin_type || '-'} ${String(row.drive_type || '-').toUpperCase()}`.trim(),
                    protection: row.cabin_type || '-',
                    drive_type: String(row.drive_type || '-').toUpperCase(),
                    model_count: 0
                };
                existing.model_count += 1;
                map.set(key, existing);
                return map;
            }, new Map()).values()
        ).sort((a, b) => b.model_count - a.model_count);
        resolvedTechnicalMatrix = fallbackModels;

        if (!resolvedTopModels.length) {
            resolvedTopModels = fallbackModels.slice(0, 12).map(item => ({
                model_name: item.model_name,
                total_sales: 0,
                share_pct: 0,
                avg_hp: item.avg_hp,
                min_price_usd: item.min_price_usd,
                max_price_usd: item.max_price_usd,
                drive_types: item.drive_types,
                protections: item.protections,
                gear_configs: item.gear_configs,
                emission_standard: item.emission_standard
            }));
        }

        if (!resolvedTechnicalAvgPrice && fallbackPriceListTl.length) {
            resolvedTechnicalAvgPrice = null;
        }
    }

    const topCategory = categoryMix[0] || null;
    const topDrive = driveMix[0] || null;
    const topHp = hpMix[0] || null;
    const shareCardValue = currentShare !== null ? `${currentShare}%` : '-';
    const shareCardNote = shareDeltaPp !== null
        ? `${shareDeltaPp > 0 ? '+' : ''}${shareDeltaPp} puan vs ${prevYear} aynı dönem`
        : 'Geçmiş dönem payı yok';

    const executiveKpis = [
        { label: 'Tescil hacmi', value: formatNumberTR(currentSales), note: `${maxYear} ilk ${maxMonth} ay` },
        { label: 'Pazar payı', value: shareCardValue, note: shareCardNote },
        { label: 'Sıralama', value: ranking ? `${ranking}. sıra` : '-', note: currentMarket ? `${formatNumberTR(currentMarket)} toplam pazar` : 'Pazar verisi yok' },
        { label: 'Pazara göre performans', value: outperformancePp !== null ? `${outperformancePp > 0 ? '+' : ''}${outperformancePp} puan` : '-', note: marketYoy !== null && brandYoy !== null ? `Pazar ${marketYoy > 0 ? '+' : ''}${marketYoy}% / ${reportBrandName} ${brandYoy > 0 ? '+' : ''}${brandYoy}%` : 'Karşılaştırma bekleniyor' },
        { label: 'Aktif il', value: formatNumberTR(activeProvinces), note: `Top 10 il payı ${top10SharePct}%` },
        { label: 'Teknik katalog', value: `${resolvedTechnicalModelCount} model`, note: `${resolvedTechnicalVariantCount} varyant / ${resolvedTechnicalAvgHp || '-'} HP ort.` }
    ];

    const storylineCards = [
        {
            eyebrow: 'Pazar direnci',
            title: 'Daralan pazarda göreli olarak daha sağlam kaldı',
            value: outperformancePp !== null ? `${outperformancePp > 0 ? '+' : ''}${outperformancePp} puan` : '-',
            note: marketYoy !== null && brandYoy !== null ? `Pazar ${marketYoy > 0 ? '+' : ''}${marketYoy}% daralırken marka ${brandYoy > 0 ? '+' : ''}${brandYoy}% hareket etti.` : 'Karşılaştırma için önceki dönem verisi bekleniyor.'
        },
        {
            eyebrow: 'Pay geri kazanımı',
            title: 'Tescil payı aynı dönemde yukarı döndü',
            value: shareCardValue,
            note: shareDeltaPp !== null ? `${prevYear} aynı döneme göre ${shareDeltaPp > 0 ? '+' : ''}${shareDeltaPp} puanlık hareket.` : 'Pay hareketi hesaplanamadı.'
        },
        {
            eyebrow: 'Portföy ekseni',
            title: 'Tarla gücü korunurken bahçe hacmi ikinci ayağı oluşturuyor',
            value: topCategory ? `${topCategory.share_pct}% ${topCategory.label}` : '-',
            note: `${topDrive ? `${topDrive.share_pct}% ${topDrive.label}` : '-'} çekiş profili, ${topHp ? `${topHp.label} lider segment` : 'HP profili bekleniyor'}.`
        },
        {
            eyebrow: 'Bölgesel denge',
            title: 'Dağılım tek ile sıkışmayan yaygın bir saha izi üretiyor',
            value: `Top 3 ${top3SharePct}%`,
            note: topRegionGrowth
                ? `${topRegionGrowth.region_name} ${topRegionGrowth.yoy_pct > 0 ? '+' : ''}${topRegionGrowth.yoy_pct}% ile öne çıkıyor${weakestRegionGrowth ? `, zayıf halka ${weakestRegionGrowth.region_name}` : ''}.`
                : 'Bölgesel momentum hesaplanamadı.'
        }
    ];

    const fallbackGovernance = [
        brand.country_of_origin ? { label: 'Menşei', value: brand.country_of_origin, note: 'Marka kaydı' } : null,
        brand.parent_company ? { label: 'Ana grup', value: brand.parent_company, note: 'Marka kaydı' } : null,
        currentShare !== null ? { label: 'Güncel pazar payı', value: `${currentShare}%`, note: `${periodLabel} TÜİK tescil verisi` } : null,
        ranking ? { label: 'Sektör sırası', value: `${ranking}. sıra`, note: `${maxYear} ilk ${maxMonth} ay` } : null
    ].filter(Boolean);

    const fallbackFacilities = (profile.hero_stats || []).map(item => ({
        title: item.label || '-',
        value: item.value || '-',
        note: item.note || ''
    }));

    const fallbackFootprint = [
        profile.headquarters ? { label: 'Merkez', value: profile.headquarters, note: 'Portal profili' } : null,
        ...((profile.focus_regions || []).slice(0, 4).map(item => ({
            label: item.region || '-',
            value: item.region || '-',
            note: item.note || ''
        })))
    ].filter(Boolean);

    const fallbackProductFocus = (profile.product_lines || []).map(item => ({
        title: item.label || '-',
        note: Array.isArray(item.items) ? item.items.join(', ') : ''
    }));

    const mergedCorporate = {
        governance: (curatedReport?.corporate?.governance?.length ? curatedReport.corporate.governance : fallbackGovernance),
        facilities: (curatedReport?.corporate?.facilities?.length ? curatedReport.corporate.facilities : fallbackFacilities),
        footprint: (curatedReport?.corporate?.footprint?.length ? curatedReport.corporate.footprint : fallbackFootprint),
        ownership: curatedReport?.corporate?.ownership || [],
        board: curatedReport?.corporate?.board || [],
        executive_team: curatedReport?.corporate?.executive_team || [],
        investor_contact: curatedReport?.corporate?.investor_contact || null,
        official_2025_snapshot: curatedReport?.corporate?.official_2025_snapshot || [],
        timeline: curatedReport?.corporate?.timeline || [],
        product_focus: curatedReport?.corporate?.product_focus?.length ? curatedReport.corporate.product_focus : fallbackProductFocus,
        export_watch: curatedReport?.corporate?.export_watch || []
    };

    const fallbackNews = portalItems
        .filter(item => ['news', 'network', 'product', 'corporate'].includes(item.item_type))
        .slice(0, 6)
        .map(item => ({
            date: item.published_at || null,
            title: item.title || '-',
            summary: item.summary || '',
            url: item.cta_url || ''
        }));

    const sourceLinks = (curatedReport.source_links && curatedReport.source_links.length > 0)
        ? curatedReport.source_links
        : (profile.source_notes || []);

    return {
        brand_slug: canonicalSlug,
        generated_at: new Date().toISOString(),
        hero_note: curatedReport.hero_note || `${reportBrandName} için TÜİK tescil verisi, teknik katalog ve mevcut kurumsal profil aynı executive katmanda birleştirildi.`,
        latest_period: {
            year: maxYear,
            month: maxMonth,
            label: periodLabel
        },
        freshness: [
            { label: 'TÜİK / veritabanı penceresi', value: `${maxYear} ilk ${maxMonth} ay`, note: 'Canlı tescil ve teknik veri birleşimi' },
            { label: 'Kurumsal kaynak katmanı', value: sourceLinks.length ? `${sourceLinks.length} kaynak` : 'Profil kaynakları', note: 'Marka merkezi resmi bağlantılar ile zenginleştirilir' }
        ],
        executive_kpis: executiveKpis,
        storyline_cards: storylineCards,
        sales: {
            current_sales: currentSales,
            previous_sales: previousSales,
            current_market_sales: currentMarket,
            previous_market_sales: previousMarket,
            market_share_pct: currentShare,
            previous_market_share_pct: previousShare,
            share_delta_pp: shareDeltaPp,
            rank: ranking,
            brand_yoy_pct: brandYoy,
            market_yoy_pct: marketYoy,
            outperformance_pp: outperformancePp,
            active_provinces: activeProvinces,
            top3_share_pct: top3SharePct,
            top10_share_pct: top10SharePct,
            top3_qty: top3Qty,
            top10_qty: top10Qty,
            yearly_history: yearlyHistory,
            monthly_trend: monthlyTrend,
            category_mix: categoryMix,
            cabin_mix: cabinMix,
            drive_mix: driveMix,
            hp_mix: hpMix,
            gear_mix: gearMix,
            top_provinces: topProvinces.slice(0, 10),
            province_gainers: provinceGainers,
            province_decliners: provinceDecliners,
            regional_momentum: regionalMomentum
        },
        portfolio: {
            technical_model_count: resolvedTechnicalModelCount,
            technical_variant_count: resolvedTechnicalVariantCount,
            avg_hp: resolvedTechnicalAvgHp,
            avg_price_usd: resolvedTechnicalAvgPrice,
            min_price_usd: resolvedMinPriceUsd,
            max_price_usd: resolvedMaxPriceUsd,
            price_per_hp_usd: resolvedPricePerHpUsd,
            configuration_split: resolvedConfigurationSplit,
            top_models: resolvedTopModels,
            technical_matrix: resolvedTechnicalMatrix
        },
        corporate: mergedCorporate,
        news: (curatedReport.news && curatedReport.news.length > 0) ? curatedReport.news : fallbackNews,
        automation_roadmap: (curatedReport.automation_roadmap && curatedReport.automation_roadmap.length > 0) ? curatedReport.automation_roadmap : [
            {
                title: `${reportBrandName} Pulse Agent`,
                summary: 'Aylık TÜİK raporunu alıp marka payı, il ivmesi ve model ritmini otomatik yorumlar.',
                owner: 'n8n + SQL'
            },
            {
                title: `${reportBrandName} Catalog Watch`,
                summary: 'Teknik katalog, fiyat ve yeni ürün değişimlerini fark raporu olarak toplar.',
                owner: 'n8n + crawler'
            }
        ],
        source_links: sourceLinks
    };
}

function buildBrandSearchTerms(brand) {
    const terms = new Set();
    const normalizedName = normalizeSearchText(brand.name);
    const normalizedSlug = normalizeSearchText(brand.slug);

    if (normalizedName) {
        terms.add(normalizedName);
        terms.add(normalizedName.replace(/\s+/g, ''));
    }
    if (normalizedSlug) {
        terms.add(normalizedSlug);
        terms.add(normalizedSlug.replace(/\s+/g, ''));
    }

    (BRAND_ALIAS_MAP[brand.slug] || []).forEach(alias => {
        const normalizedAlias = normalizeSearchText(alias);
        if (normalizedAlias) {
            terms.add(normalizedAlias);
            terms.add(normalizedAlias.replace(/\s+/g, ''));
        }
    });

    return Array.from(terms).filter(Boolean).sort((a, b) => b.length - a.length);
}

async function getBrandCatalog() {
    const result = await pool.query('SELECT id, name, slug FROM brands WHERE is_active = true ORDER BY name');
    return result.rows.map(row => ({
        ...row,
        searchTerms: buildBrandSearchTerms(row)
    }));
}

function findBrandsInQuestion(question, brands) {
    const normalizedQuestion = normalizeSearchText(question);
    const matches = [];

    for (const brand of brands) {
        let bestMatchIndex = -1;
        let bestTermLength = -1;

        for (const term of brand.searchTerms) {
            const regex = new RegExp(`(^|\\s)${escapeRegExp(term)}(?=\\s|$)`);
            const match = normalizedQuestion.match(regex);
            if (!match) continue;

            const matchIndex = match.index ?? normalizedQuestion.indexOf(term);
            if (matchIndex >= 0 && term.length > bestTermLength) {
                bestMatchIndex = matchIndex;
                bestTermLength = term.length;
            }
        }

        if (bestMatchIndex >= 0) {
            matches.push({ ...brand, matchIndex: bestMatchIndex, matchLength: bestTermLength });
        }
    }

    return matches
        .sort((a, b) => a.matchIndex - b.matchIndex || b.matchLength - a.matchLength)
        .filter((brand, index, arr) => arr.findIndex(item => item.id === brand.id) === index);
}

function extractYears(question) {
    const matches = question.match(/\b20\d{2}\b/g) || [];
    return matches
        .map(year => parseInt(year, 10))
        .filter((year, index, arr) => Number.isInteger(year) && arr.indexOf(year) === index);
}

function isComparisonQuestion(question, matchedBrands) {
    if (matchedBrands.length >= 2) return true;
    const normalizedQuestion = normalizeSearchText(question);
    return ['karsilastir', 'karsilastirma', 'kiyasla', 'kiyas', 'versus', 'vs'].some(keyword => normalizedQuestion.includes(keyword));
}

function buildUsageAnswer() {
    return 'Soruyu anlayamadım. Örnekler: "2024 yılında TÜMOSAN kaç traktör sattı?" veya "2023 yılı TÜMOSAN ile BAŞAK karşılaştır".';
}

async function callGroqJson(systemPrompt, userPrompt) {
    if (!MINIMAX_API_KEY) return null;

    let groqRes;
    try {
        groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MINIMAX_API_KEY}`
            },
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1,
                max_tokens: 500
            }),
            signal: AbortSignal.timeout(12000)
        });
    } catch (err) {
        console.error('Groq JSON fetch error:', err.message);
        return null;
    }

    if (!groqRes.ok) {
        const errBody = await groqRes.text();
        console.error('Groq JSON API error:', groqRes.status, errBody);
        return null;
    }

    const groqData = await groqRes.json();
    const content = groqData.choices?.[0]?.message?.content;
    if (!content) return null;

    try {
        return JSON.parse(content);
    } catch (err) {
        console.error('Groq JSON parse error:', err.message, content);
        return null;
    }
}

async function inferSalesQueryWithGroq(question, brands, latestPeriod) {
    if (!MINIMAX_API_KEY) return null;

    const brandList = brands.map(brand => ({
        name: brand.name,
        slug: brand.slug,
        aliases: brand.searchTerms.slice(0, 6)
    }));

    const systemPrompt = [
        'Sen Türkiye traktör sektörü satış sorularını yapılandıran bir yardımcı modelsin.',
        'Sadece JSON döndür.',
        'Desteklenen intentler:',
        '1. brand_year_total',
        '2. brand_year_compare',
        '3. market_overview',
        '4. unsupported',
        'brand_year_total için tek marka gerekir.',
        'brand_year_compare için iki marka gerekir.',
        'market_overview için marka gerekmez ve genel pazar, lider marka, top markalar, pazar özeti gibi soruları kapsar.',
        'Eğer yıl verilmemişse latest_year kullan.',
        'Yalnızca verilen marka listesindeki isimleri kullan.',
        'Belirsizlik varsa unsupported seç.'
    ].join(' ');

    const userPrompt = JSON.stringify({
        question,
        latest_year: latestPeriod?.year,
        latest_month: latestPeriod?.month,
        brands: brandList
    });

    const parsed = await callGroqJson(systemPrompt, userPrompt);
    if (!parsed || typeof parsed !== 'object') return null;

    const normalizedIntent = ['brand_year_total', 'brand_year_compare', 'market_overview', 'unsupported'].includes(parsed.intent)
        ? parsed.intent
        : 'unsupported';

    const year = Number.isInteger(parsed.year) ? parsed.year : latestPeriod?.year;
    const brandNames = Array.isArray(parsed.brand_names)
        ? parsed.brand_names.map(name => String(name || '').trim()).filter(Boolean)
        : [];

    const matchedBrands = brandNames
        .map(name => brands.find(brand => normalizeSearchText(brand.name) === normalizeSearchText(name) || normalizeSearchText(brand.slug) === normalizeSearchText(name)))
        .filter(Boolean);

    return {
        intent: normalizedIntent,
        year,
        brands: matchedBrands,
        raw: parsed
    };
}

async function getLatestSalesPeriod() {
    const latestYearRes = await pool.query('SELECT MAX(year) as max_year FROM sales_view');
    const latestYear = parseInt(latestYearRes.rows[0]?.max_year, 10);
    if (!latestYear) return null;

    const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_view WHERE year = $1', [latestYear]);
    const latestMonth = parseInt(latestMonthRes.rows[0]?.max_month, 10) || 0;
    return {
        year: latestYear,
        month: latestMonth,
        maxYear: latestYear,
        maxMonth: latestMonth,
        prevYear: latestYear - 1
    };
}

async function buildBrandYearTotalAnswer(brand, year, latestPeriod) {
    const [brandSalesRes, totalSalesRes, rankRes] = await Promise.all([
        pool.query(`
            SELECT COALESCE(SUM(quantity), 0) as total_sales, COUNT(DISTINCT month) as month_count
            FROM sales_view
            WHERE brand_id = $1 AND year = $2
        `, [brand.id, year]),
        pool.query(`
            SELECT COALESCE(SUM(quantity), 0) as total_sales
            FROM sales_view
            WHERE year = $1
        `, [year]),
        pool.query(`
            WITH yearly_sales AS (
                SELECT brand_id, SUM(quantity) as total_sales
                FROM sales_view
                WHERE year = $1
                GROUP BY brand_id
            )
            SELECT COALESCE(
                (SELECT rank FROM (
                    SELECT brand_id, DENSE_RANK() OVER (ORDER BY total_sales DESC) as rank
                    FROM yearly_sales
                ) ranked
                WHERE brand_id = $2),
                0
            ) as brand_rank
        `, [year, brand.id])
    ]);

    const brandSales = parseInt(brandSalesRes.rows[0]?.total_sales || 0, 10);
    const monthCount = parseInt(brandSalesRes.rows[0]?.month_count || 0, 10);
    const totalMarketSales = parseInt(totalSalesRes.rows[0]?.total_sales || 0, 10);
    const brandRank = parseInt(rankRes.rows[0]?.brand_rank || 0, 10);

    if (brandSales === 0) {
        return {
            ok: false,
            intent: 'brand_year_total',
            answer: `${year} için ${brand.name} markasına ait satış kaydı bulunamadı.`,
            data: { brand: brand.name, year, total_sales: 0 }
        };
    }

    const share = totalMarketSales > 0 ? (brandSales * 100) / totalMarketSales : 0;
    const periodLabel = formatPeriodLabel(year, monthCount, latestPeriod?.year, latestPeriod?.month);
    const rankText = brandRank > 0 ? ` Yıl sıralamasında ${brandRank}. sırada.` : '';

    return {
        ok: true,
        intent: 'brand_year_total',
        answer: `${periodLabel} için ${brand.name} toplam ${formatNumberTR(brandSales)} traktör sattı. Pazar payı %${formatShare(share)}.${rankText}`,
        data: {
            brand: brand.name,
            year,
            total_sales: brandSales,
            month_count: monthCount,
            total_market_sales: totalMarketSales,
            market_share_pct: Number(share.toFixed(2)),
            brand_rank: brandRank
        }
    };
}

async function buildBrandComparisonAnswer(brands, year, latestPeriod) {
    const brandIds = brands.map(brand => brand.id);
    const [salesRes, totalSalesRes] = await Promise.all([
        pool.query(`
            SELECT b.id, b.name, COALESCE(SUM(s.quantity), 0) as total_sales, COUNT(DISTINCT s.month) as month_count
            FROM brands b
            LEFT JOIN sales_data s ON s.brand_id = b.id AND s.year = $1
            WHERE b.id = ANY($2::int[])
            GROUP BY b.id, b.name
        `, [year, brandIds]),
        pool.query('SELECT COALESCE(SUM(quantity), 0) as total_sales FROM sales_view WHERE year = $1', [year])
    ]);

    const totalMarketSales = parseInt(totalSalesRes.rows[0]?.total_sales || 0, 10);
    const salesMap = new Map(
        salesRes.rows.map(row => [
            row.id,
            {
                id: row.id,
                name: row.name,
                total_sales: parseInt(row.total_sales || 0, 10),
                month_count: parseInt(row.month_count || 0, 10)
            }
        ])
    );

    const orderedResults = brands.map(brand => salesMap.get(brand.id) || {
        id: brand.id,
        name: brand.name,
        total_sales: 0,
        month_count: 0
    });

    if (orderedResults.every(result => result.total_sales === 0)) {
        return {
            ok: false,
            intent: 'brand_year_compare',
            answer: `${year} icin secilen markalara ait satis kaydi bulunamadi.`,
            data: { year, brands: orderedResults }
        };
    }

    const [first, second] = orderedResults;
    const leader = first.total_sales >= second.total_sales ? first : second;
    const lagger = leader.id === first.id ? second : first;
    const difference = Math.abs(first.total_sales - second.total_sales);
    const leaderShare = totalMarketSales > 0 ? (leader.total_sales * 100) / totalMarketSales : 0;
    const firstShare = totalMarketSales > 0 ? (first.total_sales * 100) / totalMarketSales : 0;
    const secondShare = totalMarketSales > 0 ? (second.total_sales * 100) / totalMarketSales : 0;
    const monthCount = Math.max(first.month_count, second.month_count);
    const periodLabel = formatPeriodLabel(year, monthCount, latestPeriod?.year, latestPeriod?.month);

    const answer = [
        `${periodLabel} icin karsilastirma: ${first.name} ${formatNumberTR(first.total_sales)} adet, ${second.name} ${formatNumberTR(second.total_sales)} adet satti.`,
        `${leader.name}, ${lagger.name}'i ${formatNumberTR(difference)} adet farkla gecti.`,
        `Pazar paylari: ${first.name} %${formatShare(firstShare)}, ${second.name} %${formatShare(secondShare)}. Lider markanin payi %${formatShare(leaderShare)}.`
    ].join(' ');

    return {
        ok: true,
        intent: 'brand_year_compare',
        answer,
        data: {
            year,
            total_market_sales: totalMarketSales,
            leader: leader.name,
            difference,
            brands: orderedResults.map(result => ({
                ...result,
                market_share_pct: totalMarketSales > 0 ? Number(((result.total_sales * 100) / totalMarketSales).toFixed(2)) : 0
            }))
        }
    };
}

// ============================================
// TEXT-TO-SQL AI ENGINE (Esnek Sorgulama)
// ============================================
const DB_SCHEMA_PROMPT = `
Sen Türkiye traktör sektörü veritabanı uzmanısın. PostgreSQL sorguları yazarsın.
SADECE SELECT sorguları yaz. INSERT/UPDATE/DELETE/DROP/ALTER YASAK.

VERİTABANI ŞEMASI:
-- tuik_veri: MODEL BAZLI SATIŞ VERİSİ (en detaylı satış tablosu)
-- Sütunlar: marka VARCHAR, tuik_model_adi VARCHAR, tescil_yil INT, tescil_ay INT,
--   sehir_kodu INT, sehir_adi VARCHAR, model_yili INT, satis_adet INT
--   ÖNEMLİ: "En çok satan model", "model sıralaması", "hangi model" gibi sorularda DAİMA bu tabloyu kullan!
--   sehir_adi: Türkçe il adı (Konya, İstanbul, Ankara vb.)
--   marka: BÜYÜK HARF (NEW HOLLAND, MASSEY FERGUSON, TÜMOSAN vb.)
--   tuik_model_adi: TÜİK kaynak adı (eşleştirme anahtarı). Gerçek model adı için teknik_veri.model kullan.
--   Eşleştirme: tuik_veri LEFT JOIN teknik_veri ON marka + tuik_model_adi → teknik_veri.model = doğru model adı

-- sales_view: Aggregated satış verisi (model adı YOK, sadece segment bilgisi var)
-- Sütunlar: brand_id INT, province_id INT, year INT, month INT (1-12), quantity INT,
--   category VARCHAR (tarla/bahce), cabin_type VARCHAR (kabinli/rollbar),
--   drive_type VARCHAR (2WD/4WD), hp_range VARCHAR, gear_config VARCHAR, model_year INT
--   NOT: Model bazlı sorgularda sales_view KULLANMA, tuik_veri kullan!

-- brands: id SERIAL, name VARCHAR, slug VARCHAR, primary_color VARCHAR, country_of_origin VARCHAR, parent_company VARCHAR
-- provinces: id SERIAL, name VARCHAR, plate_code VARCHAR, region VARCHAR, latitude DECIMAL, longitude DECIMAL,
--   population INT, agricultural_area_hectare DECIMAL, primary_crops TEXT[], soil_type VARCHAR,
--   climate_zone VARCHAR, annual_rainfall_mm DECIMAL, avg_temperature DECIMAL
-- tractor_models: id SERIAL, brand_id INT (FK brands), model_name VARCHAR, horsepower DECIMAL,
--   price_usd DECIMAL (USD fiyat - teknik_veri.fiyat_usd kaynağından), category VARCHAR, cabin_type VARCHAR, drive_type VARCHAR, gear_config VARCHAR

-- teknik_veri: id SERIAL, marka VARCHAR, model VARCHAR, tuik_model_adi VARCHAR, fiyat_usd DECIMAL,
--   emisyon_seviyesi VARCHAR, cekis_tipi VARCHAR, koruma VARCHAR, vites_sayisi VARCHAR,
--   mensei VARCHAR, motor_marka VARCHAR, silindir_sayisi INT, motor_gucu_hp DECIMAL
--   NOT: Fiyat sorguları için teknik_veri.fiyat_usd kullan

HP SEGMENTLERI: '1-39','40-49','50-54','55-59','60-69','70-79','80-89','90-99','100-109','110-119','120+'
KATEGORİLER: 'tarla','bahce'
ÇEKIS: '2WD','4WD'
KABİN: 'kabinli','rollbar'
VİTES: '8+2','8+8','12+12','16+16','32+32','CVT'
BÖLGELER: 'Marmara','Ege','Akdeniz','İç Anadolu','Karadeniz','Doğu Anadolu','Güneydoğu Anadolu'

ÖRNEK SORGULAR:
-- Toplam satış: SELECT SUM(quantity) as toplam FROM sales_view
-- Yıllara göre satış: SELECT sv.year as yil, SUM(sv.quantity) as toplam FROM sales_view sv GROUP BY sv.year ORDER BY toplam DESC
-- En çok satılan yıl: SELECT sv.year as yil, SUM(sv.quantity) as toplam FROM sales_view sv GROUP BY sv.year ORDER BY toplam DESC LIMIT 1
-- Marka satışı: SELECT b.name, SUM(sv.quantity) as toplam FROM sales_view sv JOIN brands b ON sv.brand_id=b.id GROUP BY b.name ORDER BY toplam DESC
-- İl toplam satış: SELECT SUM(tv.satis_adet) as toplam FROM tuik_veri tv WHERE tv.sehir_adi ILIKE '%Van%'
-- İl + yıl: SELECT SUM(tv.satis_adet) as toplam FROM tuik_veri tv WHERE tv.sehir_adi ILIKE '%Van%' AND tv.tescil_yil = 2022
-- İl marka satışı: SELECT b.name, SUM(sv.quantity) as toplam FROM sales_view sv JOIN brands b ON sv.brand_id=b.id JOIN provinces p ON sv.province_id=p.id WHERE p.name ILIKE '%Konya%' GROUP BY b.name ORDER BY toplam DESC LIMIT 10
-- En çok satan model (il): SELECT tv.marka, COALESCE(tk.model, tv.tuik_model_adi) as model, SUM(tv.satis_adet) as toplam FROM tuik_veri tv LEFT JOIN teknik_veri tk ON UPPER(tv.marka) = UPPER(tk.marka) AND UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi) WHERE tv.sehir_adi ILIKE '%Konya%' GROUP BY tv.marka, COALESCE(tk.model, tv.tuik_model_adi) ORDER BY toplam DESC LIMIT 10
-- En çok satan model (genel): SELECT tv.marka, COALESCE(tk.model, tv.tuik_model_adi) as model, SUM(tv.satis_adet) as toplam FROM tuik_veri tv LEFT JOIN teknik_veri tk ON UPPER(tv.marka) = UPPER(tk.marka) AND UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi) GROUP BY tv.marka, COALESCE(tk.model, tv.tuik_model_adi) ORDER BY toplam DESC LIMIT 10
-- Teknik özellik: SELECT marka, model, motor_gucu_hp, cekis_tipi, koruma, vites_sayisi, fiyat_usd FROM teknik_veri WHERE UPPER(marka) = 'NEW HOLLAND' AND (UPPER(tuik_model_adi) ILIKE '%BOOMER%' OR UPPER(model) ILIKE '%BOOMER%')
-- Bahçe lider: SELECT b.name, SUM(sv.quantity) as toplam FROM sales_view sv JOIN brands b ON sv.brand_id=b.id WHERE sv.category='bahce' GROUP BY b.name ORDER BY toplam DESC LIMIT 5
-- İl toprak/iklim: SELECT p.name, p.soil_type, p.climate_zone, p.primary_crops FROM provinces p WHERE p.name ILIKE '%Kars%'

KURALLAR:
1. sales_view: marka ve segment bazlı satışlar (model adı YOK). tuik_veri: model bazlı satışlar
2. Marka ismi: BÜYÜK HARF (NEW HOLLAND, TÜMOSAN, BAŞAK vb.)
3. İl filtresi: ILIKE '%İlAdı%' kullan (hem tuik_veri.sehir_adi hem provinces.name)
4. Sonuçları LIMIT 20 ile sınırla
5. Yıl belirtilmemişse en son veri yılını kullan
6. "Ciro/gelir" → Subquery ile AVG(fiyat_usd). Doğrudan JOIN YAPMA
7. "kaç traktör satıldı" → SUM() ile toplam sayı döndür, model listesi DEĞİL
8. "en çok satılan yıl" → GROUP BY year ORDER BY toplam DESC LIMIT 1
9. Soruya tam uygun SQL yaz. "Toplam kaç adet" soruluyorsa SUM döndür, "hangi model" soruluyorsa model listesi döndür
10. SADECE geçerli SQL döndür, açıklama ekleme
`;

// Son Groq hata bilgisi (debug için)
let lastGroqError = null;

async function textToSql(question, conversationCtx) {
    lastGroqError = null;
    if (!MINIMAX_API_KEY) { lastGroqError = 'MINIMAX_API_KEY missing'; return null; }

    const latestPeriod = await getLatestSalesPeriod();
    const systemPrompt = DB_SCHEMA_PROMPT + `\nGüncel en son yıl: ${latestPeriod?.year || 2025}, en son ay: ${latestPeriod?.month || 5}`;

    const contextBlock = conversationCtx || '';

    const userPrompt = `Soru: "${question}"
${contextBlock}
TEK bir PostgreSQL SELECT sorgusu yaz.

- Traktör/tarım ile ilgili HER soruya SQL yaz. UNSUPPORTED sadece tamamen alakasız sorularda.
- "Kaç traktör/adet" → SUM() toplam döndür, model listesi DEĞİL
- "En çok satılan yıl" → GROUP BY year ORDER BY DESC
- "Model sıralaması/hangi model" → tuik_veri LEFT JOIN teknik_veri, COALESCE(tk.model, tv.tuik_model_adi) as model
- "Ciro/gelir" → Subquery AVG(fiyat_usd), doğrudan JOIN yapma
- "Bu model/onun/önceki" → Bağlamdan çöz
- İl filtresi: ILIKE '%İlAdı%'
- Sadece SQL döndür. Açıklama yazma.
- Alakasızsa: "UNSUPPORTED"`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let groqRes;
    try {
        groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
            signal: controller.signal,
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.05,
                max_tokens: 800
            })
        });
        clearTimeout(timeout);
    } catch (fetchErr) {
        clearTimeout(timeout);
        lastGroqError = fetchErr.name === 'AbortError' ? 'TIMEOUT (12s)' : `FETCH_ERROR: ${fetchErr.message}`;
        console.error(`❌ textToSql: ${lastGroqError}`);
        return null;
    }

    if (!groqRes.ok) {
        const errBody = await groqRes.text().catch(() => '');
        lastGroqError = `HTTP ${groqRes.status}: ${errBody.substring(0, 300)}`;
        console.error(`❌ textToSql Groq hata: ${lastGroqError}`);
        return null;
    }

    const data = await groqRes.json();
    let sql = data.choices?.[0]?.message?.content?.trim();
    console.log(`🤖 Groq SQL yanıtı: ${sql ? sql.substring(0, 100) : 'BOŞ/null'}`);
    if (!sql || sql === 'UNSUPPORTED') {
        lastGroqError = sql === 'UNSUPPORTED' ? 'UNSUPPORTED (Groq rejected)' : 'EMPTY_RESPONSE';
        return null;
    }

    // SQL temizleme - markdown code block varsa çıkar
    sql = sql.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    // Sadece ilk sorguyu al (birden fazla varsa)
    sql = sql.split(';')[0].trim();

    // Türkçe İ/ı güvenli hale getir: ILIKE '%CityName%' → translate() kalıbına çevir
    sql = fixTurkishIlike(sql);

    return sql;
}

// Groq'un ürettiği SQL'deki ILIKE il filtrelerini Türkçe-güvenli translate() ile değiştirir
function fixTurkishIlike(sql) {
    // sehir_adi ILIKE '%...%' veya p.name ILIKE '%...%' kalıplarını yakala
    return sql.replace(
        /([\w.]+)\s+ILIKE\s+'%([^%]+)%'/gi,
        (match, column, value) => {
            // Sadece şehir/il sütunlarında Türkçe fix uygula
            const col = column.toLowerCase();
            if (col.includes('sehir') || col.includes('name') || col.includes('il')) {
                // Değerde Türkçe karakter var mı veya İ/ı riski var mı kontrol et
                if (/[a-zA-ZçğıiöşüÇĞİÖŞÜ]/.test(value)) {
                    return `translate(UPPER(${column}), 'İıŞşÇçÜüÖöĞğ', 'IISsCcUuOoGg') LIKE translate(UPPER('%${value}%'), 'İıŞşÇçÜüÖöĞğ', 'IISsCcUuOoGg')`;
                }
            }
            return match; // Şehir sütunu değilse dokunma
        }
    );
}

async function textToSqlRetry(question, failedSql, errorMessage) {
    if (!MINIMAX_API_KEY) return null;

    const latestPeriod = await getLatestSalesPeriod();
    const systemPrompt = DB_SCHEMA_PROMPT + `\nGüncel en son yıl: ${latestPeriod?.year || 2025}, en son ay: ${latestPeriod?.month || 5}`;

    const userPrompt = `Kullanıcı sorusu: "${question}"

Önceki SQL sorgusu HATA verdi:
SQL: ${failedSql}
Hata: ${errorMessage}

Hatayı düzelt ve çalışan bir PostgreSQL SELECT sorgusu yaz.
- Division by zero hatası varsa NULLIF kullan
- Syntax hatası varsa SQL yapısını düzelt (SELECT, FROM, JOIN, WHERE, GROUP BY sırası)
- Timeout/performans hatası varsa sorguyu sadeleştir, gereksiz JOIN çıkar
- Ciro hesaplamada teknik_veri ile sales_view'i doğrudan JOIN YAPMA (kartezyen çarpım olur). Subquery kullan:
  SUM(sv.quantity) * (SELECT AVG(tv.fiyat_usd) FROM teknik_veri tv WHERE UPPER(tv.marka) = UPPER(b.name) AND tv.fiyat_usd > 0)
- Sadece SQL kodu döndür, açıklama ekleme.`;

    try {
        const groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.05,
                max_tokens: 800
            })
        });

        if (!groqRes.ok) return null;
        const data = await groqRes.json();
        let sql = data.choices?.[0]?.message?.content?.trim();
        if (!sql || sql === 'UNSUPPORTED') return null;

        sql = sql.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        sql = sql.split(';')[0].trim();
        if (!isSafeSql(sql)) return null;

        return sql;
    } catch (err) {
        console.error('Text-to-SQL retry error:', err.message);
        return null;
    }
}

function isSafeSql(sql) {
    const upper = sql.toUpperCase();
    const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY'];
    for (const keyword of dangerous) {
        // Check it's a standalone keyword, not part of a column name
        const regex = new RegExp(`(^|\\s|;)${keyword}(\\s|$|;)`, 'i');
        if (regex.test(upper)) return false;
    }
    if (!upper.trimStart().startsWith('SELECT')) return false;
    return true;
}

async function executeSafeSql(sql) {
    if (!isSafeSql(sql)) {
        return { error: 'Güvenlik: Sadece SELECT sorguları çalıştırılabilir.' };
    }

    // Division by zero koruması: NULLIF ile sıfıra bölmeyi önle
    sql = sql.replace(/\/\s*SUM\(([^)]+)\)/g, '/ NULLIF(SUM($1), 0)');
    sql = sql.replace(/\/\s*COUNT\(([^)]+)\)/g, '/ NULLIF(COUNT($1), 0)');

    // Timeout ile çalıştır (8 saniye - karmaşık sorgular için)
    try {
        const result = await Promise.race([
            pool.query(sql),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sorgu zaman asimi (8s)')), 8000))
        ]);
        return { rows: result.rows, rowCount: result.rowCount, fields: result.fields?.map(f => f.name) };
    } catch (err) {
        return { error: `SQL hatası: ${err.message}` };
    }
}

async function interpretResults(question, sql, result, conversationCtx) {
    if (!MINIMAX_API_KEY) return null;

    const dataPreview = JSON.stringify(result.rows.slice(0, 20), null, 0);
    const isSimpleQuestion = question.split(/\s+/).length <= 8 && !/karşılaştır|neden|analiz|strateji|tavsiye|yorum|değerlendir/i.test(question);
    const depthInstruction = isSimpleQuestion
        ? 'KISA CEVAP VER. Sadece sorulan veriyi net olarak sun. 2-4 satır yeterli. Ama sonunda her zaman proaktif öneri sun.'
        : 'DERİN ANALİZ YAP. Veriyi çok boyutlu yorumla, neden-sonuç ilişkisi kur, sektörel bağlam ekle, stratejik tavsiye ver.';

    const contextBlock = conversationCtx || '';

    const systemPrompt = `Sen, Türkiye Tarım Makinaları ve Traktör Sektörü üzerine uzmanlaşmış *Kıdemli Veri Analisti ve Tarım Stratejisti*sin. 20+ yıl sektör deneyimin var.

TEMEL FELSEFE: SIFIR ŞABLON POLİTİKASI
- Sabit "Pazar Bülteni" şablonları YASAK. Her cevap o soruya özel "terzi işi" yazılır.
- ${depthInstruction}

ÖLÇEKLENEBİLİR DERİNLİK:
- Basit soru ("kaç traktör satıldı?") → Sadece istenen veriyi ver, süslemeden. Örn: "2025 yılı toplam traktör satış adedi 18.914'tür."
- Karmaşık soru ("Karasal iklimde buğday yoğun illerde 4WD oranı?") → Coğrafi/tarımsal bağlam, neden-sonuç, stratejik yorum ekle.

PROAKTİF BİLGİ VE ÖNERİLER (ÇOK ÖNEMLİ):
- Cevabın sonunda MUTLAKA 1-2 satırlık proaktif öneri ekle.
- Satış verisi sorulduysa → "Bu modellerin teknik özelliklerini görmek ister misiniz?" veya "Bu ilin toprak ve iklim yapısına göre ideal traktör analizi yapabilirim."
- Teknik özellik sorulduysa → "Bu traktörün satış performansını görmek ister misiniz?" veya "Aynı HP segmentindeki rakiplerle karşılaştırma yapabilirim."
- İl/bölge sorulduysa → "Bu bölgenin iklim ve toprak yapısına göre en uygun traktör modelleri analizi yapabilirim."
- Proaktif önerilerde bölgenin toprak tipi, iklim kuşağı, ana ürünler, mera/orman/bitki örtüsü ile traktör teknik özellikleri arasındaki korelasyonu belirt.

BAĞLAM VE YORUMLAMA:
- Rakamları sadece listeleme, hikayeye dönüştür. "%32 düşüş" yerine "Pazarda %32'lik daralma, özellikle 50-60 HP segmentindeki küçük çiftçi yatırımlarının yavaşlamasından kaynaklanıyor"
- 4WD yüksekse → dağlık arazi, ağır toprak, pancar/patates bölgesi olabilir
- Bahçe traktörü yoğunsa → Ege, Akdeniz, narenciye/zeytin kuşağı
- Tarla traktörü yoğunsa → İç Anadolu, tahıl kuşağı
- HP segmenti büyükse → büyük işletme, kiralama, müteahhitlik

WHATSAPP FORMATLAMA:
- Vurgu: *kalın metin* kullan
- Listeler: tire (-) veya emoji (🚜 📊 📉 🌱) ile
- Çok emoji kullanma, ciddi ama modern kurumsal dil
- Sayılar: Türkçe format (1.234 ve %12,5)
- Paragraflar kısa, WhatsApp'ta okunabilir
- Çince, Japonca veya başka yabancı dilde karakter KULLANMA. Sadece Türkçe yaz.

HALÜSİNASYON ÖNLEYİCİ:
- Veritabanında olmayan kırılım sorulursa uydurma. "Bu kırılım veritabanında mevcut değil, ancak mevcut verilerle en yakın analiz şudur..." de.
- SADECE gelen SQL sonuç verisine dayanarak cevap ver, veri dışı rakam üretme.

DÖNEM BİLGİSİ (ÇOK ÖNEMLİ):
- Cevabında verilerin hangi döneme ait olduğunu MUTLAKA belirt.
- Veride min_yil/max_yil varsa kullan. Yoksa SQL'deki WHERE yil filtresinden çıkar.
- Yıl filtresi yoksa: "Tüm dönem verileri (2019-2025)" gibi belirt.
- Örnek: "2019-2025 yılları toplamında Erzincan'da en çok satan 10 traktör..." veya "2023 yılında İzmir'de..."`;

    const userPrompt = `Kullanıcı sorusu: "${question}"
${contextBlock}
Çalıştırılan SQL: ${sql}
Toplam satır sayısı: ${result.rowCount}
Dönen veri: ${dataPreview}

Bu veriye dayanarak soruya cevap ver. Sabit şablon kullanma, soruya özel cevap yaz.
Verilerin hangi döneme/yıl aralığına ait olduğunu MUTLAKA belirt (SQL'de yıl filtresi varsa o yılı, yoksa tüm dönem bilgisini).
Cevabın sonunda kullanıcıya yönlendirebileceğin proaktif öneriler ekle.`;

    // 15 saniye timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
            signal: controller.signal,
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.4,
                max_tokens: 1500
            })
        });

        clearTimeout(timeout);

        if (!groqRes.ok) {
            const errBody = await groqRes.text().catch(() => '');
            console.error(`❌ interpretResults Groq hata: ${groqRes.status} ${errBody.substring(0, 200)}`);
            // Rate limit ise kısa prompt ile tekrar dene
            if (groqRes.status === 429) {
                console.log('⏳ Rate limit, 2sn bekleyip kısa prompt ile retry...');
                await new Promise(r => setTimeout(r, 2000));
                return await interpretResultsShort(question, result);
            }
            return null;
        }

        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) {
            console.error('❌ interpretResults: Groq boş yanıt döndü');
            return null;
        }
        console.log(`✅ interpretResults başarılı (${content.length} karakter)`);
        return content;
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            console.error('❌ interpretResults: 15sn timeout aşıldı, kısa prompt ile retry...');
            return await interpretResultsShort(question, result);
        }
        console.error(`❌ interpretResults exception: ${err.message}`);
        return null;
    }
}

// Kısa/hızlı yorum fonksiyonu — interpretResults timeout/rate-limit olduğunda fallback
async function interpretResultsShort(question, result) {
    if (!MINIMAX_API_KEY) return null;
    const dataPreview = JSON.stringify(result.rows.slice(0, 10), null, 0);

    try {
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 10000);

        const res = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MINIMAX_API_KEY}` },
            signal: controller2.signal,
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: 'Türkiye traktör sektörü veri analisti. WhatsApp formatında kısa Türkçe cevap ver. *kalın* kullan. Verilerin dönemini belirt. Çince karakter KULLANMA.' },
                    { role: 'user', content: `Soru: "${question}"\nVeri (${result.rowCount} satır): ${dataPreview}\n\nBu veriyi kısa ve net yorumla. Sonunda 1 proaktif öneri ekle.` }
                ],
                temperature: 0.3,
                max_tokens: 800
            })
        });

        clearTimeout(timeout2);
        if (!res.ok) return null;
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content) console.log(`✅ interpretResultsShort başarılı (${content.length} karakter)`);
        return content || null;
    } catch (e) {
        console.error(`❌ interpretResultsShort exception: ${e.message}`);
        return null;
    }
}

// ═══ KISA SORGU GENİŞLETME (Intent Inheritance) ═══
// "erzincan", "trabzon'da" gibi kısa sorguları önceki sorgunun kalıbıyla genişletir
const TURKISH_CITIES = [
    'ADANA','ADIYAMAN','AFYON','AFYONKARAHISAR','AĞRI','AKSARAY','AMASYA','ANKARA','ANTALYA','ARDAHAN',
    'ARTVİN','AYDIN','BALIKESİR','BARTIN','BATMAN','BAYBURT','BİLECİK','BİNGÖL','BİTLİS','BOLU',
    'BURDUR','BURSA','ÇANAKKALE','ÇANKIRI','ÇORUM','DENİZLİ','DİYARBAKIR','DÜZCE','EDİRNE','ELAZIĞ',
    'ERZİNCAN','ERZURUM','ESKİŞEHİR','GAZİANTEP','GİRESUN','GÜMÜŞHANE','HAKKARİ','HATAY','IĞDIR',
    'ISPARTA','İSTANBUL','İZMİR','KAHRAMANMARAŞ','KARABÜK','KARAMAN','KARS','KASTAMONU','KAYSERİ',
    'KIRIKKALE','KIRKLARELİ','KIRŞEHİR','KİLİS','KOCAELİ','KONYA','KÜTAHYA','MALATYA','MANİSA',
    'MARDİN','MERSİN','MUĞLA','MUŞ','NEVŞEHİR','NİĞDE','ORDU','OSMANİYE','RİZE','SAKARYA',
    'SAMSUN','SİİRT','SİNOP','SİVAS','ŞANLIURFA','ŞIRNAK','TEKİRDAĞ','TOKAT','TRABZON','TUNCELİ',
    'UŞAK','VAN','YALOVA','YOZGAT','ZONGULDAK'
];

// Türkçe-güvenli normalize: tüm Türkçe karakterleri ASCII'ye düşür
// JS toUpperCase() Türkçe 'i' → 'I' yapar (İ değil), bu yüzden önce küçük harfleri temizle
const trNormalize = (s) => s
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/[''ʼ`']/g, '')
    .toUpperCase();

function detectCity(text) {
    const textNorm = trNormalize(text);

    // Şehirleri uzundan kısaya sırala (KAHRAMANMARAŞ > KARS gibi çakışmaları önle)
    const sortedCities = [...TURKISH_CITIES].sort((a, b) => b.length - a.length);

    for (const city of sortedCities) {
        const cityNorm = trNormalize(city);
        if (textNorm.includes(cityNorm)) {
            // Orijinal BÜYÜK HARF Türkçe formunu döndür (DB'deki format: ERZİNCAN, İZMİR)
            return city;
        }
    }
    return null;
}

// PostgreSQL'de Türkçe-güvenli şehir eşleştirme SQL parçası
// ILIKE Türkçe İ/i'yi eşleştiremez, bu yüzden translate() ile normalize ediyoruz
function cityMatchSql(columnName, cityName) {
    // cityName artık BÜYÜK HARF Türkçe: "ERZİNCAN", "İZMİR" vb.
    // translate ile hem DB'deki hem sorgu değerindeki Türkçe karakterleri ASCII'ye çevirip karşılaştır
    const safeCity = cityName.replace(/'/g, "''"); // SQL injection önleme
    return `translate(UPPER(${columnName}), 'İıŞşÇçÜüÖöĞğ', 'IISsCcUuOoGg') LIKE translate(UPPER('%${safeCity}%'), 'İıŞşÇçÜüÖöĞğ', 'IISsCcUuOoGg')`;
}

// ═══ AKILLI FALLBACK SQL ÜRETİCİ ═══
// Groq başarısız olduğunda (rate limit, timeout vb.) sorunun türüne göre uygun SQL üretir

// Marka adını sorudan tespit et
const BRAND_NAMES = ['NEW HOLLAND', 'JOHN DEERE', 'MASSEY FERGUSON', 'CASE', 'DEUTZ', 'TÜMOSAN', 'TUMOSAN',
    'BAŞAK', 'BASAK', 'ERKUNT', 'SAME', 'HATTAT', 'KUBOTA', 'FARMTRAC', 'VALTRA', 'CLAAS', 'KIOTI', 'KİOTİ',
    'SOLIS', 'ANTONIO CARRARO', 'MCCORMICK', 'FIAT', 'YANMAR', 'FERRARI', 'KARATAŞ', 'KARATAS', 'TAFE',
    'STEYR', 'FENDT', 'LANDINI', 'ZETOR', 'FOTON', 'LS TRACTOR', 'TYM'];

function detectBrands(text) {
    const upper = trNormalize(text);
    const found = [];
    for (const brand of BRAND_NAMES) {
        if (upper.includes(trNormalize(brand))) {
            // DB formatını al
            const dbMap = { 'TUMOSAN': 'TÜMOSAN', 'BASAK': 'BAŞAK', 'KARATAS': 'KARATAŞ', 'KIOTI': 'KİOTİ' };
            found.push(dbMap[brand] || brand);
        }
    }
    // Dedup
    return [...new Set(found)];
}

function buildSmartFallbackSql(question, latestPeriod) {
    const q = question.toLowerCase();
    const city = detectCity(question);
    const yearMatch = q.match(/(20\d{2})/);
    const yearFilter = yearMatch ? yearMatch[1] : null;
    const brands = detectBrands(question);

    // SQL parçaları
    const tvYearWhere = yearFilter ? `AND tv.tescil_yil = ${yearFilter}` : '';
    const svYearWhere = yearFilter ? `AND sv.year = ${yearFilter}` : '';
    const tvCityWhere = city ? `AND ${cityMatchSql('tv.sehir_adi', city)}` : '';
    const svCityWhere = city ? `AND ${cityMatchSql('p.name', city)}` : '';
    const needsProvinceJoin = !!city;
    const svBrandWhere = brands.length > 0 ? `AND UPPER(b.name) IN (${brands.map(b => `'${b}'`).join(',')})` : '';
    const tvBrandWhere = brands.length > 0 ? `AND UPPER(tv.marka) IN (${brands.map(b => `'${b}'`).join(',')})` : '';

    let limit = 10;
    const limitMatch = q.match(/(\d+)\s*(traktör|traktor|marka|model)/);
    if (limitMatch) limit = parseInt(limitMatch[1]);

    console.log(`🏗️ Smart fallback: city=${city || '-'}, year=${yearFilter || 'all'}, brands=${brands.join(',') || '-'}, q="${q.substring(0, 50)}"`);

    // ── PATTERN 1: Marka karşılaştırma ("X ile Y karşılaştır") ──
    if (brands.length >= 2 && /karşılaştır|kıyasla|karsilastir|kiyasla|fark|vs|ile/i.test(q)) {
        return `SELECT b.name as marka, sv.year as yil, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id
WHERE 1=1 ${svBrandWhere} ${svYearWhere}
GROUP BY b.name, sv.year ORDER BY sv.year DESC, toplam DESC`;
    }

    // ── PATTERN 2: "En çok satılan yıl" / "hangi yıl" ──
    if (/en çok.*(satıl|sat[ıi]lan|sat[ıi]ş).*y[ıi]l|hangi y[ıi]l|y[ıi]l.*(en çok|en fazla)|y[ıi]llara göre/i.test(q)) {
        const cityJoin = needsProvinceJoin ? 'JOIN provinces p ON sv.province_id = p.id' : '';
        return `SELECT sv.year as yil, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id ${cityJoin}
WHERE 1=1 ${svYearWhere} ${svCityWhere} ${svBrandWhere}
GROUP BY sv.year ORDER BY toplam DESC`;
    }

    // ── PATTERN 3: "Toplam kaç adet/traktör satıldı" ──
    if (/toplam.*kaç|kaç (adet|traktör|tane)|sadece.*toplam|toplam.*satış|kaç.*satıl/i.test(q)) {
        if (city) {
            return `SELECT SUM(tv.satis_adet) as toplam, MIN(tv.tescil_yil) as min_yil, MAX(tv.tescil_yil) as max_yil
FROM tuik_veri tv WHERE 1=1 ${tvCityWhere} ${tvYearWhere} ${tvBrandWhere}`;
        }
        return `SELECT SUM(sv.quantity) as toplam FROM sales_view sv
JOIN brands b ON sv.brand_id = b.id
WHERE 1=1 ${svYearWhere} ${svBrandWhere}`;
    }

    // ── PATTERN 4: Tek marka sorgusu ("New Holland satışları") ──
    if (brands.length === 1) {
        const brand = brands[0];
        if (/model|hangi model/i.test(q)) {
            // Modelleri listele
            return `SELECT tv.marka, COALESCE(tk.model, tv.tuik_model_adi) as model, SUM(tv.satis_adet) as toplam,
    MIN(tv.tescil_yil) as min_yil, MAX(tv.tescil_yil) as max_yil
FROM tuik_veri tv LEFT JOIN teknik_veri tk ON UPPER(tv.marka) = UPPER(tk.marka) AND UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi)
WHERE UPPER(tv.marka) = '${brand}' ${tvCityWhere} ${tvYearWhere}
GROUP BY tv.marka, COALESCE(tk.model, tv.tuik_model_adi) ORDER BY toplam DESC LIMIT ${limit}`;
        }
        if (/teknik|özellik|motor|hp|beygir|fiyat|spec/i.test(q)) {
            // Teknik özellikler
            return `SELECT marka, model, motor_gucu_hp, cekis_tipi, koruma, vites_sayisi, fiyat_usd, emisyon_seviyesi, mensei, motor_marka
FROM teknik_veri WHERE UPPER(marka) = '${brand}' ORDER BY motor_gucu_hp ASC LIMIT 20`;
        }
        // Genel marka satışları (yıllara göre)
        return `SELECT b.name as marka, sv.year as yil, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id
WHERE UPPER(b.name) = '${brand}' ${svYearWhere}
GROUP BY b.name, sv.year ORDER BY sv.year DESC`;
    }

    // ── PATTERN 5: "En çok satan marka" ──
    if (/en çok.*marka|lider marka|marka sıralama|hangi marka/i.test(q) && !/model/i.test(q)) {
        if (city) {
            return `SELECT tv.marka, SUM(tv.satis_adet) as toplam, MIN(tv.tescil_yil) as min_yil, MAX(tv.tescil_yil) as max_yil
FROM tuik_veri tv WHERE 1=1 ${tvCityWhere} ${tvYearWhere}
GROUP BY tv.marka ORDER BY toplam DESC LIMIT ${limit}`;
        }
        return `SELECT b.name as marka, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id
WHERE 1=1 ${svYearWhere}
GROUP BY b.name ORDER BY toplam DESC LIMIT ${limit}`;
    }

    // ── PATTERN 6: "En çok satan model" (il + model) ──
    if (/model|marka ve model|marka.*model|sıral/i.test(q) || (city && /traktör|traktor|satan|lider|en çok|en cok/i.test(q))) {
        return `SELECT tv.marka, COALESCE(tk.model, tv.tuik_model_adi) as model, SUM(tv.satis_adet) as toplam,
    MIN(tv.tescil_yil) as min_yil, MAX(tv.tescil_yil) as max_yil
FROM tuik_veri tv
LEFT JOIN teknik_veri tk ON UPPER(tv.marka) = UPPER(tk.marka) AND UPPER(tv.tuik_model_adi) = UPPER(tk.tuik_model_adi)
WHERE 1=1 ${tvCityWhere} ${tvYearWhere} ${tvBrandWhere}
GROUP BY tv.marka, COALESCE(tk.model, tv.tuik_model_adi)
ORDER BY toplam DESC LIMIT ${limit}`;
    }

    // ── PATTERN 7: HP / segment soruları ──
    if (/hp|beygir|segment|güç|guc/i.test(q)) {
        const cityJoin = needsProvinceJoin ? 'JOIN provinces p ON sv.province_id = p.id' : '';
        return `SELECT sv.hp_range, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id ${cityJoin}
WHERE 1=1 ${svYearWhere} ${svCityWhere} ${svBrandWhere}
GROUP BY sv.hp_range ORDER BY toplam DESC`;
    }

    // ── PATTERN 8: Kategori (bahçe/tarla) ──
    if (/bahçe|bahce|tarla|kategori/i.test(q)) {
        const cityJoin = needsProvinceJoin ? 'JOIN provinces p ON sv.province_id = p.id' : '';
        return `SELECT sv.category as kategori, b.name as marka, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id ${cityJoin}
WHERE 1=1 ${svYearWhere} ${svCityWhere} ${svBrandWhere}
GROUP BY sv.category, b.name ORDER BY toplam DESC LIMIT ${limit}`;
    }

    // ── PATTERN 9: 4WD/2WD soruları ──
    if (/4wd|2wd|çekiş|cekis|dört çeker|dort ceker/i.test(q)) {
        const cityJoin = needsProvinceJoin ? 'JOIN provinces p ON sv.province_id = p.id' : '';
        return `SELECT sv.drive_type as cekis, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id ${cityJoin}
WHERE 1=1 ${svYearWhere} ${svCityWhere} ${svBrandWhere}
GROUP BY sv.drive_type ORDER BY toplam DESC`;
    }

    // ── PATTERN 10: Bölge soruları ──
    if (/bölge|bolge|marmara|ege|akdeniz|karadeniz|anadolu|güneydoğu|doğu/i.test(q)) {
        const regionMatch = q.match(/(marmara|ege|akdeniz|karadeniz|iç anadolu|ic anadolu|doğu anadolu|dogu anadolu|güneydoğu|guneydogu)/i);
        const regionWhere = regionMatch ? `AND p.region ILIKE '%${regionMatch[1]}%'` : '';
        return `SELECT p.region as bolge, b.name as marka, SUM(sv.quantity) as toplam
FROM sales_view sv JOIN brands b ON sv.brand_id = b.id JOIN provinces p ON sv.province_id = p.id
WHERE 1=1 ${svYearWhere} ${regionWhere} ${svBrandWhere}
GROUP BY p.region, b.name ORDER BY toplam DESC LIMIT 20`;
    }

    // ── PATTERN 11: Teknik özellik soruları ──
    if (/teknik|özellik|ozellik|motor|spec|fiyat|emisyon/i.test(q)) {
        return `SELECT marka, model, motor_gucu_hp, cekis_tipi, koruma, vites_sayisi, fiyat_usd, emisyon_seviyesi, mensei
FROM teknik_veri ${tvBrandWhere ? 'WHERE 1=1 ' + tvBrandWhere : ''} ORDER BY marka, motor_gucu_hp LIMIT 20`;
    }

    // ── PATTERN 12: Genel traktör/satış sorusu ──
    if (/traktör|traktor|satış|satis|sat[ıi]l|pazar|piyasa|sektör|sektor/i.test(q)) {
        return `SELECT sv.year as yil, SUM(sv.quantity) as toplam
FROM sales_view sv WHERE 1=1 ${svYearWhere}
GROUP BY sv.year ORDER BY sv.year DESC`;
    }

    // ── PATTERN 13: Hiçbir kalıp uymadı ama traktörle ilgili olabilir ──
    // Son çare: yıllık genel satış özeti döndür
    return `SELECT sv.year as yil, SUM(sv.quantity) as toplam
FROM sales_view sv GROUP BY sv.year ORDER BY sv.year DESC`;
}

// Türkçe karakter varyasyonlarını tanıyan regex kalıbı üret
// "ERZİNCAN" → "[Ee][Rr][Zz][İiIı][Nn][Cc][Aa][Nn]" — her karakter formunu yakalar
function buildCityPattern(cityUpper) {
    const trVariants = {
        'İ': 'İiIı', 'I': 'İiIı', 'Ş': 'Şş', 'Ç': 'Çç',
        'Ü': 'Üü', 'Ö': 'Öö', 'Ğ': 'Ğğ'
    };
    let pattern = '';
    for (const ch of cityUpper) {
        const v = trVariants[ch];
        if (v) {
            pattern += `[${v}]`;
        } else {
            // Normal harf: büyük+küçük
            const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const lower = ch.toLowerCase();
            pattern += ch === lower ? esc : `[${esc}${lower}]`;
        }
    }
    return pattern;
}

// Proper case: ERZİNCAN → Erzincan, İZMİR → İzmir, KONYA → Konya
function cityProperCase(cityUpper) {
    if (!cityUpper) return cityUpper;
    // Karakter karakter: ilk harf büyük, geri kalan map ile küçült
    const trLower = { 'İ': 'i', 'I': 'ı', 'Ş': 'ş', 'Ç': 'ç', 'Ü': 'ü', 'Ö': 'ö', 'Ğ': 'ğ' };
    let result = cityUpper.charAt(0); // İlk harf büyük kalır
    for (let i = 1; i < cityUpper.length; i++) {
        const ch = cityUpper[i];
        result += trLower[ch] || ch.toLowerCase();
    }
    return result;
}

function expandShortQuery(question, history) {
    if (!history || history.length === 0) return question;

    const words = question.trim().split(/\s+/);
    if (words.length > 5) return question;

    const cityUpper = detectCity(question);
    if (!cityUpper) return question;
    const city = cityProperCase(cityUpper);

    // Geçmişteki son user mesajlarından bir kalıp bul
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role !== 'user') continue;
        const prevQ = history[i].content;
        if (prevQ.trim().split(/\s+/).length < 5) continue;

        const prevCityUpper = detectCity(prevQ);
        if (prevCityUpper) {
            // Önceki şehir adını tüm Türkçe varyasyonlarıyla yakala + 'da/'de eki
            const pattern = buildCityPattern(prevCityUpper);
            const cityRegex = new RegExp(pattern + `['ʼ\`'']*(?:da|de|'da|'de)?`, 'g');
            const expanded = prevQ.replace(cityRegex, city + "'da");
            console.log(`🔄 Sorgu genişletme: "${question}" → "${expanded}" (kalıp: "${prevQ}")`);
            return expanded;
        }

        if (/traktör|satış|sat[ıi]lan|marka|model|lider|en çok/i.test(prevQ)) {
            const expanded = `${city}'da ${prevQ}`;
            console.log(`🔄 Sorgu genişletme (şehir ekleme): "${question}" → "${expanded}"`);
            return expanded;
        }
    }

    const defaultExpanded = `${city}'da en çok satan 10 traktör marka ve modelini sırayla yaz`;
    console.log(`🔄 Sorgu genişletme (varsayılan): "${question}" → "${defaultExpanded}"`);
    return defaultExpanded;
}

// ═══ CİRO ÖZEL MOTORU ═══
// Groq'un kartezyen çarpım hatasını önlemek için ciro SQL'ini biz üretiyoruz
function buildCiroSql(question, history, latestPeriod) {
    const q = question.toLowerCase().replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g');

    // Ciro/gelir/satış tutarı anahtar kelimeleri — önce sorudan kontrol et
    let isCiro = /ciro|gelir|satis tutari|satis geliri|hasilat|revenue/i.test(q);

    // Soruda ciro yok ama bağlamda ciro varsa VE soru sadece marka adı gibi kısa bir metinse → niyet devralma
    if (!isCiro && history && history.length > 0) {
        const isShortQuery = question.trim().split(/\s+/).length <= 4; // "tümosan", "hattat cirosu", "new holland" gibi kısa sorular
        if (isShortQuery) {
            // Son 4 mesajda ciro niyeti var mı?
            for (let i = history.length - 1; i >= Math.max(0, history.length - 4); i--) {
                const msgNorm = history[i].content.toLowerCase().replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g');
                if (/ciro|gelir|satis tutari|hasilat|revenue/.test(msgNorm)) {
                    isCiro = true;
                    console.log(`💡 Bağlamdan ciro niyeti devralındı (mesaj #${i})`);
                    break;
                }
            }
        }
    }

    if (!isCiro) return null;

    // Marka adını bul (sorudan veya bağlamdan)
    const brandNames = ['NEW HOLLAND', 'JOHN DEERE', 'MASSEY FERGUSON', 'CASE', 'DEUTZ', 'TUMOSAN', 'TÜMOSAN',
        'BASAK', 'BAŞAK', 'ERKUNT', 'SAME', 'HATTAT', 'KUBOTA', 'FARMTRAC', 'VALTRA', 'CLAAS', 'KIOTI', 'KİOTİ',
        'SOLIS', 'ANTONIO CARRARO', 'MCCORMICK', 'FIAT', 'YANMAR', 'FERRARI', 'KARATAS', 'KARATAŞ', 'TAFE',
        'STEYR', 'FENDT', 'LANDINI', 'ZETOR', 'FOTON', 'LS TRACTOR', 'TUMOSAN', 'TYM'];

    let foundBrand = null;
    const questionUpper = question.toUpperCase();

    // Önce sorudan marka bul
    for (const brand of brandNames) {
        if (questionUpper.includes(brand)) {
            foundBrand = brand;
            break;
        }
    }
    // Normalize edilmiş versiyonla da dene
    if (!foundBrand) {
        const qNorm = q.toUpperCase();
        const normalizeMap = { 'TUMOSAN': 'TÜMOSAN', 'BASAK': 'BAŞAK', 'KARATAS': 'KARATAŞ', 'KIOTI': 'KİOTİ' };
        for (const brand of brandNames) {
            const brandNorm = brand.replace(/Ü/g, 'U').replace(/Ş/g, 'S').replace(/Ç/g, 'C').replace(/İ/g, 'I').replace(/Ö/g, 'O').replace(/Ğ/g, 'G');
            if (qNorm.includes(brandNorm)) {
                foundBrand = normalizeMap[brand] || brand;
                break;
            }
        }
    }

    // Bağlamdan marka bul (önceki soru/cevaplarda geçen marka)
    if (!foundBrand && history && history.length > 0) {
        for (let i = history.length - 1; i >= 0; i--) {
            const msg = history[i].content.toUpperCase();
            for (const brand of brandNames) {
                if (msg.includes(brand)) {
                    foundBrand = brand;
                    break;
                }
            }
            if (foundBrand) break;
        }
    }

    if (!foundBrand) return null;

    // Yıl bul (sorudan veya bağlamdan)
    let year = null;
    const yearMatch = question.match(/(20\d{2})/);
    if (yearMatch) {
        year = parseInt(yearMatch[1]);
    } else if (history && history.length > 0) {
        // Bağlamdan yıl bul
        for (let i = history.length - 1; i >= 0; i--) {
            const yMatch = history[i].content.match(/(20\d{2})/);
            if (yMatch) { year = parseInt(yMatch[1]); break; }
        }
    }
    if (!year) year = latestPeriod?.year || 2025;

    // DB'deki gerçek brand adını kullan (TUMOSAN → TÜMOSAN)
    const dbBrandMap = { 'TUMOSAN': 'TÜMOSAN', 'BASAK': 'BAŞAK', 'KARATAS': 'KARATAŞ', 'KIOTI': 'KİOTİ' };
    const dbBrand = dbBrandMap[foundBrand] || foundBrand;

    // teknik_veri'de marka adı brands'dan farklı olabilir (CASE IH vs CASE, DEUTZ-FAHR vs DEUTZ)
    // İki yönlü eşleştirme: hem dbBrand hem de olası alternatif isimler
    const teknikAltNames = {
        'CASE': ['CASE', 'CASE IH'],
        'DEUTZ': ['DEUTZ', 'DEUTZ-FAHR'],
        'KİOTİ': ['KİOTİ', 'KIOTI'],
        'TÜMOSAN': ['TÜMOSAN', 'TUMOSAN'],
        'BAŞAK': ['BAŞAK', 'BASAK']
    };
    const teknikNames = teknikAltNames[dbBrand.toUpperCase()] || [dbBrand.toUpperCase()];
    const teknikWhere = teknikNames.map(n => `UPPER(tv.marka) = '${n}'`).join(' OR ');

    console.log(`💰 Ciro motoru: marka=${dbBrand}, yıl=${year}, teknik_veri WHERE: ${teknikWhere}`);

    return `SELECT b.name as marka, ${year} as yil, SUM(sv.quantity) as adet,
        (SELECT AVG(tv.fiyat_usd) FROM teknik_veri tv WHERE (${teknikWhere}) AND tv.fiyat_usd IS NOT NULL AND tv.fiyat_usd > 0) as ortalama_fiyat_usd,
        SUM(sv.quantity) * (SELECT AVG(tv.fiyat_usd) FROM teknik_veri tv WHERE (${teknikWhere}) AND tv.fiyat_usd IS NOT NULL AND tv.fiyat_usd > 0) as tahmini_ciro_usd
    FROM sales_view sv
    JOIN brands b ON sv.brand_id = b.id
    WHERE UPPER(b.name) = '${dbBrand.toUpperCase()}' AND sv.year = ${year}
    GROUP BY b.name`;
}

// ═══ LOKAL YORUMLAMA MOTORU (Groq olmadan çalışır) ═══
// SQL sonuçlarını sorunun türüne göre WhatsApp-dostu narratif metne çevirir
function buildLocalInterpretation(question, result, latestPeriod) {
    if (!result.rows || result.rows.length === 0) return null;

    const rows = result.rows;
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const q = question.toLowerCase();
    const fmt = (n) => Number(n).toLocaleString('tr-TR');

    // Dönem bilgisi
    let period = '';
    if (firstRow.min_yil && firstRow.max_yil) {
        period = firstRow.min_yil === firstRow.max_yil
            ? `${firstRow.min_yil} yılı` : `${firstRow.min_yil}-${firstRow.max_yil} yılları toplamı`;
    } else if (firstRow.yil) {
        const years = [...new Set(rows.map(r => r.yil))].sort();
        period = years.length === 1 ? `${years[0]} yılı` : `${years[0]}-${years[years.length - 1]} yılları`;
    } else {
        period = `mevcut tüm veriler`;
    }

    // ── Tek satır, tek toplam (kaç adet satıldı?) ──
    if (rows.length === 1 && keys.includes('toplam') && !keys.includes('marka') && !keys.includes('model')) {
        const total = fmt(firstRow.toplam);
        const city = detectCity(question);
        const cityName = city ? cityProperCase(city) : null;
        const brands = detectBrands(question);
        let context = '';
        if (cityName) context += `*${cityName}*'da `;
        if (brands.length > 0) context += `*${brands.join(', ')}* markasında `;
        return `📊 ${context}${period} içinde toplam *${total} adet* traktör satışı gerçekleşmiştir.\n\n💡 Marka bazlı dağılımı veya model detaylarını sorabilirsiniz.`;
    }

    // ── Yıl bazlı satışlar ──
    if (keys.includes('yil') && keys.includes('toplam') && !keys.includes('marka') && !keys.includes('model')) {
        let answer = `📊 *Yıllara Göre Traktör Satışları*\n\n`;
        const maxRow = rows.reduce((a, b) => Number(a.toplam) > Number(b.toplam) ? a : b);
        rows.forEach(r => {
            const marker = r.yil == maxRow.yil ? ' 🏆' : '';
            answer += `📅 *${r.yil}:* ${fmt(r.toplam)} adet${marker}\n`;
        });
        answer += `\n🏆 En yüksek satış: *${maxRow.yil}* yılında *${fmt(maxRow.toplam)}* adet`;
        answer += `\n\n💡 Belirli bir yılın marka dağılımını veya il bazlı analizini sorabilirsiniz.`;
        return answer;
    }

    // ── Marka karşılaştırma (yıl bazlı) ──
    if (keys.includes('marka') && keys.includes('yil') && keys.includes('toplam') && rows.length > 2) {
        const brands = [...new Set(rows.map(r => r.marka))];
        let answer = `📊 *${brands.join(' vs ')} Karşılaştırma*\n\n`;
        for (const brand of brands) {
            const brandRows = rows.filter(r => r.marka === brand);
            const total = brandRows.reduce((s, r) => s + Number(r.toplam), 0);
            answer += `🚜 *${brand}* (Toplam: ${fmt(total)})\n`;
            brandRows.forEach(r => {
                answer += `   ${r.yil}: ${fmt(r.toplam)} adet\n`;
            });
            answer += `\n`;
        }
        // Toplam karşılaştırma
        const totals = brands.map(b => ({ brand: b, total: rows.filter(r => r.marka === b).reduce((s, r) => s + Number(r.toplam), 0) }));
        totals.sort((a, b) => b.total - a.total);
        answer += `🏆 Lider: *${totals[0].brand}* (${fmt(totals[0].total)} adet)`;
        answer += `\n\n💡 Bu markaların model detayları veya il bazlı dağılımını sorabilirsiniz.`;
        return answer;
    }

    // ── Marka sıralaması (toplam) ──
    if (keys.includes('marka') && keys.includes('toplam') && !keys.includes('model') && !keys.includes('yil')) {
        const city = detectCity(question);
        const cityName = city ? cityProperCase(city) : null;
        let answer = `📊 *${cityName ? cityName + " - " : ""}Marka Satış Sıralaması* (${period})\n\n`;
        rows.forEach((r, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            answer += `${medal} *${r.marka}:* ${fmt(r.toplam)} adet\n`;
        });
        answer += `\n💡 Bu markaların model detaylarını veya teknik özelliklerini sorabilirsiniz.`;
        return answer;
    }

    // ── Model sıralaması (marka + model + toplam) ──
    if (keys.includes('marka') && keys.includes('model') && keys.includes('toplam')) {
        const city = detectCity(question);
        const cityName = city ? cityProperCase(city) : null;
        let answer = `📊 *${cityName ? cityName + " - " : ""}En Çok Satan Modeller* (${period})\n\n`;
        rows.forEach((r, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            answer += `${medal} *${r.marka} ${r.model}:* ${fmt(r.toplam)} adet\n`;
        });
        const totalSales = rows.reduce((s, r) => s + Number(r.toplam), 0);
        answer += `\n📈 Toplam: ${fmt(totalSales)} adet (ilk ${rows.length} model)`;
        answer += `\n\n💡 Bu modellerin teknik özelliklerini veya farklı bir ilin verilerini sorabilirsiniz.`;
        return answer;
    }

    // ── HP/Segment sıralaması ──
    if (keys.includes('hp_range') && keys.includes('toplam')) {
        let answer = `📊 *HP Segment Dağılımı* (${period})\n\n`;
        const totalAll = rows.reduce((s, r) => s + Number(r.toplam), 0);
        rows.forEach(r => {
            const pct = totalAll > 0 ? (Number(r.toplam) / totalAll * 100).toFixed(1) : 0;
            answer += `⚙️ *${r.hp_range} HP:* ${fmt(r.toplam)} adet (%${pct})\n`;
        });
        answer += `\n💡 Belirli bir HP segmentinin marka dağılımını sorabilirsiniz.`;
        return answer;
    }

    // ── Teknik özellikler ──
    if (keys.includes('motor_gucu_hp') && keys.includes('marka')) {
        let answer = `🔧 *Teknik Özellikler*\n\n`;
        rows.forEach(r => {
            answer += `🚜 *${r.marka} ${r.model || ''}*\n`;
            if (r.motor_gucu_hp) answer += `   Motor: ${r.motor_gucu_hp} HP`;
            if (r.cekis_tipi) answer += ` | ${r.cekis_tipi}`;
            if (r.koruma) answer += ` | ${r.koruma}`;
            answer += '\n';
            if (r.vites_sayisi) answer += `   Vites: ${r.vites_sayisi}`;
            if (r.fiyat_usd && Number(r.fiyat_usd) > 0) answer += ` | Fiyat: ${fmt(r.fiyat_usd)} $`;
            if (r.emisyon_seviyesi) answer += ` | ${r.emisyon_seviyesi}`;
            answer += '\n';
            if (r.mensei) answer += `   Menşei: ${r.mensei}`;
            if (r.motor_marka) answer += ` | Motor: ${r.motor_marka}`;
            answer += '\n\n';
        });
        answer += `💡 Bu modellerin satış performansını veya rakiplerini sorabilirsiniz.`;
        return answer;
    }

    // ── Çekiş tipi (4WD/2WD) ──
    if (keys.includes('cekis') && keys.includes('toplam')) {
        let answer = `📊 *Çekiş Tipi Dağılımı* (${period})\n\n`;
        const totalAll = rows.reduce((s, r) => s + Number(r.toplam), 0);
        rows.forEach(r => {
            const pct = totalAll > 0 ? (Number(r.toplam) / totalAll * 100).toFixed(1) : 0;
            answer += `🔧 *${r.cekis}:* ${fmt(r.toplam)} adet (%${pct})\n`;
        });
        answer += `\n💡 Belirli çekiş tipinin marka dağılımını sorabilirsiniz.`;
        return answer;
    }

    // ── Kategori (bahçe/tarla) ──
    if (keys.includes('kategori') && keys.includes('toplam')) {
        let answer = `📊 *Kategori Dağılımı* (${period})\n\n`;
        rows.forEach(r => {
            const icon = r.kategori === 'bahce' ? '🌿' : '🌾';
            answer += `${icon} *${r.kategori === 'bahce' ? 'Bahçe' : 'Tarla'}${r.marka ? ' - ' + r.marka : ''}:* ${fmt(r.toplam)} adet\n`;
        });
        answer += `\n💡 Belirli kategorinin model detaylarını sorabilirsiniz.`;
        return answer;
    }

    // ── Bölge dağılımı ──
    if (keys.includes('bolge') && keys.includes('toplam')) {
        let answer = `📊 *Bölge Bazlı Satışlar* (${period})\n\n`;
        rows.forEach((r, i) => {
            answer += `${i + 1}. *${r.bolge}${r.marka ? ' - ' + r.marka : ''}:* ${fmt(r.toplam)} adet\n`;
        });
        answer += `\n💡 Belirli bir bölgenin il detaylarını sorabilirsiniz.`;
        return answer;
    }

    return null; // Tanınamayan format → ham tabloya düş
}

async function resolveAssistantQuestion(question, phoneNumber) {
    const latestPeriod = await getLatestSalesPeriod();

    if (!latestPeriod) {
        return { ok: false, answer: 'Henüz satış verisi bulunmuyor.', intent: 'no_data' };
    }

    // Yardım komutu
    const normalizedQ = normalizeSearchText(question);
    if (['yardim', 'help', 'komutlar', 'neler sorabilirm', 'merhaba', 'selam'].some(k => normalizedQ.includes(k))) {
        return {
            ok: true, intent: 'help',
            answer: `🚜 *Traktör Sektör AI Asistan*\n\nTürkiye traktör sektörü hakkında her soruyu yanıtlarım:\n\n📊 "2025'te kaç traktör satıldı?"\n🏆 "New Holland ile Massey Ferguson'u karşılaştır"\n📈 "Konya'da hangi HP segmenti çok satıyor?"\n🗺️ "Ege bölgesinde 4WD oranı nedir?"\n🌾 "Bahçe traktörlerinde lider marka"\n📉 "Geçen yıla göre pazar nasıl değişti?"\n💡 "Karasal iklimde buğday illeri analizi"\n🔧 "New Holland T6050 teknik özellikleri"\n💰 "Hattat markasının cirosu ne kadar?"\n\nBasit sorulara kısa, karmaşık sorulara derin analiz sunarım.\nÖnceki sorularınızın devamını sorabilirsiniz — bağlamı hatırlıyorum.`
        };
    }

    // Konuşma bağlamını al
    const history = phoneNumber ? getConversationHistory(phoneNumber) : [];

    // ═══ KISA SORGU GENİŞLETME ═══
    // "erzincan", "trabzon'da" gibi kısa şehir sorgularını önceki kalıpla genişlet
    const originalQuestion = question;
    question = expandShortQuery(question, history);
    if (question !== originalQuestion) {
        console.log(`📍 Sorgu genişletildi: "${originalQuestion}" → "${question}"`);
    }

    const conversationCtx = buildConversationContext(history);

    // ═══ CİRO SORGULARI İÇİN ÖZEL MOTOR ═══
    try {
        const ciroSql = buildCiroSql(question, history, latestPeriod);
        console.log(`💰 buildCiroSql sonucu: ${ciroSql ? 'SQL üretildi' : 'null (ciro değil)'}`);
        if (ciroSql) {
            console.log(`💰 Ciro SQL: ${ciroSql.substring(0, 200)}`);
            const ciroResult = await executeSafeSql(ciroSql);
            console.log(`💰 Ciro execute: error=${ciroResult.error || 'yok'}, rows=${ciroResult.rows?.length || 0}`);
            if (ciroResult.error) {
                console.error(`❌ Ciro SQL hatası: ${ciroResult.error}`);
            }
            if (!ciroResult.error && ciroResult.rows && ciroResult.rows.length > 0) {
                const row = ciroResult.rows[0];
                console.log(`💰 Ciro ham veri:`, JSON.stringify(row));
                const adet = Number(row.adet) || 0;
                const ciroUsd = Number(row.tahmini_ciro_usd) || 0;
                const avgPrice = Number(row.ortalama_fiyat_usd) || 0;
                const marka = row.marka || '?';
                const yil = row.yil || '';

                // Ciro formatlama helper
                const formatCiro = (val) => val >= 1e9 ? (val / 1e9).toFixed(1).replace('.', ',') + ' Mr $'
                    : val >= 1e6 ? (val / 1e6).toFixed(1).replace('.', ',') + ' M $'
                    : val.toLocaleString('tr-TR', {maximumFractionDigits: 0}) + ' $';
                const formatAvg = (val) => val >= 1000 ? (val / 1000).toFixed(1).replace('.', ',') + ' B $'
                    : val.toLocaleString('tr-TR', {maximumFractionDigits: 0}) + ' $';

                // Ciro NULL/0 ise → tractor_models.price_usd fallback
                if (ciroUsd === 0 || avgPrice === 0) {
                    console.log(`⚠️ Ciro=0 for ${marka}. Fallback: tractor_models.price_usd`);
                    const fallbackSql = `SELECT b.name as marka, ${yil} as yil, SUM(sv.quantity) as adet,
                        (SELECT AVG(tm.price_usd) FROM tractor_models tm WHERE tm.brand_id = b.id AND tm.price_usd IS NOT NULL AND tm.price_usd > 0 AND tm.is_current_model = true) as ortalama_fiyat_usd,
                        SUM(sv.quantity) * (SELECT AVG(tm.price_usd) FROM tractor_models tm WHERE tm.brand_id = b.id AND tm.price_usd IS NOT NULL AND tm.price_usd > 0 AND tm.is_current_model = true) as tahmini_ciro_usd
                    FROM sales_view sv JOIN brands b ON sv.brand_id = b.id
                    WHERE UPPER(b.name) = '${marka.toUpperCase()}' AND sv.year = ${yil}
                    GROUP BY b.name, b.id`;
                    const fbResult = await executeSafeSql(fallbackSql);
                    if (!fbResult.error && fbResult.rows && fbResult.rows.length > 0) {
                        const fbRow = fbResult.rows[0];
                        const fbCiro = Number(fbRow.tahmini_ciro_usd) || 0;
                        const fbAvg = Number(fbRow.ortalama_fiyat_usd) || 0;
                        console.log(`💰 Fallback sonuç: ciro=${fbCiro}, avg=${fbAvg}`);
                        if (fbCiro > 0 && fbAvg > 0) {
                            return {
                                ok: true, intent: 'ciro',
                                answer: `*${marka}* markasının ${yil} yılı tahmini cirosu *${formatCiro(fbCiro)}* olarak hesaplanmıştır.\n\n📊 Toplam satış: *${adet.toLocaleString('tr-TR')}* adet\n💰 Ortalama model fiyatı: *${formatAvg(fbAvg)}*\n\n_Not: Ciro, satış adedi × ortalama model fiyatı (USD) ile tahmin edilmiştir._\n\n💡 Bu markanın teknik özelliklerini veya başka bir markayla karşılaştırmasını sorabilirsiniz.`,
                                parser: 'ciro-engine-fallback', sql: fallbackSql
                            };
                        }
                    }
                    return {
                        ok: true, intent: 'ciro',
                        answer: `*${marka}* markasının ${yil} yılında toplam *${adet.toLocaleString('tr-TR')} adet* traktör satışı bulunmaktadır.\n\n⚠️ Bu marka için fiyat bilgisi mevcut olmadığından ciro hesaplaması yapılamamıştır.`,
                        parser: 'ciro-engine-noprice', sql: ciroSql
                    };
                }

                // Ciro var → doğrudan formatla
                console.log(`✅ Ciro hesaplandı: ${marka} ${yil} → ${ciroUsd} USD`);
                return {
                    ok: true, intent: 'ciro',
                    answer: `*${marka}* markasının ${yil} yılı tahmini cirosu *${formatCiro(ciroUsd)}* olarak hesaplanmıştır.\n\n📊 Toplam satış: *${adet.toLocaleString('tr-TR')}* adet\n💰 Ortalama model fiyatı: *${formatAvg(avgPrice)}*\n\n_Not: Ciro, satış adedi × ortalama model fiyatı (USD) ile tahmin edilmiştir._\n\n💡 Bu markanın teknik özelliklerini veya başka bir markayla karşılaştırmasını sorabilirsiniz.`,
                    parser: 'ciro-engine', sql: ciroSql
                };
            } else {
                console.log(`⚠️ Ciro motoru: sorgu çalıştı ama 0 satır döndü`);
            }
        }
    } catch (ciroErr) {
        console.error(`❌ Ciro motoru exception: ${ciroErr.message}`, ciroErr.stack);
    }

    // ═══ TEXT-TO-SQL MOTORU — Tüm sorular buradan geçer ═══
    console.log(`🤖 Text-to-SQL aktif: "${question}" (bağlam: ${history.length} mesaj)`);
    let sql = await textToSql(question, conversationCtx);
    if (!sql) {
        // Rate limit (429) veya timeout ise tekrar deneme — token israfı
        const isRateLimit = lastGroqError && (lastGroqError.includes('429') || lastGroqError.includes('TIMEOUT'));
        if (!isRateLimit && conversationCtx) {
            console.log('🔄 Bağlamsız retry deneniyor...');
            sql = await textToSql(question, '');
        }
        if (!sql) {
            // Akıllı fallback SQL üret (Groq olmadan)
            const fallbackSql = buildSmartFallbackSql(question, latestPeriod);
            if (fallbackSql) {
                console.log(`🏗️ Groq başarısız (${lastGroqError || '?'}), fallback SQL: ${fallbackSql.substring(0, 150)}`);
                sql = fallbackSql;
            } else {
                return {
                    ok: false, intent: 'unsupported',
                    answer: 'Bu soruyu anlayamadım. Traktör satış verileri hakkında soru sorabilirsiniz.\n\n"yardım" yazarak neler sorabileceğinizi görebilirsiniz.'
                };
            }
        }
    }

    console.log(`📝 Üretilen SQL: ${sql}`);
    let result = await executeSafeSql(sql);

    // SQL hatası varsa, hatayı Groq'a gönderip düzeltmesini iste (1 retry)
    if (result.error) {
        console.log(`🔄 SQL retry: hata="${result.error}"`);
        const retrySql = await textToSqlRetry(question, sql, result.error);
        if (retrySql) {
            console.log(`📝 Düzeltilmiş SQL: ${retrySql}`);
            sql = retrySql;
            result = await executeSafeSql(retrySql);
        }
    }

    if (result.error) {
        console.error(`❌ SQL hata (retry sonrası): ${result.error}`);
        return {
            ok: false, intent: 'sql_error',
            answer: 'Sorgunuz işlenirken teknik bir hata oluştu. Lütfen sorunuzu farklı şekilde ifade edin veya daha spesifik bir kriter belirtin.'
        };
    }

    if (!result.rows || result.rows.length === 0) {
        return {
            ok: true, intent: 'text_to_sql',
            answer: 'Sorgunuz için veri bulunamadı. Farklı bir yıl, marka veya bölge deneyebilirsiniz.',
            sql
        };
    }

    // AI ile sonuçları soruya özel yorumla (konuşma bağlamı ile)
    const interpretation = await interpretResults(question, sql, result, conversationCtx);
    if (interpretation) {
        return {
            ok: true, intent: 'text_to_sql',
            answer: interpretation,
            parser: 'text-to-sql',
            sql,
            rowCount: result.rowCount
        };
    }

    // ═══ LOKAL AKILLI YORUMLAMA (Groq olmadan) ═══
    const localAnswer = buildLocalInterpretation(question, result, latestPeriod);
    if (localAnswer) {
        return {
            ok: true, intent: 'text_to_sql',
            answer: localAnswer,
            parser: 'local-interpretation',
            sql,
            rowCount: result.rowCount
        };
    }

    // Son çare: basit tablo formatı
    const fieldLabels = { marka: 'Marka', model: 'Model', toplam: 'Adet', adet: 'Adet', name: 'İsim', satis_adet: 'Satış', yil: 'Yıl', sehir_adi: 'İl', hp_range: 'HP', category: 'Kategori' };
    const hiddenFields = ['min_yil', 'max_yil'];
    const fields = (result.fields || Object.keys(result.rows[0] || {})).filter(f => !hiddenFields.includes(f));

    // Dönem bilgisi çıkar (varsa)
    let periodInfo = '';
    const firstRow = result.rows[0] || {};
    if (firstRow.min_yil && firstRow.max_yil) {
        periodInfo = firstRow.min_yil === firstRow.max_yil
            ? `\n📅 *Dönem:* ${firstRow.min_yil} yılı verileri\n`
            : `\n📅 *Dönem:* ${firstRow.min_yil}-${firstRow.max_yil} yılları toplamı\n`;
    } else {
        // SQL'den dönem bilgisi yoksa latestPeriod kullan
        if (latestPeriod) {
            periodInfo = `\n📅 *Dönem:* Mevcut tüm veriler (son veri: ${latestPeriod.year}/${latestPeriod.month})\n`;
        }
    }

    let plainAnswer = `📊 *Sorgu Sonucu* (${result.rowCount} kayıt)${periodInfo}\n`;
    result.rows.slice(0, 10).forEach((row, i) => {
        const vals = fields.map(f => {
            const label = fieldLabels[f] || f;
            const val = row[f] != null ? (typeof row[f] === 'number' ? Number(row[f]).toLocaleString('tr-TR') : row[f]) : '-';
            return `${label}: ${val}`;
        }).join(' | ');
        plainAnswer += `${i + 1}. ${vals}\n`;
    });
    if (result.rowCount > 10) plainAnswer += `\n... ve ${result.rowCount - 10} kayıt daha`;
    plainAnswer += `\n\n💡 Daha detaylı analiz için sorunuzu genişletebilirsiniz.`;

    return {
        ok: true, intent: 'text_to_sql',
        answer: plainAnswer,
        parser: 'text-to-sql-raw',
        sql,
        rowCount: result.rowCount
    };
}

async function sendWhatsAppTextMessage(to, body) {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error('WhatsApp credentials tanimli degil');
    }

    const response = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body }
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`WhatsApp send failed: ${response.status} ${errorBody}`);
    }

    return response.json();
}

async function forwardWhatsAppEventToN8n(payload) {
    if (!N8N_WHATSAPP_PROCESSOR_URL) {
        return false;
    }

    const response = await fetch(N8N_WHATSAPP_PROCESSOR_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(WHATSAPP_QUERY_API_KEY ? { 'x-query-token': WHATSAPP_QUERY_API_KEY } : {})
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`n8n forward failed (${response.status}): ${errText}`);
    }

    return true;
}

function getPublicUrl(path) {
    if (!APP_BASE_URL) return null;
    return `${APP_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function formatCurrencyShort(value) {
    const amount = Number(value || 0);
    if (!amount) return '-';
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(1).replace('.', ',')} Mn TL`;
    if (amount >= 1000) return `${Math.round(amount / 1000)} Bin TL`;
    return `${formatNumberTR(amount)} TL`;
}

function formatPctSigned(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
    const num = Number(value);
    const prefix = num > 0 ? '+' : '';
    return `${prefix}${num.toFixed(1).replace('.', ',')}%`;
}

function buildTopList(items, mapper, limit = 3) {
    return (items || []).slice(0, limit).map(mapper).join(' | ');
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildBarChartSvg(items, options = {}) {
    const width = options.width || 860;
    const rowHeight = options.rowHeight || 44;
    const height = Math.max(120, 40 + items.length * rowHeight);
    const leftPad = 180;
    const maxValue = Math.max(...items.map(item => Number(item.value || 0)), 1);
    const palette = options.color || '#2457C5';

    const rows = items.map((item, index) => {
        const y = 28 + index * rowHeight;
        const value = Number(item.value || 0);
        const barWidth = Math.max(2, Math.round((width - leftPad - 90) * value / maxValue));
        const label = escapeHtml(item.label);
        const valueLabel = escapeHtml(item.valueLabel || formatNumberTR(value));
        return `
            <text x="0" y="${y}" font-size="14" fill="#20304A">${label}</text>
            <rect x="${leftPad}" y="${y - 16}" width="${barWidth}" height="18" rx="6" fill="${palette}" opacity="0.88"></rect>
            <text x="${leftPad + barWidth + 10}" y="${y - 2}" font-size="13" fill="#20304A">${valueLabel}</text>
        `;
    }).join('');

    return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#ffffff"/>
        ${rows}
    </svg>`;
}

function buildMiniColumnSvg(items, options = {}) {
    const width = options.width || 860;
    const height = options.height || 240;
    const maxValue = Math.max(...items.map(item => Number(item.value || 0)), 1);
    const barGap = 18;
    const chartHeight = height - 70;
    const baseY = height - 36;
    const barWidth = Math.max(18, Math.floor((width - 60 - (items.length - 1) * barGap) / items.length));
    const color = options.color || '#0F8F6E';

    const bars = items.map((item, index) => {
        const x = 30 + index * (barWidth + barGap);
        const barHeight = Math.max(4, Math.round(chartHeight * Number(item.value || 0) / maxValue));
        const y = baseY - barHeight;
        return `
            <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="8" fill="${color}" opacity="0.88"></rect>
            <text x="${x + barWidth / 2}" y="${baseY + 18}" text-anchor="middle" font-size="12" fill="#20304A">${escapeHtml(item.label)}</text>
        `;
    }).join('');

    return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <line x1="24" y1="${baseY}" x2="${width - 20}" y2="${baseY}" stroke="#D4DBE6" stroke-width="1"/>
        ${bars}
    </svg>`;
}

function buildLineTrendSvg(items, options = {}) {
    const width = options.width || 860;
    const height = options.height || 250;
    const leftPad = 40;
    const rightPad = 20;
    const topPad = 22;
    const bottomPad = 40;
    const maxValue = Math.max(...items.map(item => Number(item.value || 0)), 1);
    const chartWidth = width - leftPad - rightPad;
    const chartHeight = height - topPad - bottomPad;
    const stepX = items.length > 1 ? chartWidth / (items.length - 1) : chartWidth / 2;
    const color = options.color || '#2457C5';

    const points = items.map((item, index) => {
        const x = leftPad + index * stepX;
        const y = topPad + chartHeight - (chartHeight * Number(item.value || 0) / maxValue);
        return { x, y, label: item.label, value: Number(item.value || 0) };
    });

    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    const areaPath = `${path} L ${points[points.length - 1]?.x || leftPad} ${topPad + chartHeight} L ${points[0]?.x || leftPad} ${topPad + chartHeight} Z`;

    return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
            <linearGradient id="lineFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="${color}" stop-opacity="0.24"/>
                <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
            </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="#ffffff"/>
        <line x1="${leftPad}" y1="${topPad + chartHeight}" x2="${width - rightPad}" y2="${topPad + chartHeight}" stroke="#D4DBE6" stroke-width="1"/>
        <path d="${areaPath}" fill="url(#lineFill)"></path>
        <path d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
        ${points.map(point => `
            <circle cx="${point.x}" cy="${point.y}" r="5" fill="${color}"></circle>
            <text x="${point.x}" y="${topPad + chartHeight + 18}" text-anchor="middle" font-size="12" fill="#20304A">${escapeHtml(point.label)}</text>
            <text x="${point.x}" y="${point.y - 10}" text-anchor="middle" font-size="12" fill="#20304A">${escapeHtml(formatNumberTR(point.value))}</text>
        `).join('')}
    </svg>`;
}

function buildDonutSvg(items, options = {}) {
    const size = options.size || 300;
    const strokeWidth = options.strokeWidth || 38;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0) || 1;
    const colors = options.colors || ['#2457C5', '#0F8F6E', '#D9722E', '#A72626', '#6B4FD3', '#8A9BB5'];
    let offset = 0;

    const segments = items.map((item, index) => {
        const value = Number(item.value || 0);
        const segmentLength = (value / total) * circumference;
        const dashArray = `${segmentLength} ${circumference - segmentLength}`;
        const circle = `
            <circle
                cx="${size / 2}"
                cy="${size / 2}"
                r="${radius}"
                fill="none"
                stroke="${colors[index % colors.length]}"
                stroke-width="${strokeWidth}"
                stroke-dasharray="${dashArray}"
                stroke-dashoffset="${-offset}"
                transform="rotate(-90 ${size / 2} ${size / 2})"
                stroke-linecap="butt"></circle>`;
        offset += segmentLength;
        return circle;
    }).join('');

    const legend = items.map((item, index) => `
        <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
            <span style="width:12px;height:12px;border-radius:999px;background:${colors[index % colors.length]};display:inline-block;"></span>
            <span style="font-size:13px;color:#20304A;">${escapeHtml(item.label)}: <strong>${escapeHtml(item.valueLabel || formatNumberTR(item.value))}</strong></span>
        </div>
    `).join('');

    return `
        <div style="display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:20px;align-items:center;">
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
                <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#E6EBF2" stroke-width="${strokeWidth}"></circle>
                ${segments}
                <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" font-size="34" font-weight="700" fill="#10223D">${escapeHtml(formatNumberTR(total))}</text>
                <text x="${size / 2}" y="${size / 2 + 24}" text-anchor="middle" font-size="13" fill="#6B7A90">Toplam</text>
            </svg>
            <div>${legend}</div>
        </div>
    `;
}

function wrapReportHtml(title, subtitle, sections) {
    return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: "Segoe UI", Arial, sans-serif; background:#F4F7FB; color:#20304A; margin:0; }
    .page { max-width:1100px; margin:32px auto; padding:0 18px; }
    .hero { background:linear-gradient(135deg,#0B1F3A,#2457C5); color:#fff; border-radius:24px; padding:28px 30px; box-shadow:0 16px 40px rgba(25,60,120,.22); }
    .hero h1 { margin:0 0 8px; font-size:34px; }
    .hero p { margin:0; opacity:.9; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-top:18px; }
    .kpi { background:#fff; border-radius:18px; padding:18px; box-shadow:0 10px 30px rgba(24,47,89,.08); }
    .kpi .label { font-size:12px; color:#6B7A90; text-transform:uppercase; letter-spacing:.04em; }
    .kpi .value { margin-top:8px; font-size:28px; font-weight:700; color:#10223D; }
    .section { background:#fff; border-radius:20px; padding:22px; margin-top:18px; box-shadow:0 10px 30px rgba(24,47,89,.08); }
    .section h2 { margin:0 0 14px; font-size:20px; }
    .section p, .section li { font-size:15px; line-height:1.65; }
    .section ul { margin:0; padding-left:18px; }
    .chart { overflow:auto; border:1px solid #E3E8F0; border-radius:16px; padding:12px; background:#FCFDFE; }
    .split { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:18px; }
    .note { background:#F7FAFF; border:1px solid #DCE7F8; border-radius:16px; padding:14px 16px; }
    .note strong { display:block; margin-bottom:6px; color:#10223D; }
    .list-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .pill { background:#F3F6FB; border:1px solid #E2E8F0; border-radius:14px; padding:12px 14px; }
    .pill .mini { color:#6B7A90; font-size:12px; text-transform:uppercase; letter-spacing:.04em; display:block; margin-bottom:6px; }
    .footer { color:#6B7A90; font-size:12px; margin:18px 0 30px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    ${sections.join('\n')}
    <div class="footer">StratejikPlan WhatsApp Sales Assistant | Railway + Groq + PostgreSQL</div>
  </div>
</body>
</html>`;
}

async function buildBrandExecutiveData(brand, year, latestPeriod) {
    const limitMonth = year === latestPeriod.year ? latestPeriod.month : 12;
    const prevYear = year - 1;

    const [salesRes, marketRes, rankRes, monthlyRes, provincesRes, hpRes, categoryRes, driveRes, modelsRes, yearlyTrendRes, provinceCountRes] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE brand_id = $1 AND year = $2 AND month <= $3`, [brand.id, year, limitMonth]),
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE year = $1 AND month <= $2`, [year, limitMonth]),
        pool.query(`
            WITH yearly_sales AS (
                SELECT brand_id, SUM(quantity) as total_sales
                FROM sales_view
                WHERE year = $1 AND month <= $2
                GROUP BY brand_id
            )
            SELECT rank FROM (
                SELECT brand_id, DENSE_RANK() OVER (ORDER BY total_sales DESC) as rank
                FROM yearly_sales
            ) ranked WHERE brand_id = $3
        `, [year, limitMonth, brand.id]),
        pool.query(`
            SELECT month, SUM(quantity) as total
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY month ORDER BY month
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT p.name, SUM(s.quantity) as total
            FROM sales_view s JOIN provinces p ON s.province_id = p.id
            WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3
            GROUP BY p.name ORDER BY total DESC LIMIT 5
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT hp_range, SUM(quantity) as total
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY hp_range ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT category, SUM(quantity) as total
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY category ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT drive_type, SUM(quantity) as total
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY drive_type ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT model_name, horsepower, price_usd
            FROM tractor_models
            WHERE brand_id = $1 AND is_current_model = true
            ORDER BY horsepower
        `, [brand.id]),
        pool.query(`
            SELECT year, SUM(quantity) as total
            FROM sales_view
            WHERE brand_id = $1 AND year IN ($2, $3, $4) AND month <= $5
            GROUP BY year ORDER BY year
        `, [brand.id, year - 2, year - 1, year, limitMonth]),
        pool.query(`
            SELECT COUNT(DISTINCT province_id) as active_provinces
            FROM sales_view
            WHERE brand_id = $1 AND year = $2 AND month <= $3
        `, [brand.id, year, limitMonth])
    ]);

    const currentSales = parseInt(salesRes.rows[0]?.total_sales || 0, 10);
    const marketSales = parseInt(marketRes.rows[0]?.total_sales || 0, 10);
    const marketShare = marketSales > 0 ? currentSales * 100 / marketSales : 0;
    const rank = parseInt(rankRes.rows[0]?.rank || 0, 10);

    const prevRes = await pool.query(
        `SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE brand_id = $1 AND year = $2 AND month <= $3`,
        [brand.id, prevYear, limitMonth]
    );
    const prevSales = parseInt(prevRes.rows[0]?.total_sales || 0, 10);
    const yoy = prevSales > 0 ? ((currentSales - prevSales) * 100 / prevSales) : 0;

    const topProvinces = provincesRes.rows.map(row => ({ name: row.name, total: parseInt(row.total, 10) }));
    const hpSegments = hpRes.rows.map(row => ({ name: row.hp_range, total: parseInt(row.total, 10) }));
    const categories = Object.fromEntries(categoryRes.rows.map(row => [row.category, parseInt(row.total, 10)]));
    const drives = Object.fromEntries(driveRes.rows.map(row => [row.drive_type, parseInt(row.total, 10)]));
    const models = modelsRes.rows.map(row => ({
        name: row.model_name,
        hp: row.horsepower ? parseFloat(row.horsepower) : null,
        price: row.price_usd ? parseFloat(row.price_usd) : null
    }));
    const avgPrice = models.filter(m => m.price).length
        ? models.filter(m => m.price).reduce((sum, item) => sum + item.price, 0) / models.filter(m => m.price).length
        : 0;
    const pricedModels = models.filter(item => item.price);
    const minPrice = pricedModels.length ? Math.min(...pricedModels.map(item => item.price)) : 0;
    const maxPrice = pricedModels.length ? Math.max(...pricedModels.map(item => item.price)) : 0;
    const activeProvinceCount = parseInt(provinceCountRes.rows[0]?.active_provinces || 0, 10);

    const periodLabel = formatPeriodLabel(year, limitMonth, latestPeriod.year, latestPeriod.month);
    const monthly = Array.from({ length: limitMonth }, (_, index) => {
        const month = index + 1;
        const row = monthlyRes.rows.find(item => Number(item.month) === month);
        return { month, total: parseInt(row?.total || 0, 10), label: MONTH_NAMES_TR[month - 1].slice(0, 3) };
    });
    const peakMonth = monthly.reduce((best, item) => item.total > (best?.total || 0) ? item : best, null);
    const yearlyTrend = [year - 2, year - 1, year].map(y => ({
        year: y,
        total: parseInt(yearlyTrendRes.rows.find(row => Number(row.year) === y)?.total || 0, 10)
    }));
    const drive4wdRatio = ((drives['4WD'] || 0) * 100) / Math.max(currentSales, 1);

    let commentary = '';
    const brief = await callGroqJson(
        'Yalnızca JSON döndür. { "summary": "...", "recommendation": "..." } formatını kullan. Türkçe, yönetici dili kullan. Sayısal veriyi yorumla, 2 kısa cümlelik özet ve 1 kısa aksiyon önerisi ver. Aksiyon önerisi markanın kendi saha, segment, fiyat, il veya portföy hamlelerine odaklansın; rakiple işbirliği önerme.',
        JSON.stringify({
            brand: brand.name,
            year,
            periodLabel,
            currentSales,
            prevSales,
            yoy: Number(yoy.toFixed(1)),
            marketShare: Number(marketShare.toFixed(1)),
            rank,
            topProvinces,
            hpSegments: hpSegments.slice(0, 3),
            categories,
            drives,
            modelCount: models.length,
            avgPrice
        })
    );
    if (brief?.summary) commentary = `${brief.summary} ${brief.recommendation || ''}`.trim();

    return {
        brand,
        year,
        limitMonth,
        periodLabel,
        currentSales,
        prevSales,
        yoy,
        marketSales,
        marketShare,
        rank,
        topProvinces,
        hpSegments,
        categories,
        drives,
        models,
        avgPrice,
        minPrice,
        maxPrice,
        activeProvinceCount,
        peakMonth,
        drive4wdRatio,
        monthly,
        yearlyTrend,
        commentary
    };
}

async function buildMarketOverviewData(year, latestPeriod) {
    const limitMonth = year === latestPeriod.year ? latestPeriod.month : 12;
    const prevYear = year - 1;

    const [marketRes, prevMarketRes, brandsRes, provincesRes, hpRes, categoryRes, provinceCountRes] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE year = $1 AND month <= $2`, [year, limitMonth]),
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE year = $1 AND month <= $2`, [prevYear, limitMonth]),
        pool.query(`
            SELECT b.name, SUM(s.quantity) as total
            FROM sales_view s JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY b.name ORDER BY total DESC LIMIT 8
        `, [year, limitMonth]),
        pool.query(`
            SELECT p.name, SUM(s.quantity) as total
            FROM sales_view s JOIN provinces p ON s.province_id = p.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY p.name ORDER BY total DESC LIMIT 8
        `, [year, limitMonth]),
        pool.query(`
            SELECT hp_range, SUM(quantity) as total
            FROM sales_view
            WHERE year = $1 AND month <= $2
            GROUP BY hp_range ORDER BY total DESC LIMIT 6
        `, [year, limitMonth]),
        pool.query(`
            SELECT category, SUM(quantity) as total
            FROM sales_view
            WHERE year = $1 AND month <= $2
            GROUP BY category ORDER BY total DESC
        `, [year, limitMonth]),
        pool.query(`
            SELECT COUNT(DISTINCT province_id) as active_provinces
            FROM sales_view
            WHERE year = $1 AND month <= $2
        `, [year, limitMonth])
    ]);

    const currentSales = parseInt(marketRes.rows[0]?.total_sales || 0, 10);
    const prevSales = parseInt(prevMarketRes.rows[0]?.total_sales || 0, 10);
    const yoy = prevSales > 0 ? ((currentSales - prevSales) * 100 / prevSales) : 0;
    const topBrands = brandsRes.rows.map(row => ({ name: row.name, total: parseInt(row.total, 10) }));
    const topProvinces = provincesRes.rows.map(row => ({ name: row.name, total: parseInt(row.total, 10) }));
    const hpSegments = hpRes.rows.map(row => ({ name: row.hp_range, total: parseInt(row.total, 10) }));
    const categories = categoryRes.rows.map(row => ({ name: row.category, total: parseInt(row.total, 10) }));
    const periodLabel = formatPeriodLabel(year, limitMonth, latestPeriod.year, latestPeriod.month);
    const activeProvinceCount = parseInt(provinceCountRes.rows[0]?.active_provinces || 0, 10);
    const top3Share = currentSales > 0
        ? topBrands.slice(0, 3).reduce((sum, item) => sum + item.total, 0) * 100 / currentSales
        : 0;

    let commentary = '';
    const brief = await callGroqJson(
        'Yalnızca JSON döndür. { "summary": "...", "recommendation": "..." } formatını kullan. Türkçe, yönetici dili kullan. 2 kısa cümlelik pazar yorumu ve 1 kısa aksiyon önerisi ver. Öneri, pazar konsantrasyonu, bölgesel fırsat veya segment kayması gibi içgörü odaklı olsun; rakiplerle işbirliği önermesin.',
        JSON.stringify({
            year,
            periodLabel,
            currentSales,
            prevSales,
            yoy: Number(yoy.toFixed(1)),
            activeProvinceCount,
            top3Share: Number(top3Share.toFixed(1)),
            topBrands: topBrands.slice(0, 5),
            topProvinces: topProvinces.slice(0, 5),
            hpSegments: hpSegments.slice(0, 4),
            categories: categories.slice(0, 3)
        })
    );
    if (brief?.summary) commentary = `${brief.summary} ${brief.recommendation || ''}`.trim();

    return { year, limitMonth, periodLabel, currentSales, prevSales, yoy, topBrands, topProvinces, hpSegments, categories, activeProvinceCount, top3Share, commentary };
}

async function buildBrandCompareExecutiveData(brands, year, latestPeriod) {
    const limitMonth = year === latestPeriod.year ? latestPeriod.month : 12;
    const [first, second] = brands;
    const [, benchmarkRes] = await Promise.all([
        pool.query(`
            SELECT b.id, b.name, COALESCE(SUM(s.quantity), 0) as total_sales
            FROM brands b
            LEFT JOIN sales_data s ON s.brand_id = b.id AND s.year = $1 AND s.month <= $2
            WHERE b.id = ANY($3::int[])
            GROUP BY b.id, b.name
        `, [year, limitMonth, brands.map(item => item.id)]),
        pool.query(`
            WITH market AS (
                SELECT year, SUM(quantity) as total
                FROM sales_view
                WHERE year IN ($1, $2) AND month <= $3
                GROUP BY year
            ),
            brand_sales AS (
                SELECT brand_id, year, SUM(quantity) as total
                FROM sales_view
                WHERE brand_id = ANY($4::int[]) AND year IN ($1, $2) AND month <= $3
                GROUP BY brand_id, year
            )
            SELECT * FROM brand_sales
        `, [year, year - 1, limitMonth, brands.map(item => item.id)])
    ]);

    const prevRows = benchmarkRes.rows.filter(row => Number(row.year) === year - 1);
    const currRows = benchmarkRes.rows.filter(row => Number(row.year) === year);

    const marketRes = await pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_view WHERE year = $1 AND month <= $2`, [year, limitMonth]);
    const marketSales = parseInt(marketRes.rows[0]?.total_sales || 0, 10);

    const firstData = await buildBrandExecutiveData(first, year, latestPeriod);
    const secondData = await buildBrandExecutiveData(second, year, latestPeriod);
    const diff = firstData.currentSales - secondData.currentSales;
    const leader = diff >= 0 ? firstData : secondData;
    const lagger = diff >= 0 ? secondData : firstData;

    const provinceLead = await pool.query(`
        WITH prov AS (
            SELECT p.name,
                   SUM(CASE WHEN s.brand_id = $1 THEN s.quantity ELSE 0 END) as b1,
                   SUM(CASE WHEN s.brand_id = $2 THEN s.quantity ELSE 0 END) as b2
            FROM sales_view s JOIN provinces p ON s.province_id = p.id
            WHERE s.brand_id IN ($1, $2) AND s.year = $3 AND s.month <= $4
            GROUP BY p.name
        )
        SELECT name, b1, b2, ABS(b1 - b2) as gap
        FROM prov
        WHERE b1 > 0 OR b2 > 0
        ORDER BY gap DESC
    `, [first.id, second.id, year, limitMonth]);
    const provinceLeadRows = provinceLead.rows.map(row => ({
        name: row.name,
        b1: parseInt(row.b1, 10),
        b2: parseInt(row.b2, 10),
        gap: parseInt(row.gap, 10)
    }));
    const provinceWins = {
        first: provinceLeadRows.filter(item => item.b1 > item.b2).length,
        second: provinceLeadRows.filter(item => item.b2 > item.b1).length,
        tie: provinceLeadRows.filter(item => item.b1 === item.b2).length
    };
    const shareGap = Math.abs(firstData.marketShare - secondData.marketShare);
    const yoyGap = Math.abs(firstData.yoy - secondData.yoy);
    const priceGap = Math.abs(firstData.avgPrice - secondData.avgPrice);

    let commentary = '';
    const brief = await callGroqJson(
        'Yalnızca JSON döndür. { "summary": "...", "recommendation": "..." } formatını kullan. Türkçe, üst yönetime uygun dil kullan. 2 kısa cümlelik rekabet yorumu ve 1 aksiyon önerisi ver. Öneri, il/segment/fiyat farkları üzerinden somut bir takip veya savunma hamlesi içersin; genel geçiş cümlesi veya rakiple işbirliği önermesin.',
        JSON.stringify({
            year,
            limitMonth,
            marketSales,
            first: { name: firstData.brand.name, sales: firstData.currentSales, share: Number(firstData.marketShare.toFixed(1)), yoy: Number(firstData.yoy.toFixed(1)), avgPrice: firstData.avgPrice },
            second: { name: secondData.brand.name, sales: secondData.currentSales, share: Number(secondData.marketShare.toFixed(1)), yoy: Number(secondData.yoy.toFixed(1)), avgPrice: secondData.avgPrice },
            leadingHpFirst: firstData.hpSegments.slice(0, 2),
            leadingHpSecond: secondData.hpSegments.slice(0, 2),
            topProvinceBattles: provinceLead.rows
        })
    );
    if (brief?.summary) commentary = `${brief.summary} ${brief.recommendation || ''}`.trim();

    return {
        year,
        limitMonth,
        periodLabel: formatPeriodLabel(year, limitMonth, latestPeriod.year, latestPeriod.month),
        first: firstData,
        second: secondData,
        marketSales,
        leader,
        lagger,
        difference: Math.abs(diff),
        shareGap,
        yoyGap,
        priceGap,
        provinceWins,
        provinceLead: provinceLeadRows.slice(0, 6),
        commentary
    };
}

function buildBrandExecutiveMessage(report) {
    const dominantHp = report.hpSegments[0];
    const reportUrl = getPublicUrl(`/public/reports/brand?brand=${encodeURIComponent(report.brand.slug)}&year=${report.year}`);
    const trendSummary = buildTopList(report.yearlyTrend, item => `${item.year}: ${formatNumberTR(item.total)}`, 3);
    return [
        `*Yönetici Brifingi | ${report.brand.name} | ${report.periodLabel}*`,
        `*Pazar Konumu*`,
        `- Hacim: ${formatNumberTR(report.currentSales)} adet | Pay: %${formatShare(report.marketShare)} | Sıra: ${report.rank || '-'}`,
        `- Yıllık momentum: ${formatPctSigned(report.yoy)} | Aktif il: ${formatNumberTR(report.activeProvinceCount)}`,
        `*Momentum ve Saha*`,
        `- 3 yıllık iz: ${trendSummary || '-'}`,
        `- Tepe ay: ${report.peakMonth ? `${MONTH_NAMES_TR[report.peakMonth.month - 1]} (${formatNumberTR(report.peakMonth.total)})` : '-'}`,
        `- En güçlü iller: ${buildTopList(report.topProvinces, item => `${item.name} (${formatNumberTR(item.total)})`) || '-'}`,
        `*Segment ve Portföy*`,
        `- Lider HP bandı: ${dominantHp ? `${dominantHp.name} (${formatNumberTR(dominantHp.total)})` : '-'}`,
        `- Tarla/Bahçe dengesi: ${formatNumberTR(report.categories.tarla || 0)} / ${formatNumberTR(report.categories.bahce || 0)}`,
        `- 4WD penetrasyonu: %${formatShare(report.drive4wdRatio)}`,
        `- Portföy: ${report.models.length} aktif model | Fiyat koridoru: ${formatCurrencyShort(report.minPrice)} - ${formatCurrencyShort(report.maxPrice)}`,
        `- Ortalama liste fiyatı: ${formatCurrencyShort(report.avgPrice)}`,
        report.commentary ? `*Yönetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli yönetici paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function buildBrandCompareMessage(report) {
    const reportUrl = getPublicUrl(`/public/reports/compare?brand1=${encodeURIComponent(report.first.brand.slug)}&brand2=${encodeURIComponent(report.second.brand.slug)}&year=${report.year}`);
    return [
        `*Rekabet Brifingi | ${report.first.brand.name} vs ${report.second.brand.name} | ${report.periodLabel}*`,
        `*Skor Kartı*`,
        `- ${report.first.brand.name}: ${formatNumberTR(report.first.currentSales)} adet | Pay %${formatShare(report.first.marketShare)} | Değişim ${formatPctSigned(report.first.yoy)}`,
        `- ${report.second.brand.name}: ${formatNumberTR(report.second.currentSales)} adet | Pay %${formatShare(report.second.marketShare)} | Değişim ${formatPctSigned(report.second.yoy)}`,
        `- Lider: ${report.leader.brand.name} | Hacim farkı: ${formatNumberTR(report.difference)} adet | Pay farkı: ${formatShare(report.shareGap)} puan`,
        `*Saha ve Rekabet*`,
        `- İl üstünlüğü: ${report.first.brand.name} ${report.provinceWins.first} il, ${report.second.brand.name} ${report.provinceWins.second} il`,
        `- Kritik savaş alanları: ${buildTopList(report.provinceLead, item => `${item.name} (${formatNumberTR(item.gap)})`) || 'İl bazlı fark verisi yok'}`,
        `*Segment ve Fiyatlama*`,
        `- ${report.first.brand.name} lider HP: ${buildTopList(report.first.hpSegments, item => `${item.name}`, 2) || '-'}`,
        `- ${report.second.brand.name} lider HP: ${buildTopList(report.second.hpSegments, item => `${item.name}`, 2) || '-'}`,
        `- Ortalama liste fiyatları: ${report.first.brand.name} ${formatCurrencyShort(report.first.avgPrice)} | ${report.second.brand.name} ${formatCurrencyShort(report.second.avgPrice)} | Fark ${formatCurrencyShort(report.priceGap)}`,
        report.commentary ? `*Yönetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli rekabet paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function buildMarketOverviewMessage(report) {
    const reportUrl = getPublicUrl(`/public/reports/market?year=${report.year}`);
    return [
        `*Pazar Bülteni | ${report.periodLabel}*`,
        `*Üst Düzey Gösterge Seti*`,
        `- Toplam pazar: ${formatNumberTR(report.currentSales)} adet | Yıllık değişim: ${formatPctSigned(report.yoy)}`,
        `- Aktif il: ${formatNumberTR(report.activeProvinceCount)} | Top 3 marka konsantrasyonu: %${formatShare(report.top3Share)}`,
        `*Liderlik Tablosu*`,
        `- Markalar: ${buildTopList(report.topBrands, item => `${item.name} (${formatNumberTR(item.total)})`, 5) || '-'}`,
        `- İller: ${buildTopList(report.topProvinces, item => `${item.name} (${formatNumberTR(item.total)})`, 5) || '-'}`,
        `*Talep Profili*`,
        `- HP segmentleri: ${buildTopList(report.hpSegments, item => `${item.name} (${formatNumberTR(item.total)})`, 4) || '-'}`,
        `- Kategori resmi: ${buildTopList(report.categories, item => `${item.name} (${formatNumberTR(item.total)})`, 3) || '-'}`,
        report.commentary ? `*Yönetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli pazar paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function renderBrandExecutiveHtml(report) {
    const monthlySvg = buildLineTrendSvg(report.monthly.map(item => ({ label: item.label, value: item.total })), { color: '#2457C5' });
    const yearlySvg = buildMiniColumnSvg(report.yearlyTrend.map(item => ({ label: String(item.year), value: item.total })), { color: '#A72626' });
    const provinceSvg = buildBarChartSvg(report.topProvinces.map(item => ({ label: item.name, value: item.total })), { color: '#0F8F6E' });
    const hpDonut = buildDonutSvg(report.hpSegments.slice(0, 5).map(item => ({ label: item.name, value: item.total })), { size: 260 });
    return wrapReportHtml(
        `${report.brand.name} Yönetici Raporu`,
        `${report.periodLabel} | Satış, pazar payı, segment, il dağılımı ve portföy görünümü`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">Satış</div><div class="value">${formatNumberTR(report.currentSales)}</div></div>
                <div class="kpi"><div class="label">Pazar Payı</div><div class="value">%${formatShare(report.marketShare)}</div></div>
                <div class="kpi"><div class="label">Sıralama</div><div class="value">${report.rank || '-'}</div></div>
                <div class="kpi"><div class="label">Yıllık Değişim</div><div class="value">${formatPctSigned(report.yoy)}</div></div>
            </div>`,
            `<section class="section"><h2>Yönetici Özeti</h2><p>${escapeHtml(report.commentary || `${report.brand.name}, ${report.periodLabel} döneminde ${formatNumberTR(report.currentSales)} adet satış ve %${formatShare(report.marketShare)} pazar payına ulaşmıştır.`)}</p></section>`,
            `<section class="section"><h2>Momentum Paneli</h2><div class="split"><div class="chart">${monthlySvg}</div><div class="chart">${yearlySvg}</div></div></section>`,
            `<section class="section"><h2>Bölgesel Güç</h2><div class="chart">${provinceSvg}</div></section>`,
            `<section class="section"><h2>Segment ve Portföy Mimarisi</h2>
                <div class="split">
                    <div class="chart">${hpDonut}</div>
                    <div class="list-grid">
                        <div class="pill"><span class="mini">Lider HP</span><strong>${escapeHtml(report.hpSegments[0]?.name || '-')}</strong></div>
                        <div class="pill"><span class="mini">Tarla / Bahçe</span><strong>${formatNumberTR(report.categories.tarla || 0)} / ${formatNumberTR(report.categories.bahce || 0)}</strong></div>
                        <div class="pill"><span class="mini">4WD Penetrasyonu</span><strong>%${formatShare(report.drive4wdRatio)}</strong></div>
                        <div class="pill"><span class="mini">Aktif İl</span><strong>${formatNumberTR(report.activeProvinceCount)}</strong></div>
                        <div class="pill"><span class="mini">Aktif Model</span><strong>${report.models.length}</strong></div>
                        <div class="pill"><span class="mini">Fiyat Koridoru</span><strong>${escapeHtml(formatCurrencyShort(report.minPrice))} - ${escapeHtml(formatCurrencyShort(report.maxPrice))}</strong></div>
                    </div>
                </div>
            </section>`,
            `<section class="section"><h2>Ticari Notlar</h2>
                <div class="split">
                    <div class="note"><strong>Tepe Ay</strong>${report.peakMonth ? `${MONTH_NAMES_TR[report.peakMonth.month - 1]} ayında ${formatNumberTR(report.peakMonth.total)} adet ile zirve görüldü.` : 'Yeterli aylık veri bulunamadı.'}</div>
                    <div class="note"><strong>Ürün Mimarisi</strong>${report.models.length ? `${report.models.length} aktif model içinde ortalama liste fiyatı ${escapeHtml(formatCurrencyShort(report.avgPrice))} seviyesindedir.` : 'Portföy verisi sınırlı.'}</div>
                </div>
            </section>`
        ]
    );
}

function renderBrandCompareHtml(report) {
    const scoreSvg = buildMiniColumnSvg([
        { label: report.first.brand.name.slice(0, 6), value: report.first.currentSales },
        { label: report.second.brand.name.slice(0, 6), value: report.second.currentSales }
    ], { color: '#A72626' });
    const trendSvg = buildLineTrendSvg([
        { label: `${report.first.yearlyTrend[0]?.year || report.year - 2}`, value: report.first.yearlyTrend[0]?.total || 0 },
        { label: `${report.first.yearlyTrend[1]?.year || report.year - 1}`, value: report.first.yearlyTrend[1]?.total || 0 },
        { label: `${report.first.yearlyTrend[2]?.year || report.year}`, value: report.first.yearlyTrend[2]?.total || 0 }
    ], { color: '#2457C5' });
    const provinceSvg = buildBarChartSvg(report.provinceLead.map(item => ({ label: item.name, value: item.gap })), { color: '#2457C5' });
    const shareDonut = buildDonutSvg([
        { label: report.first.brand.name, value: report.first.currentSales },
        { label: report.second.brand.name, value: report.second.currentSales },
        { label: 'Diğerleri', value: Math.max(report.marketSales - report.first.currentSales - report.second.currentSales, 0) }
    ], { size: 260 });
    return wrapReportHtml(
        `${report.first.brand.name} vs ${report.second.brand.name}`,
        `${report.periodLabel} | Rekabet, il dağılımı, segment ve portföy karşılaştırması`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">${escapeHtml(report.first.brand.name)}</div><div class="value">${formatNumberTR(report.first.currentSales)}</div></div>
                <div class="kpi"><div class="label">${escapeHtml(report.second.brand.name)}</div><div class="value">${formatNumberTR(report.second.currentSales)}</div></div>
                <div class="kpi"><div class="label">Lider</div><div class="value">${escapeHtml(report.leader.brand.name)}</div></div>
                <div class="kpi"><div class="label">Fark</div><div class="value">${formatNumberTR(report.difference)}</div></div>
            </div>`,
            `<section class="section"><h2>Yönetici Özeti</h2><p>${escapeHtml(report.commentary || `${report.leader.brand.name}, ${report.periodLabel} döneminde rakibine göre daha güçlü bir performans sergilemiştir.`)}</p></section>`,
            `<section class="section"><h2>Rekabet Skor Kartı</h2><div class="split"><div class="chart">${scoreSvg}</div><div class="chart">${shareDonut}</div></div></section>`,
            `<section class="section"><h2>İl Bazlı Rekabet Boşluğu</h2><div class="chart">${provinceSvg}</div></section>`,
            `<section class="section"><h2>Trend ve Portföy</h2>
                <div class="split">
                    <div class="chart">${trendSvg}</div>
                    <div class="list-grid">
                        <div class="pill"><span class="mini">İl Üstünlüğü</span><strong>${escapeHtml(report.first.brand.name)} ${report.provinceWins.first} | ${escapeHtml(report.second.brand.name)} ${report.provinceWins.second}</strong></div>
                        <div class="pill"><span class="mini">Pay Farkı</span><strong>${formatShare(report.shareGap)} puan</strong></div>
                        <div class="pill"><span class="mini">Momentum Farkı</span><strong>${formatShare(report.yoyGap)} puan</strong></div>
                        <div class="pill"><span class="mini">Fiyat Farkı</span><strong>${escapeHtml(formatCurrencyShort(report.priceGap))}</strong></div>
                        <div class="pill"><span class="mini">${escapeHtml(report.first.brand.name)} Lider HP</span><strong>${escapeHtml(buildTopList(report.first.hpSegments, item => item.name, 3) || '-')}</strong></div>
                        <div class="pill"><span class="mini">${escapeHtml(report.second.brand.name)} Lider HP</span><strong>${escapeHtml(buildTopList(report.second.hpSegments, item => item.name, 3) || '-')}</strong></div>
                    </div>
                </div>
            </section>`
        ]
    );
}

function renderMarketOverviewHtml(report) {
    const brandsSvg = buildBarChartSvg(report.topBrands.map(item => ({ label: item.name, value: item.total })), { color: '#2457C5' });
    const hpSvg = buildMiniColumnSvg(report.hpSegments.map(item => ({ label: item.name, value: item.total })), { color: '#0F8F6E' });
    const concentrationDonut = buildDonutSvg([
        { label: 'Top 3 Marka', value: Math.round(report.currentSales * report.top3Share / 100) },
        { label: 'Diğerleri', value: Math.max(report.currentSales - Math.round(report.currentSales * report.top3Share / 100), 0) }
    ], { size: 250, colors: ['#2457C5', '#DCE4F2'] });
    return wrapReportHtml(
        `Türkiye Traktör Pazarı`,
        `${report.periodLabel} | Lider markalar, il dağılımı ve HP segment resmi`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">Toplam Pazar</div><div class="value">${formatNumberTR(report.currentSales)}</div></div>
                <div class="kpi"><div class="label">Yıllık Değişim</div><div class="value">${formatPctSigned(report.yoy)}</div></div>
                <div class="kpi"><div class="label">Lider Marka</div><div class="value">${escapeHtml(report.topBrands[0]?.name || '-')}</div></div>
                <div class="kpi"><div class="label">Lider İl</div><div class="value">${escapeHtml(report.topProvinces[0]?.name || '-')}</div></div>
            </div>`,
            `<section class="section"><h2>Yönetici Özeti</h2><p>${escapeHtml(report.commentary || `${report.periodLabel} döneminde pazar hacmi ${formatNumberTR(report.currentSales)} adede ulaşmıştır.`)}</p></section>`,
            `<section class="section"><h2>Pazar Konsantrasyonu</h2><div class="split"><div class="chart">${brandsSvg}</div><div class="chart">${concentrationDonut}</div></div></section>`,
            `<section class="section"><h2>Talep Segmentasyonu</h2><div class="split"><div class="chart">${hpSvg}</div><div class="list-grid">${report.categories.map(item => `<div class="pill"><span class="mini">${escapeHtml(item.name)}</span><strong>${formatNumberTR(item.total)} adet</strong></div>`).join('')}</div></div></section>`,
            `<section class="section"><h2>Lider İller</h2><ul>${report.topProvinces.map(item => `<li>${escapeHtml(item.name)}: ${formatNumberTR(item.total)} adet</li>`).join('')}</ul><p style="margin-top:14px;">Aktif il sayısı: <strong>${formatNumberTR(report.activeProvinceCount)}</strong></p></section>`
        ]
    );
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'traktor-sektor-analizi' });
    } catch {
        res.status(503).json({ status: 'error', message: 'Database bağlantı hatası' });
    }
});

app.get('/privacy-policy', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Privacy Policy</title></head>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>Gizlilik Politikasi</h1>
<p>StratejikPlan WhatsApp destekli traktör sektör analizi hizmeti, kullanicilarin gönderdigi mesajlari yalnizca soru-cevap hizmeti sunmak amaciyla isler.</p>
<p>Islenen veriler mesaj icerigi, gönderen numara, sorgu ve cevap kayitlari ile sinirlidir. Bu veriler hizmet sunumu, güvenlik ve hata ayiklama amaclariyla kullanilir.</p>
<p>Veriler yetkisiz kisilerle paylasilmaz; ancak WhatsApp Cloud API ve Groq gibi altyapi saglayicilar teknik isleme sürecinde kullanilabilir.</p>
<p>Veri silme talepleri icin <a href="/data-deletion">veri silme sayfasi</a> kullanilabilir.</p>
<p>Iletisim: yukselozdek@gmail.com</p>
</body></html>`);
});

app.get('/terms-of-service', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Terms of Service</title></head>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>Kullanim Kosullari</h1>
<p>Bu hizmet, traktör sektörü verileri üzerinde soru-cevap ve raporlama amaciyla sunulur.</p>
<p>Kullanici, hizmeti yasal amaçlarla kullanmayi kabul eder. Hizmet, mevcut veri kaynaklari ve üçüncü taraf servislerin sürekliligine baglidir.</p>
<p>Hizmet saglayici, veri kaynagi gecikmeleri veya üçüncü taraf servis kesintilerinden dogan dolayli zararlardan sorumlu tutulamaz.</p>
</body></html>`);
});

app.get('/data-deletion', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Data Deletion</title></head>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>Veri Silme Talebi</h1>
<p>Kullanici verilerinin silinmesini talep etmek icin yukselozdek@gmail.com adresine e-posta gönderebilir veya callback adresini kullanabilirsiniz.</p>
<p>Callback URL: <a href="/api/public/meta/data-deletion">/api/public/meta/data-deletion</a></p>
</body></html>`);
});

app.get('/api/public/meta/data-deletion', (req, res) => {
    res.json({
        url: 'https://affectionate-blessing-production-f2fe.up.railway.app/data-deletion',
        confirmation_code: 'sp-meta-deletion-request'
    });
});

app.post('/api/public/meta/data-deletion', (req, res) => {
    res.json({
        url: 'https://affectionate-blessing-production-f2fe.up.railway.app/data-deletion',
        confirmation_code: 'sp-meta-deletion-request'
    });
});

app.get('/public/reports/brand', async (req, res) => {
    try {
        const year = parseInt(req.query.year, 10);
        const brandKey = (req.query.brand || '').toString();
        const latestPeriod = await getLatestSalesPeriod();
        const brands = await getBrandCatalog();
        const brand = brands.find(item => item.slug === brandKey || normalizeSearchText(item.name) === normalizeSearchText(brandKey));
        if (!brand || !latestPeriod || !year) return res.status(404).send('Report not found');
        const report = await buildBrandExecutiveData(brand, year, latestPeriod);
        res.type('html').send(renderBrandExecutiveHtml(report));
    } catch (err) {
        console.error('Public brand report error:', err);
        res.status(500).send('Report error');
    }
});

app.get('/public/reports/compare', async (req, res) => {
    try {
        const year = parseInt(req.query.year, 10);
        const brand1Key = (req.query.brand1 || '').toString();
        const brand2Key = (req.query.brand2 || '').toString();
        const latestPeriod = await getLatestSalesPeriod();
        const brands = await getBrandCatalog();
        const brand1 = brands.find(item => item.slug === brand1Key || normalizeSearchText(item.name) === normalizeSearchText(brand1Key));
        const brand2 = brands.find(item => item.slug === brand2Key || normalizeSearchText(item.name) === normalizeSearchText(brand2Key));
        if (!brand1 || !brand2 || !latestPeriod || !year) return res.status(404).send('Report not found');
        const report = await buildBrandCompareExecutiveData([brand1, brand2], year, latestPeriod);
        res.type('html').send(renderBrandCompareHtml(report));
    } catch (err) {
        console.error('Public compare report error:', err);
        res.status(500).send('Report error');
    }
});

app.get('/public/reports/market', async (req, res) => {
    try {
        const year = parseInt(req.query.year, 10);
        const latestPeriod = await getLatestSalesPeriod();
        if (!latestPeriod || !year) return res.status(404).send('Report not found');
        const report = await buildMarketOverviewData(year, latestPeriod);
        res.type('html').send(renderMarketOverviewHtml(report));
    } catch (err) {
        console.error('Public market report error:', err);
        res.status(500).send('Report error');
    }
});

// ============================================
// PUBLIC ASSISTANT ENDPOINTS
// ============================================

// Versiyon kontrolü (deploy doğrulama)
app.get('/api/debug/version', (req, res) => {
    res.json({ version: 'smart-fallback-v6-13patterns', deployed: new Date().toISOString() });
});

// Groq API test endpoint'i — Groq çalışıyor mu?
app.get('/api/debug/groq-test', async (req, res) => {
    const question = req.query.q || 'New Holland ile Massey Ferguson karşılaştır';
    try {
        const t0 = Date.now();
        const latestPeriod = await getLatestSalesPeriod();
        const conversationCtx = '';
        const sql = await textToSql(question, conversationCtx);
        const elapsed = Date.now() - t0;

        if (!sql) {
            // Fallback da dene
            const fallbackSql = buildSmartFallbackSql(question, latestPeriod);
            return res.json({
                groqResult: 'FAILED',
                groqError: lastGroqError || 'unknown',
                elapsed: elapsed + 'ms',
                fallbackSql: fallbackSql ? fallbackSql.substring(0, 300) : 'NO_FALLBACK',
                groqApiKey: MINIMAX_API_KEY ? 'SET (' + MINIMAX_API_KEY.substring(0, 8) + '...)' : 'MISSING',
                question
            });
        }

        // SQL'i çalıştır
        const result = await executeSafeSql(sql);
        const interpretation = await interpretResults(question, sql, result, '');

        res.json({
            groqResult: 'OK',
            sql: sql.substring(0, 300),
            elapsed: elapsed + 'ms',
            rowCount: result.rowCount || 0,
            error: result.error || null,
            interpretation: interpretation ? interpretation.substring(0, 200) + '...' : 'NULL (ham format)',
            question
        });
    } catch (err) {
        res.json({ error: err.message, question });
    }
});

// Ciro motoru test endpoint'i
app.get('/api/debug/ciro-test', async (req, res) => {
    // 15 saniye genel timeout
    const timer = setTimeout(() => {
        if (!res.headersSent) res.status(504).json({ error: 'Endpoint timeout (15s)' });
    }, 15000);

    try {
        const brand = (req.query.brand || 'KUBOTA').toUpperCase();
        const year = parseInt(req.query.year) || 2023;
        const question = `${brand} markasının ${year} cirosu`;

        const latestPeriod = await getLatestSalesPeriod();
        const ciroSql = buildCiroSql(question, [], latestPeriod);

        if (!ciroSql) {
            clearTimeout(timer);
            return res.json({ error: 'buildCiroSql returned null', question, isCiroDetected: false });
        }

        const ciroResult = await executeSafeSql(ciroSql);

        // Timeout korumalı DB sorguları
        const teknikCheck = await Promise.race([
            pool.query('SELECT marka, COUNT(*) as model_count, AVG(fiyat_usd)::numeric(12,2) as avg_fiyat FROM teknik_veri WHERE UPPER(marka) ILIKE $1 AND fiyat_usd > 0 GROUP BY marka', [`%${brand}%`]),
            new Promise((_, rej) => setTimeout(() => rej(new Error('teknik_veri timeout')), 5000))
        ]).catch(e => ({ rows: [], error: e.message }));

        const brandsCheck = await Promise.race([
            pool.query('SELECT id, name FROM brands WHERE UPPER(name) ILIKE $1', [`%${brand}%`]),
            new Promise((_, rej) => setTimeout(() => rej(new Error('brands timeout')), 5000))
        ]).catch(e => ({ rows: [], error: e.message }));

        clearTimeout(timer);
        if (res.headersSent) return;

        return res.json({
            version: 'ciro-engine-v3',
            question,
            ciroSql: ciroSql.substring(0, 400),
            ciroResult: ciroResult.error ? { error: ciroResult.error } : { rows: ciroResult.rows, rowCount: ciroResult.rowCount },
            teknik_veri_check: teknikCheck.rows || [],
            teknik_veri_error: teknikCheck.error || null,
            brands_check: brandsCheck.rows || [],
            brands_error: brandsCheck.error || null
        });
    } catch (err) {
        clearTimeout(timer);
        if (!res.headersSent) res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
    }
});

app.post('/api/public/assistant/sales-query', async (req, res) => {
    try {
        if (WHATSAPP_QUERY_API_KEY) {
            const providedToken = req.headers['x-query-token'];
            if (providedToken !== WHATSAPP_QUERY_API_KEY) {
                return res.status(401).json({ error: 'Gecersiz sorgu token' });
            }
        }

        const question = (req.body.question || '').toString().trim();
        if (!question) {
            return res.status(400).json({ error: 'question alani gerekli' });
        }

        const result = await resolveAssistantQuestion(question, null);
        return res.json(result);
    } catch (err) {
        console.error('Public sales query error:', err);
        res.status(500).json({
            ok: false,
            error: 'Sunucu hatasi',
            answer: 'Sorgu islenirken beklenmeyen bir hata olustu.'
        });
    }
});

app.get('/api/public/whatsapp/webhook', async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    return res.status(403).send('verify token mismatch');
});


app.post('/api/public/whatsapp/webhook', async (req, res) => {
    // 1. Meta'ya anında yanıt ver (HTTP 200)
    res.status(200).json({ received: true });

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value || {};
        const message = value.messages?.[0];

        // Eğer mesaj değilse sessizce çık
        if (!message || message.type !== 'text') return;

        const question = message.text?.body?.trim();
        const from = message.from;
        const profileName = value.contacts?.[0]?.profile?.name || 'Bilinmiyor';

        if (!question || !from) return;

        console.log(`\n🟢 YENİ MESAJ -> Kimden: ${profileName} (${from}) | Soru: "${question}"\n`);

        // Kullanıcı mesajını konuşma hafızasına ekle
        addToConversation(from, 'user', question);
        const historyCount = getConversationHistory(from).length;
        console.log(`🧠 Konuşma hafızası: ${historyCount} mesaj (${from})`);

        console.log("🤖 Node.js AI (resolveAssistantQuestion) devreye giriyor...");

        try {
            // Yapay zeka soruyu SQL'e çevirip cevabı üretiyor (telefon numarası ile bağlam)
            const result = await resolveAssistantQuestion(question, from);
            console.log("✅ AI Cevabı Başarıyla Üretildi:", result.answer?.substring(0, 100));

            // Asistan cevabını konuşma hafızasına ekle
            addToConversation(from, 'assistant', result.answer || '');

            // Üretilen cevabı WhatsApp'a geri gönderiyor
            console.log("📤 AI Cevabı WhatsApp'a gönderiliyor...");
            const whatsappResponse = await sendWhatsAppTextMessage(from, result.answer || 'Anlayamadım, tekrar sorar mısınız?');
            console.log("✅ WhatsApp Gönderim Başarılı!");

        } catch (aiError) {
            console.error('❌ YZ veya WhatsApp Gönderim Hatası:', aiError.message, aiError.response?.data);
        }

    } catch (err) {
        console.error('❌ WhatsApp Webhook Genel İç Hatası:', err);
    }
});






// ============================================
// ============================================
// AUTH ENDPOINTS — Hardened (rate limit, lock, Google OAuth, email verify)
// ============================================
const SUPERUSER_EMAILS = new Set(['yukselozdek@gmail.com']);
const PASSWORD_POLICY = /^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
const LOGIN_LIMITER = rateLimit({
    windowMs: 5 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla giriş denemesi. 5 dakika bekleyin.' }
});
const SIGNUP_LIMITER = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Çok fazla kayıt denemesi. 1 saat bekleyin.' }
});

async function logAuthAudit(userId, event, req, metadata = {}) {
    try {
        await pool.query(
            `INSERT INTO auth_audit (user_id, event, ip_address, user_agent, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [userId || null, event, req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 500), JSON.stringify(metadata)]
        );
    } catch (e) { /* sessiz */ }
}

function buildUserPayload(user) {
    return {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        is_superuser: !!user.is_superuser,
        brand_id: user.brand_id,
        company_name: user.company_name,
        job_title: user.job_title,
        email_verified: !!user.email_verified,
        preview_plan_slug: user.preview_plan_slug || null,
        brand: user.brand_name ? {
            name: user.brand_name, slug: user.brand_slug,
            primary_color: user.primary_color, secondary_color: user.secondary_color,
            accent_color: user.accent_color, text_color: user.text_color,
            logo_url: user.logo_url
        } : null
    };
}

function issueAuthToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, sup: !!user.is_superuser },
        JWT_SECRET, { expiresIn: '30d' }
    );
}

app.post('/api/auth/login', LOGIN_LIMITER, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        if (!email || !password) return res.status(400).json({ error: 'Email ve şifre gerekli' });

        const result = await pool.query(`
            SELECT u.*, b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color, b.accent_color, b.text_color, b.logo_url
            FROM users u LEFT JOIN brands b ON u.brand_id = b.id
            WHERE u.email = $1 AND u.is_active = true
        `, [email]);

        if (result.rows.length === 0) {
            await logAuthAudit(null, 'login_failed_unknown', req, { email });
            return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });
        }

        const user = result.rows[0];
        // Hesap kilidi kontrolü
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            await logAuthAudit(user.id, 'login_blocked_locked', req);
            const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            return res.status(423).json({ error: `Hesabınız ${mins} dakika kilitli. Çok fazla başarısız deneme.` });
        }

        const validPassword = user.password_hash ? await bcrypt.compare(password, user.password_hash) : false;
        if (!validPassword) {
            const newCount = (user.failed_login_count || 0) + 1;
            const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
            await pool.query(
                `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
                [newCount, lockUntil, user.id]
            );
            await logAuthAudit(user.id, 'login_failed', req, { count: newCount });
            return res.status(401).json({ error: 'Geçersiz kimlik bilgileri', attempts_left: Math.max(0, 5 - newCount) });
        }

        // Başarılı login: sayaçları sıfırla, last_login güncelle
        await pool.query(
            `UPDATE users SET last_login = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
            [user.id]
        );
        // Superuser otomatik bayrak
        if (SUPERUSER_EMAILS.has(email) && !user.is_superuser) {
            await pool.query(`UPDATE users SET is_superuser = true, role = 'admin' WHERE id = $1`, [user.id]);
            user.is_superuser = true; user.role = 'admin';
        }

        await logAuthAudit(user.id, 'login_success', req);
        const token = issueAuthToken(user);
        res.json({ token, user: buildUserPayload(user) });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// SIGNUP — güçlü şifre + zorunlu marka + firma alanları
// ============================================
app.post('/api/auth/signup', SIGNUP_LIMITER, async (req, res) => {
    try {
        const {
            email: rawEmail, password, full_name, brand_id, plan_slug,
            company_name, company_tax_office, company_tax_number,
            job_title, dealer_or_distributor, phone, city
        } = req.body || {};

        const email = String(rawEmail || '').trim().toLowerCase();
        if (!email || !password || !full_name || !brand_id || !company_name || !job_title) {
            return res.status(400).json({ error: 'E-posta, şifre, ad-soyad, marka, firma adı ve unvan zorunludur' });
        }
        if (!PASSWORD_POLICY.test(String(password))) {
            return res.status(400).json({ error: 'Şifre en az 10 karakter, 1 büyük harf, 1 sayı ve 1 özel karakter içermeli' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
        }

        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            await logAuthAudit(null, 'signup_email_taken', req, { email });
            return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı' });
        }

        const brandCheck = await pool.query('SELECT id, name FROM brands WHERE id = $1 AND is_active = true', [Number(brand_id)]);
        if (brandCheck.rows.length === 0) return res.status(400).json({ error: 'Geçersiz marka seçimi' });

        const isSuperuser = SUPERUSER_EMAILS.has(email);
        const role = isSuperuser ? 'admin' : 'brand_user';
        const verifyToken = crypto.randomBytes(24).toString('hex');
        const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const hash = await bcrypt.hash(password, 12);

        const userInsert = await pool.query(
            `INSERT INTO users
                (email, password_hash, full_name, phone, role, brand_id, company_name, company_tax_office,
                 company_tax_number, job_title, dealer_or_distributor, city, is_active,
                 auth_provider, email_verified, email_verify_token, email_verify_expires, is_superuser)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, 'password', $13, $14, $15, $16)
             RETURNING id, email, full_name, role, brand_id, company_name, job_title, is_superuser, email_verified`,
            [
                email, hash, full_name, phone || null, role, Number(brand_id),
                company_name, company_tax_office || null, company_tax_number || null,
                job_title, dealer_or_distributor || 'bayi', city || null,
                isSuperuser, // email_verified true if superuser
                isSuperuser ? null : verifyToken,
                isSuperuser ? null : verifyExpires,
                isSuperuser
            ]
        );
        const newUser = userInsert.rows[0];

        // Plan seçimi varsa pending abonelik aç
        let pendingSub = null;
        if (plan_slug) {
            const planRes = await pool.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1 AND is_active = true', [String(plan_slug).toLowerCase()]);
            if (planRes.rows.length > 0) {
                const subInsert = await pool.query(
                    `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id, plan_id, status`,
                    [newUser.id, planRes.rows[0].id]
                );
                pendingSub = { ...subInsert.rows[0], plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
            }
        }

        await logAuthAudit(newUser.id, 'signup_password', req, { brand_id: Number(brand_id), plan: plan_slug || null });
        const token = issueAuthToken(newUser);
        res.status(201).json({
            token,
            user: buildUserPayload(newUser),
            pending_subscription: pendingSub,
            email_verify_required: !isSuperuser,
            verify_token_dev: process.env.NODE_ENV !== 'production' ? verifyToken : undefined
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Kayıt başarısız' });
    }
});

// ============================================
// GOOGLE OAUTH — ID token doğrulama
// ============================================
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';

async function verifyGoogleIdToken(idToken) {
    // Google'ın tokeninfo endpoint'i ile minimal doğrulama (production'da google-auth-library tercih edilir)
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
        signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('Google token doğrulanamadı');
    const data = await r.json();
    if (!data.email || data.email_verified !== 'true') throw new Error('Google e-posta doğrulanmamış');
    if (GOOGLE_OAUTH_CLIENT_ID && data.aud !== GOOGLE_OAUTH_CLIENT_ID) throw new Error('Google client ID eşleşmiyor');
    return {
        email: String(data.email).toLowerCase(),
        google_id: data.sub,
        full_name: data.name || data.email,
        picture: data.picture || null
    };
}

app.post('/api/auth/google', LOGIN_LIMITER, async (req, res) => {
    try {
        const { id_token, brand_id, plan_slug, company_name, job_title } = req.body || {};
        if (!id_token) return res.status(400).json({ error: 'id_token gerekli' });

        const profile = await verifyGoogleIdToken(id_token).catch(err => {
            throw new Error(err.message || 'Google doğrulama hatası');
        });

        // Mevcut kullanıcı var mı?
        let user = (await pool.query(
            `SELECT u.*, b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color, b.accent_color, b.text_color, b.logo_url
             FROM users u LEFT JOIN brands b ON u.brand_id = b.id WHERE u.email = $1`,
            [profile.email]
        )).rows[0];

        if (user) {
            // Mevcut hesabı Google'a bağla (varsa güncelle)
            if (!user.google_id) {
                await pool.query(`UPDATE users SET google_id = $1, auth_provider = 'google', email_verified = true WHERE id = $2`,
                    [profile.google_id, user.id]);
            }
            await pool.query(`UPDATE users SET last_login = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
            // Superuser
            if (SUPERUSER_EMAILS.has(profile.email) && !user.is_superuser) {
                await pool.query(`UPDATE users SET is_superuser = true, role = 'admin', email_verified = true WHERE id = $1`, [user.id]);
                user.is_superuser = true; user.role = 'admin';
            }
            await logAuthAudit(user.id, 'login_google', req);
            return res.json({ token: issueAuthToken(user), user: buildUserPayload(user), is_new: false });
        }

        // Yeni kullanıcı: marka + firma + unvan zorunlu
        if (!brand_id || !company_name || !job_title) {
            return res.status(202).json({
                code: 'GOOGLE_NEEDS_PROFILE',
                google_email: profile.email,
                google_name: profile.full_name,
                message: 'Google ile kayıt için marka, firma ve unvan bilgisi gerekli'
            });
        }
        const brandCheck = await pool.query('SELECT id FROM brands WHERE id = $1 AND is_active = true', [Number(brand_id)]);
        if (brandCheck.rows.length === 0) return res.status(400).json({ error: 'Geçersiz marka' });

        const isSuperuser = SUPERUSER_EMAILS.has(profile.email);
        const ins = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name, job_title,
                                auth_provider, google_id, email_verified, is_superuser)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'google', $7, true, $8)
             RETURNING *`,
            [profile.email, profile.full_name, isSuperuser ? 'admin' : 'brand_user',
             Number(brand_id), company_name, job_title, profile.google_id, isSuperuser]
        );
        const newUser = ins.rows[0];

        let pendingSub = null;
        if (plan_slug) {
            const planRes = await pool.query('SELECT id, slug, name FROM subscription_plans WHERE slug = $1', [String(plan_slug).toLowerCase()]);
            if (planRes.rows.length > 0) {
                const subIns = await pool.query(
                    `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start)
                     VALUES ($1, $2, 'pending', NOW()) RETURNING id`,
                    [newUser.id, planRes.rows[0].id]
                );
                pendingSub = { id: subIns.rows[0].id, plan_slug: planRes.rows[0].slug, plan_name: planRes.rows[0].name };
            }
        }

        await logAuthAudit(newUser.id, 'signup_google', req, { brand_id: Number(brand_id) });
        res.status(201).json({
            token: issueAuthToken(newUser),
            user: buildUserPayload(newUser),
            is_new: true,
            pending_subscription: pendingSub
        });
    } catch (err) {
        console.error('Google auth error:', err);
        res.status(401).json({ error: err.message || 'Google girişi başarısız' });
    }
});

// Google OAuth client ID (frontend için)
app.get('/api/auth/google-config', (req, res) => {
    res.json({ client_id: GOOGLE_OAUTH_CLIENT_ID || null });
});

// Email verify
app.get('/api/auth/verify-email', async (req, res) => {
    try {
        const token = String(req.query.token || '');
        if (!token) return res.status(400).json({ error: 'token gerekli' });
        const r = await pool.query(
            `UPDATE users SET email_verified = true, email_verify_token = NULL, email_verify_expires = NULL
             WHERE email_verify_token = $1 AND email_verify_expires > NOW() RETURNING id, email`,
            [token]
        );
        if (r.rows.length === 0) return res.status(400).send('<h2>Token geçersiz veya süresi doldu</h2>');
        res.send(`<h2>E-postanız doğrulandı: ${r.rows[0].email}</h2><p><a href="/login.html">Giriş yap</a></p>`);
    } catch (err) { res.status(500).send('Hata'); }
});

// Superuser preview plan switch (yukselozdek için)
app.post('/api/auth/preview-plan', authMiddleware, async (req, res) => {
    try {
        if (!req.user.sup && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Sadece superuser önizleme planını değiştirebilir' });
        }
        const { plan_slug } = req.body || {};
        if (!['starter', 'growth', 'enterprise', null, ''].includes(plan_slug || null)) {
            return res.status(400).json({ error: 'Geçersiz plan_slug' });
        }
        await pool.query(`UPDATE users SET preview_plan_slug = $1 WHERE id = $2`, [plan_slug || null, req.user.id]);
        res.json({ success: true, preview_plan_slug: plan_slug || null });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.email, u.full_name, u.role, u.brand_id, u.company_name, u.job_title,
                   u.is_superuser, u.email_verified, u.preview_plan_slug, u.city,
                   b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color,
                   b.accent_color, b.text_color, b.logo_url
            FROM users u LEFT JOIN brands b ON u.brand_id = b.id
            WHERE u.id = $1
        `, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        const u = result.rows[0];
        res.json({
            ...u,
            brand: u.brand_name ? {
                name: u.brand_name, slug: u.brand_slug,
                primary_color: u.primary_color, secondary_color: u.secondary_color,
                accent_color: u.accent_color, text_color: u.text_color,
                logo_url: u.logo_url
            } : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// GEAR CONFIGS (Şanzıman Tipleri - teknik_veri'den canlı)
// ============================================
app.get('/api/gear-configs', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`SELECT DISTINCT vites_sayisi FROM teknik_veri WHERE vites_sayisi IS NOT NULL AND TRIM(vites_sayisi) != '' ORDER BY vites_sayisi`);
        res.json(result.rows.map(r => r.vites_sayisi));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// MAP FILTER OPTIONS (Kaskat Filtreler - sales_view'dan canlı)
// Her filtre, kendisi HARİÇ diğer filtrelere göre mevcut seçenekleri döner
// ============================================
app.get('/api/map-filter-options', authMiddleware, async (req, res) => {
    try {
        const { year, brand_id, cabin_type, drive_type, hp_range, gear_config } = req.query;
        const userBrandIdResolved = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
        const targetYearInt = year && year !== 'all' ? parseInt(year, 10) : null;

        const normalizedBrandExprNew = `
            CASE
                WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KÄ°OTÄ°'
                ELSE tv.marka
            END
        `;
        const hpRangeExprNew = `
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
        const cabinTypeExprNew = `
            CASE
                WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%rops%' OR LOWER(COALESCE(tk.koruma, '')) LIKE '%roll%' THEN 'rollbar'
                ELSE NULL
            END
        `;

        const mapFilterDefs = [
            { key: 'cabin_type', expr: cabinTypeExprNew, val: cabin_type || null },
            { key: 'drive_type', expr: `LOWER(COALESCE(tk.cekis_tipi, ''))`, val: drive_type ? String(drive_type).toLowerCase() : null },
            { key: 'hp_range', expr: hpRangeExprNew, val: hp_range || null },
            { key: 'gear_config', expr: `COALESCE(tk.vites_sayisi, '')`, val: gear_config || null }
        ];

        const buildMapWhere = (excludeKey) => {
            let where = '1=1';
            const params = [];

            if (Number.isFinite(targetYearInt)) {
                params.push(targetYearInt);
                where += ` AND tv.tescil_yil = $${params.length}`;
            }
            if (userBrandIdResolved) {
                params.push(userBrandIdResolved);
                where += ` AND b.id = $${params.length}`;
            }
            for (const filterDef of mapFilterDefs) {
                if (filterDef.key === excludeKey || !filterDef.val) continue;
                params.push(filterDef.val);
                where += ` AND ${filterDef.expr} = $${params.length}`;
            }

            return { where, params };
        };

        const mapOptionQueries = mapFilterDefs.map(filterDef => {
            const { where, params } = buildMapWhere(filterDef.key);
            return pool.query(`
                SELECT DISTINCT ${filterDef.expr} AS val
                FROM tuik_veri tv
                JOIN brands b
                    ON UPPER(b.name) = UPPER(${normalizedBrandExprNew})
                LEFT JOIN teknik_veri tk
                    ON UPPER(tk.marka) = UPPER(${normalizedBrandExprNew})
                   AND UPPER(tk.tuik_model_adi) = UPPER(tv.tuik_model_adi)
                WHERE ${where}
                  AND ${filterDef.expr} IS NOT NULL
                  AND ${filterDef.expr} != ''
            `, params);
        });

        const mapOptionResults = await Promise.all(mapOptionQueries);
        const sortHpMap = (a, b) => {
            const na = parseInt(a, 10);
            const nb = parseInt(b, 10);
            return (isNaN(na) ? 999 : na) - (isNaN(nb) ? 999 : nb);
        };

        return res.json({
            cabin_types: mapOptionResults[0].rows.map(r => r.val).sort(),
            drive_types: mapOptionResults[1].rows.map(r => r.val).sort(),
            hp_ranges: mapOptionResults[2].rows.map(r => r.val).sort(sortHpMap),
            gear_configs: mapOptionResults[3].rows.map(r => r.val).sort()
        });
        const targetYear = year || new Date().getFullYear();

        const filterDefs = [
            { key: 'cabin_type', col: 's.cabin_type', val: cabin_type },
            { key: 'drive_type', col: 's.drive_type', val: drive_type },
            { key: 'hp_range', col: 's.hp_range', val: hp_range },
            { key: 'gear_config', col: 's.gear_config', val: gear_config }
        ];

        // Her filtre için: diğer filtreler aktifken o kolonun DISTINCT değerlerini çek
        const buildQuery = (excludeKey) => {
            let where = 's.year = $1';
            const params = [targetYear];
            if (brand_id) { params.push(brand_id); where += ` AND s.brand_id = $${params.length}`; }
            for (const f of filterDefs) {
                if (f.key === excludeKey) continue;
                if (f.val) { params.push(f.val); where += ` AND ${f.col} = $${params.length}`; }
            }
            return { where, params };
        };

        const queries = filterDefs.map(f => {
            const { where, params } = buildQuery(f.key);
            return pool.query(`SELECT DISTINCT ${f.col} as val FROM sales_view s WHERE ${where} AND ${f.col} IS NOT NULL AND ${f.col} != ''`, params);
        });

        const results = await Promise.all(queries);

        const sortHp = (a, b) => { const na = parseInt(a); const nb = parseInt(b); return (isNaN(na) ? 999 : na) - (isNaN(nb) ? 999 : nb); };

        res.json({
            cabin_types: results[0].rows.map(r => r.val).sort(),
            drive_types: results[1].rows.map(r => r.val).sort(),
            hp_ranges: results[2].rows.map(r => r.val).sort(sortHp),
            gear_configs: results[3].rows.map(r => r.val).sort()
        });
    } catch (err) {
        console.error('Map filter options error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// BRANDS
// ============================================
app.get('/api/tuik/years', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT tescil_yil AS year
            FROM tuik_veri
            WHERE tescil_yil IS NOT NULL
            ORDER BY tescil_yil ASC
        `);
        res.json(
            result.rows
                .map(row => parseInt(row.year, 10))
                .filter(Number.isFinite)
        );
    } catch (err) {
        console.error('Tuik years error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

async function ensureProvincesSeeded() {
    const { provinces } = require('./database/seed-data');
    const countRes = await pool.query('SELECT COUNT(*)::int AS count FROM provinces');
    const currentCount = parseInt(countRes.rows[0]?.count || 0, 10);

    if (currentCount >= provinces.length) {
        return;
    }

    for (const province of provinces) {
        await pool.query(`
            INSERT INTO provinces (name, plate_code, region, latitude, longitude, population)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (plate_code) DO UPDATE SET
                name = EXCLUDED.name,
                region = EXCLUDED.region,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                population = COALESCE(provinces.population, EXCLUDED.population)
        `, [
            province.name,
            province.plate_code,
            province.region,
            province.lat,
            province.lng,
            province.pop
        ]);
    }
}

app.get('/api/brand-portals/directory', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                b.id,
                b.name,
                b.slug,
                b.logo_url,
                b.primary_color,
                b.secondary_color,
                b.accent_color,
                COALESCE(p.tagline, CONCAT(b.name, ' icin ozel marka deneyimi')) AS tagline,
                COALESCE(p.website_url, b.website, '') AS website_url,
                COUNT(m.id)::int AS model_count
            FROM brands b
            LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
            LEFT JOIN tractor_models m ON m.brand_id = b.id AND m.is_current_model = true
            WHERE b.is_active = true
            GROUP BY b.id, b.name, b.slug, b.logo_url, b.primary_color, b.secondary_color, b.accent_color, p.tagline, p.website_url, b.website
            ORDER BY b.name
        `);

        res.json(normalizeTurkishDisplayObject(result.rows.map(row => {
            const publicSlug = getCanonicalBrandPortalSlug(row.name);
            return {
                ...row,
                slug: publicSlug,
                entry_url: `/giris/${publicSlug}`
            };
        })));
    } catch (err) {
        console.error('Brand portal directory error:', err);
        res.status(500).json({ error: 'Sunucu hatasi' });
    }
});

app.get('/api/brand-portals/public/:brandSlug', async (req, res) => {
    try {
        const bundle = await getBrandPortalBase({ brandSlug: req.params.brandSlug });
        if (!bundle) {
            return res.status(404).json({ error: 'Marka bulunamadı' });
        }

        res.json(normalizeTurkishDisplayObject({
            ...bundle,
            entry_url: `/giris/${bundle.brand.slug}`
        }));
    } catch (err) {
        console.error('Public brand portal error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/brand-portal', authMiddleware, async (req, res) => {
    try {
        let selectedBrandId = req.user.role === 'admin'
            ? (req.query.brand_id ? parseInt(req.query.brand_id, 10) : null)
            : parseInt(req.user.brand_id || 0, 10);

        if (!selectedBrandId && req.user.role === 'admin') {
            const fallbackBrandRes = await pool.query('SELECT id FROM brands WHERE is_active = true ORDER BY name LIMIT 1');
            selectedBrandId = parseInt(fallbackBrandRes.rows[0]?.id || 0, 10);
        }

        if (!selectedBrandId) {
            return res.status(400).json({ error: 'brand_id gerekli' });
        }

        const bundle = await getBrandPortalBase({ brandId: selectedBrandId });
        if (!bundle) {
            return res.status(404).json({ error: 'Marka bulunamadı' });
        }

        const { maxYear, maxMonth, prevYear } = await getLatestSalesPeriod();
        if (!maxYear || !maxMonth) {
            return res.json(normalizeTurkishDisplayObject({
                ...bundle,
                latest_period: null,
                sales: {
                    total_sales: 0,
                    prev_sales: 0,
                    yoy_pct: null,
                    active_provinces: 0,
                    market_share_pct: null,
                    ranking: null,
                    top_provinces: [],
                    monthly_trend: [],
                    category_mix: [],
                    region_mix: []
                }
            }));
        }

        const brandId = bundle.brand.id;

        const [
            salesSummaryRes,
            previousSalesRes,
            marketTotalRes,
            rankingRes,
            topProvincesRes,
            monthlyTrendRes,
            categoryMixRes,
            regionMixRes
        ] = await Promise.all([
            pool.query(`
                SELECT
                    COALESCE(SUM(quantity), 0)::int AS total_sales,
                    COUNT(DISTINCT province_id)::int AS active_provinces
                FROM sales_view
                WHERE brand_id = $1 AND year = $2 AND month <= $3
            `, [brandId, maxYear, maxMonth]),
            pool.query(`
                SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                FROM sales_view
                WHERE brand_id = $1 AND year = $2 AND month <= $3
            `, [brandId, prevYear, maxMonth]),
            pool.query(`
                SELECT COALESCE(SUM(quantity), 0)::int AS total_sales
                FROM sales_view
                WHERE year = $1 AND month <= $2
            `, [maxYear, maxMonth]),
            pool.query(`
                WITH ranked AS (
                    SELECT
                        brand_id,
                        SUM(quantity) AS total_sales,
                        DENSE_RANK() OVER (ORDER BY SUM(quantity) DESC) AS rank
                    FROM sales_view
                    WHERE year = $1 AND month <= $2
                    GROUP BY brand_id
                )
                SELECT rank, total_sales
                FROM ranked
                WHERE brand_id = $3
            `, [maxYear, maxMonth, brandId]),
            pool.query(`
                SELECT p.name AS province_name, p.region AS region_name, SUM(s.quantity)::int AS total_sales
                FROM sales_view s
                JOIN provinces p ON p.id = s.province_id
                WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3
                GROUP BY p.id, p.name, p.region
                ORDER BY total_sales DESC, p.name ASC
                LIMIT 6
            `, [brandId, maxYear, maxMonth]),
            pool.query(`
                SELECT month, SUM(quantity)::int AS total_sales
                FROM sales_view
                WHERE brand_id = $1 AND year = $2
                GROUP BY month
                ORDER BY month
            `, [brandId, maxYear]),
            pool.query(`
                SELECT COALESCE(category, 'belirsiz') AS label, SUM(quantity)::int AS total_sales
                FROM sales_view
                WHERE brand_id = $1 AND year = $2 AND month <= $3
                GROUP BY category
                ORDER BY total_sales DESC, label ASC
            `, [brandId, maxYear, maxMonth]),
            pool.query(`
                SELECT p.region AS region_name, SUM(s.quantity)::int AS total_sales
                FROM sales_view s
                JOIN provinces p ON p.id = s.province_id
                WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3
                GROUP BY p.region
                ORDER BY total_sales DESC, p.region ASC
            `, [brandId, maxYear, maxMonth])
        ]);

        const currentSales = parseInt(salesSummaryRes.rows[0]?.total_sales || 0, 10);
        const previousSales = parseInt(previousSalesRes.rows[0]?.total_sales || 0, 10);
        const marketTotal = parseInt(marketTotalRes.rows[0]?.total_sales || 0, 10);
        const rankingRow = rankingRes.rows[0] || {};
        const regionMix = regionMixRes.rows.map(row => ({
            region_name: row.region_name,
            total_sales: parseInt(row.total_sales, 10)
        }));
        const executiveReport = await buildBrandExecutiveReport(bundle.brand, {
            maxYear,
            maxMonth,
            prevYear,
            profile: bundle.profile,
            items: bundle.items,
            contacts: bundle.contacts
        });

        if ((!bundle.profile.focus_regions || bundle.profile.focus_regions.length === 0) && regionMix.length > 0) {
            bundle.profile.focus_regions = regionMix.slice(0, 4).map(item => ({
                region: item.region_name,
                note: `${formatNumberTR(item.total_sales)} adet ile son dönemin odak bölgesi`
            }));
        }

        res.json(normalizeTurkishDisplayObject({
            ...bundle,
            latest_period: {
                year: maxYear,
                month: maxMonth,
                label: formatPeriodLabel(maxYear, maxMonth, maxYear, maxMonth)
            },
            sales: {
                total_sales: currentSales,
                prev_sales: previousSales,
                yoy_pct: calculateYoY(currentSales, previousSales),
                active_provinces: parseInt(salesSummaryRes.rows[0]?.active_provinces || 0, 10),
                market_share_pct: marketTotal > 0 ? Number(((currentSales * 100) / marketTotal).toFixed(1)) : null,
                ranking: rankingRow.rank ? parseInt(rankingRow.rank, 10) : null,
                top_provinces: topProvincesRes.rows.map(row => ({
                    province_name: row.province_name,
                    region_name: row.region_name,
                    total_sales: parseInt(row.total_sales, 10)
                })),
                monthly_trend: monthlyTrendRes.rows.map(row => ({
                    month: parseInt(row.month, 10),
                    total_sales: parseInt(row.total_sales, 10)
                })),
                category_mix: categoryMixRes.rows.map(row => ({
                    label: row.label,
                    total_sales: parseInt(row.total_sales, 10)
                })),
                region_mix: regionMix
            },
            executive_report: executiveReport
        }));
    } catch (err) {
        console.error('Brand portal error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/brands', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM brands WHERE is_active = true ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/brands/:slug', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM brands WHERE slug = $1', [req.params.slug]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Marka bulunamadı' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// PROVINCES
// ============================================
app.get('/api/provinces', authMiddleware, async (req, res) => {
    try {
        await ensureProvincesSeeded();
        const { region } = req.query;
        let query = 'SELECT * FROM provinces';
        const params = [];
        if (region) { query += ' WHERE region = $1'; params.push(region); }
        query += ' ORDER BY name';
        const result = await pool.query(query, params);
        res.json(result.rows.map(row => enrichProvinceWithReference(row)));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

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
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// TRACTOR MODELS
// ============================================
const MODEL_INTEL_ALLOWED_EXTERNAL_HOSTS = new Set([
    'www.tr.lectura-specs.com',
    'tr.lectura-specs.com',
    'www.lectura-specs.com',
    'lectura-specs.com'
]);

function toUpperPlain(value = '') {
    return String(value || '').trim().toUpperCase();
}

function normalizeBrandAliasesForModelIntel(brandName = '') {
    const raw = String(brandName || '').trim();
    const upper = toUpperPlain(raw);
    const aliases = new Set([upper]);

    if (upper === 'CASE') aliases.add('CASE IH');
    if (upper === 'CASE IH') aliases.add('CASE');
    if (upper === 'DEUTZ') aliases.add('DEUTZ-FAHR');
    if (upper === 'DEUTZ-FAHR') aliases.add('DEUTZ');
    if (upper === 'KIOTI' || upper === 'KİOTİ') {
        aliases.add('KIOTI');
        aliases.add('KİOTİ');
    }

    return [...aliases].filter(Boolean);
}

function normalizeModelSearch(value = '') {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTurkishSearchKey(value = '') {
    return String(value || '')
        .trim()
        .toLocaleUpperCase('tr-TR')
        .replace(/[İIı]/g, 'I')
        .replace(/[Ş]/g, 'S')
        .replace(/[Ğ]/g, 'G')
        .replace(/[Ü]/g, 'U')
        .replace(/[Ö]/g, 'O')
        .replace(/[Ç]/g, 'C')
        .replace(/\s+/g, ' ');
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function formatModelIntelUsd(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '-';
    return `${Math.round(numeric).toLocaleString('tr-TR')} $`;
}

function compactModelIntelText(value = '') {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeBasicHtmlEntities(value = '') {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&uuml;/gi, 'ü')
        .replace(/&Uuml;/g, 'Ü')
        .replace(/&ouml;/gi, 'ö')
        .replace(/&Ouml;/g, 'Ö')
        .replace(/&ccedil;/gi, 'ç')
        .replace(/&Ccedil;/g, 'Ç')
        .replace(/&scedil;/gi, 'ş')
        .replace(/&Scedil;/g, 'Ş')
        .replace(/&imath;/gi, 'ı')
        .replace(/&Idot;/g, 'İ')
        .replace(/&acirc;/gi, 'â')
        .replace(/&Acirc;/g, 'Â');
}

function htmlToModelIntelLines(html = '') {
    const withoutBlocks = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    return decodeBasicHtmlEntities(withoutBlocks)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|dt|dd)>/gi, '\n')
        .replace(/<[^>]+>/g, '\n')
        .split(/\n+/)
        .map(compactModelIntelText)
        .filter(Boolean);
}

function extractMetaContent(html = '', property = '') {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const altRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
    const match = String(html || '').match(regex) || String(html || '').match(altRegex);
    return match ? decodeBasicHtmlEntities(match[1]) : '';
}

function getNextLineValue(lines = [], label = '') {
    const target = toUpperPlain(label).replace(/\s+/g, ' ');
    for (let i = 0; i < lines.length; i += 1) {
        const current = toUpperPlain(lines[i]).replace(/\s+/g, ' ');
        if (current === target || current.replace(/:$/, '') === target.replace(/:$/, '')) {
            const next = lines[i + 1] || '';
            if (next && !toUpperPlain(next).startsWith(target)) return next;
        }
    }
    return '';
}

function parseExternalModelSourceHtml(html = '', sourceUrl = '') {
    const title = extractMetaContent(html, 'og:title')
        || decodeBasicHtmlEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description');
    const imageUrl = extractMetaContent(html, 'og:image') || '';
    const lines = htmlToModelIntelLines(html);

    const lecturaLabels = [
        'Motor gücü',
        'Model Serisi',
        'Geri lastikler',
        'Ön lastikler',
        'Transmisyon',
        'Ağırlık',
        'Kontrol ünitesi',
        'Motor imalatçısı',
        'Motor tipi',
        'Deplasman',
        'Maks torkta devirler',
        'Maks. dönme momenti',
        'Silindir sayısı',
        'Emisyon seviyesi',
        'Üç nokta kategorisi',
        'Kabin',
        'Ön hdrolikler',
        'Ön PTO',
        'Hava Frenleri',
        'ISO otobüs',
        'Klima'
    ];

    const specs = lecturaLabels
        .map(label => ({ label, value: getNextLineValue(lines, label) }))
        .filter(item => item.value);

    return {
        provider: 'LECTURA Specs',
        url: sourceUrl,
        status: specs.length ? 'ok' : 'partial',
        title: compactModelIntelText(title),
        description: compactModelIntelText(description),
        image_url: imageUrl,
        specs,
        fetched_at: new Date().toISOString()
    };
}

async function fetchExternalModelSource(sourceUrl = '') {
    if (!sourceUrl) return null;

    let parsedUrl;
    try {
        parsedUrl = new URL(sourceUrl);
    } catch {
        return { status: 'error', error: 'Kaynak URL formatı geçersiz', url: sourceUrl };
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (parsedUrl.protocol !== 'https:' || !MODEL_INTEL_ALLOWED_EXTERNAL_HOSTS.has(host)) {
        const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
        if (fallback) return fallback;
        return {
            status: 'blocked',
            error: 'Canlı okuma şu anda yalnızca LECTURA Specs HTTPS kaynaklarıyla sınırlandırıldı',
            url: sourceUrl
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    try {
        const response = await fetch(parsedUrl.toString(), {
            signal: controller.signal,
            headers: {
                'User-Agent': 'TraktorSektorAnalizi/1.0 model-intelligence',
                'Accept': 'text/html,application/xhtml+xml'
            }
        });
        if (!response.ok) {
            const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
            if (fallback) return fallback;
            return { status: 'error', error: `Kaynak HTTP ${response.status}`, url: sourceUrl };
        }
        const html = await response.text();
        return parseExternalModelSourceHtml(html, parsedUrl.toString());
    } catch (err) {
        const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
        if (fallback) return fallback;
        return {
            status: 'error',
            error: err.name === 'AbortError' ? 'Kaynak okuma zaman aşımına uğradı' : err.message,
            url: sourceUrl
        };
    } finally {
        clearTimeout(timer);
    }
}

function inferKnownModelSourceUrl(brandName = '', modelName = '') {
    const combined = `${brandName} ${modelName}`.toUpperCase();
    if (combined.includes('CLAAS') && combined.includes('ARION') && combined.includes('450')) {
        return 'https://www.tr.lectura-specs.com/tr/model/tarim-makinalari/traktorler-4wd-claas/arion-450-trend-11756863';
    }
    if ((combined.includes('TÜMOSAN') || combined.includes('TUMOSAN')) && combined.includes('8110')) {
        return 'https://www.tumosan.com.tr/tr/urunler/8110';
    }
    return '';
}

function getKnownExternalModelSourceFallback(sourceUrl = '') {
    const normalizedSourceUrl = String(sourceUrl || '').toLowerCase();
    if (normalizedSourceUrl.includes('tumosan.com.tr') && normalizedSourceUrl.includes('/urunler/8110')) {
        return {
            provider: 'Tümosan resmi ürün sayfası',
            url: sourceUrl,
            status: 'fallback',
            title: 'Tümosan 8110 Teknik Özellikler',
            description: 'Resmi Tümosan ürün sayfasındaki görsel, motor, şanzıman, PTO, hidrolik, kabin ve lastik bilgileri.',
            image_url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
            image_provider: 'Tümosan',
            image_source_url: 'https://www.tumosan.com.tr/tr/urunler/8110',
            model_match_level: 'exact_product_page',
            verification_status: 'official_product_page',
            review_status: 'approved',
            image_gallery: [
                {
                    url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
                    label: 'Tümosan 8110 resmi ürün görseli',
                    source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                    source_name: 'Tümosan resmi ürün sayfası',
                    model_match_level: 'exact_product_page',
                    verification_status: 'official_product_page',
                    review_status: 'approved',
                    confidence_score: 0.98
                },
                {
                    url: 'https://www.tumosan.com.tr/uploads/2023/08/8100serisi1616-fotogaleri-01_w1200_q90_op.jpg',
                    label: 'Tümosan 8110 yan görünüm',
                    source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                    source_name: 'Tümosan resmi ürün sayfası',
                    model_match_level: 'series_gallery',
                    verification_status: 'candidate',
                    review_status: 'candidate',
                    confidence_score: 0.72
                },
                {
                    url: 'https://www.tumosan.com.tr/uploads/2023/08/8100serisi1616-fotogaleri-02_w1200_q90_op.jpg',
                    label: 'Tümosan 8110 kabinli seri fotoğrafı',
                    source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                    source_name: 'Tümosan resmi ürün sayfası',
                    model_match_level: 'series_gallery',
                    verification_status: 'candidate',
                    review_status: 'candidate',
                    confidence_score: 0.72
                }
            ],
            specs: [
                { label: 'Motor Markası', value: 'Tümosan' },
                { label: 'Emisyon Seviyesi', value: 'Stage IIIA / Faz 3A' },
                { label: 'Nominal Motor Gücü', value: '105 HP' },
                { label: 'Anma Motor Devri', value: '2500 rpm' },
                { label: 'Silindir Sayısı / Aspirasyon', value: '4 / Turbo Intercooler' },
                { label: 'Silindir Hacmi', value: '3,9 L' },
                { label: 'Maksimum Tork', value: '400 Nm' },
                { label: 'Azami Tork Devri', value: '1500 rpm' },
                { label: 'Hava Filtresi Tipi', value: 'Kuru tip' },
                { label: 'Yakıt Depo Kapasitesi', value: '115 lt' },
                { label: 'Dişli Kutusu Tipi', value: 'Mekanik - Senkromeçli' },
                { label: 'Vites Seçeneği', value: '16 ileri / 16 geri' },
                { label: 'İleri - Geri Mekik Kolu', value: 'Mekanik' },
                { label: 'Çift Çeker Kumandası', value: 'Elektro-hidrolik' },
                { label: 'Ön Diferansiyel Kilidi', value: 'Kendinden kilitli' },
                { label: 'Arka Diferansiyel Kilidi', value: 'Elektro-hidrolik' },
                { label: 'PTO Tipi', value: 'Bağımsız' },
                { label: 'PTO Kumanda Şekli', value: 'Elektro-hidrolik' },
                { label: 'Kuyruk Mili Devri', value: '540 / 540E' },
                { label: 'Hidrolik Güç Çıkışı', value: '6 adet' },
                { label: 'Kaldırma Kapasitesi', value: '4.000 kg' },
                { label: 'Kabin donanımı', value: 'Klima, yolcu koltuğu, radyo, kompresör' },
                { label: 'Standart konfor', value: 'Ayarlanabilir direksiyon, ayarlanabilir sürücü koltuğu' },
                { label: 'Yüksüz Kütle - 4WD Kabinli', value: '3.500 kg' },
                { label: '1. Opsiyon 4WD-Ön', value: '380/70R24' },
                { label: '1. Opsiyon 4WD-Arka', value: '420/85R34' },
                { label: '2. Opsiyon 4WD-Ön', value: '340/85R24' },
                { label: '2. Opsiyon 4WD-Arka', value: '380/85R38' }
            ],
            fetched_at: new Date().toISOString()
        };
    }
    if (!String(sourceUrl || '').includes('arion-450-trend-11756863')) return null;
    return {
        provider: 'LECTURA Specs',
        url: sourceUrl,
        status: 'fallback',
        title: 'Claas Arion 450 Trend Teknik Özellikler ve Veriler (2022-2026)',
        description: 'Canlı fetch HTTP 403 döndürürse kullanılan doğrulanmış örnek kaynak özeti.',
        image_url: 'https://www.tractorspecifications.com/uploads/tractor-data/140-8570-td3a.jpg',
        image_provider: 'TractorSpecifications',
        image_source_url: 'https://www.tractorspecifications.com/en/tractors/farm/claas/claas-arion-450',
        specs: [
            { label: 'Motor gücü', value: '99 kW' },
            { label: 'Model Serisi', value: 'Arion' },
            { label: 'Geri lastikler', value: '600/65 R38' },
            { label: 'Ön lastikler', value: '480/65 R28' },
            { label: 'Taşıma uzunluğu', value: '4.44 m' },
            { label: 'Taşıma yüksekliği', value: '2.74 m' },
            { label: 'Seyahat hızı', value: '40 km/h' },
            { label: 'Transmisyon', value: '16/16' },
            { label: 'İletim türü', value: 'LS' },
            { label: 'Ağırlık', value: '4.9 t' },
            { label: 'Kontrol ünitesi', value: '-/3 ew/dw' },
            { label: 'Üç nokta kategorisi', value: '3' },
            { label: 'Motor imalatçısı', value: 'FPT' },
            { label: 'Motor tipi', value: 'NEF 4' },
            { label: 'Deplasman', value: '4.485 l' },
            { label: 'Maks torkta devirler', value: '2000 rpm' },
            { label: 'Maks. dönme momenti', value: '573 Nm' },
            { label: 'Silindir sayısı', value: '4' },
            { label: 'Emisyon seviyesi', value: 'V' },
            { label: 'Kabin', value: 'Yes' },
            { label: 'Ön hidrolikler', value: 'No' },
            { label: 'Ön PTO', value: 'No' },
            { label: 'Hava Frenleri', value: 'Yes' },
            { label: 'ISO otobüs', value: 'Yes' },
            { label: 'Klima', value: 'Yes' },
            { label: 'Years of manufacture', value: '2022—2026' }
        ],
        fetched_at: new Date().toISOString()
    };
}

function buildModelIntelSearchLinks({ brandName = '', modelName = '', brandProfile = {} }) {
    const query = compactModelIntelText(`${brandName} ${modelName} traktör teknik özellikleri`);
    const imageQuery = compactModelIntelText(`${brandName} ${modelName} tractor photo`);
    const officialSite = brandProfile.website_url || brandProfile.website || '';
    let officialDomain = '';
    try {
        officialDomain = officialSite ? new URL(officialSite).hostname.replace(/^www\./, '') : '';
    } catch {
        officialDomain = '';
    }

    const links = [];
    if (officialSite) {
        links.push({ type: 'official', label: 'Marka resmi sitesi', url: officialSite, note: 'Resmi ürün, bayi ve katalog başlangıcı' });
    }
    if (brandProfile.price_list_url) {
        links.push({ type: 'price-list', label: 'Resmi fiyat/katalog', url: brandProfile.price_list_url, note: 'Marka portalındaki fiyat veya katalog bağlantısı' });
    }
    if (brandProfile.dealer_locator_url) {
        links.push({ type: 'dealer', label: 'Bayi/servis ağı', url: brandProfile.dealer_locator_url, note: 'Satış ve servis temas noktası' });
    }
    if (officialDomain) {
        links.push({
            type: 'official-search',
            label: 'Resmi sitede model ara',
            url: `https://www.google.com/search?q=${encodeURIComponent(`${brandName} ${modelName} site:${officialDomain}`)}`,
            note: 'Modelin marka sitesindeki sayfasını bulmak için'
        });
    }
    links.push({
        type: 'lectura',
        label: 'LECTURA teknik kaynak ara',
        url: `https://www.google.com/search?q=${encodeURIComponent(`site:lectura-specs.com ${brandName} ${modelName} tractor specs`)}`,
        note: 'Bağımsız teknik özellik ve ölçü katalogları'
    });
    links.push({
        type: 'images',
        label: 'Görsel araması',
        url: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(imageQuery)}`,
        note: 'Model fotoğrafı, kabin ve dış tasarım görüntüleri'
    });
    links.push({
        type: 'used-market',
        label: 'Sahibinden ilan araması',
        url: `https://www.sahibinden.com/arama?query=${encodeURIComponent(`${brandName} ${modelName}`)}`,
        note: 'Model yılına göre ikinci el fiyat sinyali'
    });
    links.push({
        type: 'global',
        label: 'Global satış/ülke izi',
        url: `https://www.google.com/search?q=${encodeURIComponent(`${brandName} ${modelName} countries sold factory engine transmission`)}`,
        note: 'Fabrika, motor, şanzıman ve ülke varlığı doğrulaması'
    });

    return links;
}

function getModelIntelRuntimeBase(req) {
    const requestBase = req?.get ? `${req.protocol}://${req.get('host')}` : '';
    return (APP_BASE_URL || requestBase || '').replace(/\/$/, '');
}

function parsePositiveInteger(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function normalizeModelImageUrl(value = '') {
    const raw = compactModelIntelText(value);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function sanitizeModelGalleryItem(item = {}, defaults = {}, index = 0) {
    const rawUrl = item.url || item.image_url || item.src || item.href || '';
    const url = normalizeModelImageUrl(rawUrl);
    if (!url) return null;

    const sourceUrl = normalizeModelImageUrl(
        item.source_url || item.source || item.page_url || item.product_url || defaults.source_url || defaults.sourceUrl || ''
    );
    const label = compactModelIntelText(
        item.label || item.angle_label || item.angle || item.caption || item.alt || defaults.label || (index === 0 ? 'Ana ürün görseli' : 'Ürün görseli')
    );
    const sourceName = compactModelIntelText(
        item.source_name || item.provider || item.publisher || defaults.source_name || defaults.sourceName || 'n8n model galeri'
    );
    const confidence = Number(item.confidence_score ?? item.confidence ?? defaults.confidence_score ?? 0.75);

    return {
        url,
        image_url: url,
        label,
        angle_label: compactModelIntelText(item.angle_label || item.angle || label || 'Ürün görseli'),
        caption: compactModelIntelText(item.caption || item.label || label),
        source: sourceUrl,
        source_url: sourceUrl,
        source_name: sourceName,
        width: parsePositiveInteger(item.width),
        height: parsePositiveInteger(item.height),
        confidence_score: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.75,
        model_match_level: compactModelIntelText(item.model_match_level || defaults.model_match_level || 'unknown'),
        verification_status: compactModelIntelText(item.verification_status || defaults.verification_status || 'candidate'),
        review_status: compactModelIntelText(item.review_status || defaults.review_status || 'candidate'),
        sort_order: Number.isFinite(Number(item.sort_order)) ? Math.round(Number(item.sort_order)) : (index + 1) * 10,
        is_primary: Boolean(item.is_primary || item.primary || index === 0),
        raw_payload: item.raw_payload || item
    };
}

function isPublishableModelGalleryItem(item = {}) {
    const confidence = Number(item.confidence_score || 0);
    const reviewStatus = String(item.review_status || '').toLowerCase();
    const verificationStatus = String(item.verification_status || '').toLowerCase();
    const matchLevel = String(item.model_match_level || '').toLowerCase();
    const approved = reviewStatus === 'approved' || verificationStatus === 'manual_approved';
    const exact = ['exact_model', 'exact_product_page', 'official_product_page', 'manual_verified'].includes(matchLevel);
    const verified = ['official_product_page', 'manual_approved', 'manual_verified', 'exact_model'].includes(verificationStatus);
    return approved && exact && verified && confidence >= 0.85;
}

function filterPublishableModelGallery(items = []) {
    return dedupeModelGallery(items.filter(isPublishableModelGalleryItem));
}

function dedupeModelGallery(items = []) {
    const seen = new Set();
    return items.filter(item => {
        if (!item?.url) return false;
        const key = item.url.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mapModelGalleryDbRow(row = {}) {
    return {
        id: row.id,
        url: row.image_url,
        image_url: row.image_url,
        label: row.caption || row.angle_label || 'Ürün görseli',
        angle_label: row.angle_label || null,
        caption: row.caption || null,
        source: row.source_url || '',
        source_url: row.source_url || '',
        source_name: row.source_name || 'Model galeri',
        confidence_score: numberOrNull(row.confidence_score),
        model_match_level: row.model_match_level || 'unknown',
        verification_status: row.verification_status || 'candidate',
        review_status: row.review_status || 'candidate',
        sort_order: row.sort_order,
        is_primary: row.is_primary,
        provider: row.source_name || 'Model galeri'
    };
}

async function getModelImageGalleryFromDb({ brandName = '', modelName = '', tuikModelName = '' } = {}) {
    const brandAliases = normalizeBrandAliasesForModelIntel(brandName);
    const modelKeys = [...new Set([modelName, tuikModelName].map(toUpperPlain).filter(Boolean))];
    const modelPatterns = [...new Set([modelName, tuikModelName]
        .map(normalizeModelSearch)
        .filter(value => value.length >= 3)
        .map(value => `%${value}%`))];
    if (!brandAliases.length || !modelKeys.length) return [];

    const result = await pool.query(`
        SELECT *
        FROM model_image_gallery
        WHERE is_active = true
          AND review_status = 'approved'
          AND UPPER(brand_name) = ANY($1::text[])
          AND (
            UPPER(model_name) = ANY($2::text[])
            OR UPPER(COALESCE(tuik_model_adi, '')) = ANY($2::text[])
            OR model_name ILIKE ANY($3::text[])
            OR COALESCE(tuik_model_adi, '') ILIKE ANY($3::text[])
          )
        ORDER BY is_primary DESC, sort_order ASC, id ASC
        LIMIT 18
    `, [brandAliases, modelKeys, modelPatterns.length ? modelPatterns : ['__no_model_gallery_pattern__']]);

    return result.rows.map(mapModelGalleryDbRow);
}

async function upsertModelImageGallery({ brandName = '', modelName = '', tuikModelName = '', images = [] } = {}) {
    const cleanBrand = compactModelIntelText(brandName);
    const cleanModel = compactModelIntelText(modelName);
    if (!cleanBrand || !cleanModel || !Array.isArray(images) || !images.length) return [];

    const normalized = dedupeModelGallery(images
        .map((item, index) => sanitizeModelGalleryItem(item, {
            source_name: item?.source_name || item?.provider || 'n8n model galeri'
        }, index))
        .filter(Boolean));

    const saved = [];
    for (const [index, image] of normalized.entries()) {
        const result = await pool.query(`
            INSERT INTO model_image_gallery (
                brand_name, model_name, tuik_model_adi, image_url, source_url, source_name,
                angle_label, caption, width, height, confidence_score, model_match_level,
                verification_status, review_status, verified_at, sort_order, is_primary,
                raw_payload, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,NOW())
            ON CONFLICT (brand_name, model_name, image_url)
            DO UPDATE SET
                tuik_model_adi = COALESCE(EXCLUDED.tuik_model_adi, model_image_gallery.tuik_model_adi),
                source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), model_image_gallery.source_url),
                source_name = COALESCE(NULLIF(EXCLUDED.source_name, ''), model_image_gallery.source_name),
                angle_label = COALESCE(NULLIF(EXCLUDED.angle_label, ''), model_image_gallery.angle_label),
                caption = COALESCE(NULLIF(EXCLUDED.caption, ''), model_image_gallery.caption),
                width = COALESCE(EXCLUDED.width, model_image_gallery.width),
                height = COALESCE(EXCLUDED.height, model_image_gallery.height),
                confidence_score = GREATEST(COALESCE(EXCLUDED.confidence_score, 0), COALESCE(model_image_gallery.confidence_score, 0)),
                model_match_level = COALESCE(NULLIF(EXCLUDED.model_match_level, ''), model_image_gallery.model_match_level),
                verification_status = COALESCE(NULLIF(EXCLUDED.verification_status, ''), model_image_gallery.verification_status),
                review_status = COALESCE(NULLIF(EXCLUDED.review_status, ''), model_image_gallery.review_status),
                verified_at = COALESCE(EXCLUDED.verified_at, model_image_gallery.verified_at),
                sort_order = LEAST(COALESCE(EXCLUDED.sort_order, 100), COALESCE(model_image_gallery.sort_order, 100)),
                is_primary = model_image_gallery.is_primary OR EXCLUDED.is_primary,
                is_active = true,
                raw_payload = COALESCE(EXCLUDED.raw_payload, model_image_gallery.raw_payload),
                updated_at = NOW()
            RETURNING *
        `, [
            cleanBrand,
            cleanModel,
            compactModelIntelText(tuikModelName) || null,
            image.url,
            image.source_url || '',
            image.source_name || '',
            image.angle_label || (index === 0 ? 'Ana ürün görseli' : 'Ürün görseli'),
            image.caption || image.label || '',
            image.width,
            image.height,
            image.confidence_score,
            image.model_match_level || 'unknown',
            image.verification_status || 'candidate',
            image.review_status || 'candidate',
            image.review_status === 'approved' ? new Date() : null,
            image.sort_order || (index + 1) * 10,
            image.is_primary || index === 0,
            JSON.stringify(image.raw_payload || image)
        ]);
        saved.push(mapModelGalleryDbRow(result.rows[0]));
    }

    return saved;
}

function buildModelPhotoSearchPlan({ brandName = '', modelName = '', tuikModelName = '', brandProfile = {}, sourceUrl = '', callbackUrl = '' } = {}) {
    const officialSite = brandProfile.website_url || brandProfile.website || '';
    let officialDomain = '';
    try {
        officialDomain = officialSite ? new URL(officialSite).hostname.replace(/^www\./, '') : '';
    } catch {
        officialDomain = '';
    }

    const modelLabel = compactModelIntelText(`${brandName} ${modelName || tuikModelName}`);
    const officialQuery = officialDomain
        ? `${modelLabel} site:${officialDomain}`
        : `${modelLabel} official tractor product page`;

    return {
        task: 'model_photo_gallery',
        brand: compactModelIntelText(brandName),
        model: compactModelIntelText(modelName),
        tuik_model_adi: compactModelIntelText(tuikModelName),
        source_url: sourceUrl || null,
        callback_url: callbackUrl || null,
        callback_header: MEDIA_WATCH_WEBHOOK_KEY ? { 'x-webhook-key': '<MEDIA_WATCH_WEBHOOK_KEY>' } : null,
        expected_angles: ['ana ürün görseli', 'ön görünüm', 'yan görünüm', 'arka görünüm', 'kabin içi', 'çalışma sahası'],
        search_queries: [
            officialQuery,
            `${modelLabel} traktör fotoğraf`,
            `${modelLabel} tractor gallery`,
            `${modelLabel} cabin interior tractor`
        ],
        acceptance_rules: [
            'URL doğrudan görsel dosyasına veya hotlink izinli CDN görseline işaret etmeli.',
            'Fotoğraf model adıyla eşleşmeli; marka logosu veya katalog kapağı tek başına yeterli değil.',
            'Öncelik resmi marka sitesi, katalog PDF görselleri ve doğrulanabilir bayi sayfalarıdır.',
            'Her görsel için kaynak sayfa, açı etiketi ve güven skoru döndürülmelidir.'
        ],
        response_contract: {
            images: [{
                url: 'https://...',
                source_url: 'https://...',
                source_name: 'Resmi marka sitesi',
                angle_label: 'yan görünüm',
                caption: 'Model adı ve seri bilgisi',
                confidence_score: 0.92,
                model_match_level: 'exact_product_page',
                verification_status: 'official_product_page',
                review_status: 'approved',
                is_primary: true
            }]
        }
    };
}

async function fetchN8nModelImageGallery(payload = {}) {
    if (!N8N_MODEL_INTEL_WEBHOOK_URL) {
        return { status: 'not_configured', images: [], raw: null };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
        const response = await fetch(N8N_MODEL_INTEL_WEBHOOK_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(MEDIA_WATCH_WEBHOOK_KEY ? { 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY } : {})
            },
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { message: text };
        }
        if (!response.ok) {
            return {
                status: 'error',
                images: [],
                error: data?.error || data?.message || `n8n HTTP ${response.status}`,
                raw: data
            };
        }

        const rawImages = Array.isArray(data)
            ? data
            : (data.images || data.image_gallery || data.gallery || data.data?.images || []);
        const images = dedupeModelGallery((Array.isArray(rawImages) ? rawImages : [])
            .map((item, index) => sanitizeModelGalleryItem(item, { source_name: 'n8n model galeri' }, index))
            .filter(Boolean));

        return {
            status: images.length ? 'ready' : (response.status === 202 || data.status === 'accepted' ? 'accepted' : 'empty'),
            images,
            raw: data
        };
    } catch (err) {
        return {
            status: 'error',
            images: [],
            error: err.name === 'AbortError' ? 'n8n galeri taraması zaman aşımına uğradı' : err.message,
            raw: null
        };
    } finally {
        clearTimeout(timer);
    }
}

function inferKnownModelImageGallery(brandName = '', modelName = '') {
    const brandKey = normalizeTurkishSearchKey(brandName);
    const modelKey = normalizeTurkishSearchKey(modelName).replace(/\s+/g, '');
    const gallery = [];
    const brandReferenceImages = [
        {
            matches: ['TUMOSAN', 'TÜMOSAN'],
            url: 'https://www.tumosan.com.tr/uploads/2023/07/8000-serisi-1_op.jpg',
            source_url: 'https://www.tumosan.com.tr/en/products/8095',
            source_name: 'TÜMOSAN 8000 Serisi',
            caption: 'TÜMOSAN marka referans traktör görseli'
        },
        {
            matches: ['BASAK', 'BAŞAK'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Ba%C5%9Fak%20Trakt%C3%B6r%20Agritechnica%202017.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Ba%C5%9Fak_Trakt%C3%B6r_Agritechnica_2017.jpg',
            source_name: 'Wikimedia Commons Başak Traktör',
            caption: 'Başak marka referans traktör görseli'
        },
        {
            matches: ['NEW HOLLAND'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:New%20Holland%207840%20tractor%20%2819330925415%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:New_Holland_7840_tractor_(19330925415).jpg',
            source_name: 'Wikimedia Commons New Holland',
            caption: 'New Holland marka referans traktör görseli'
        },
        {
            matches: ['MASSEY FERGUSON'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Massey%20Ferguson%205460%20tractor%20%2823472773879%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Massey_Ferguson_5460_tractor_(23472773879).jpg',
            source_name: 'Wikimedia Commons Massey Ferguson',
            caption: 'Massey Ferguson marka referans traktör görseli'
        },
        {
            matches: ['JOHN DEERE'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:John%20Deere%20tractor%20%281%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:John_Deere_tractor_(1).jpg',
            source_name: 'Wikimedia Commons John Deere',
            caption: 'John Deere marka referans traktör görseli'
        },
        {
            matches: ['CASE', 'CASE IH'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Case%20IH%2C%20WAW%281%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Case_IH,_WAW(1).jpg',
            source_name: 'Wikimedia Commons Case IH',
            caption: 'Case IH marka referans traktör görseli'
        },
        {
            matches: ['DEUTZ', 'DEUTZ-FAHR'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Deutz%20100%2006%20tractor%20%2817135177425%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Deutz_100_06_tractor_(17135177425).jpg',
            source_name: 'Wikimedia Commons Deutz',
            caption: 'Deutz marka referans traktör görseli'
        },
        {
            matches: ['KUBOTA'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Kubota%20tractor%20%2850600439387%29.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Kubota_tractor_(50600439387).jpg',
            source_name: 'Wikimedia Commons Kubota',
            caption: 'Kubota marka referans traktör görseli'
        },
        {
            matches: ['FENDT'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Fendt%20933%20tractor.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Fendt_933_tractor.jpg',
            source_name: 'Wikimedia Commons Fendt',
            caption: 'Fendt marka referans traktör görseli'
        },
        {
            matches: ['VALTRA'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Valtra%204th%20generation%20N%20Series%20tractor.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Valtra_4th_generation_N_Series_tractor.jpg',
            source_name: 'Wikimedia Commons Valtra',
            caption: 'Valtra marka referans traktör görseli'
        },
        {
            matches: ['LANDINI', 'MCCORMICK'],
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Landini%20Tractor%201706.JPG',
            source_url: 'https://commons.wikimedia.org/wiki/File:Landini_Tractor_1706.JPG',
            source_name: 'Wikimedia Commons Landini',
            caption: 'Landini marka referans traktör görseli'
        }
    ];

    if ((brandKey.includes('TUMOSAN') || brandKey.includes('TÜMOSAN')) && modelKey.includes('8110')) {
        gallery.push({
            url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
            source_url: 'https://www.tumosan.com.tr/tr/urunler/8110',
            source_name: 'Tümosan resmi ürün sayfası',
            angle_label: 'resmi ürün görseli',
            caption: 'Tümosan 8110 resmi ürün sayfasındaki alt=8110 görseli',
            confidence_score: 0.98,
            model_match_level: 'exact_product_page',
            verification_status: 'official_product_page',
            review_status: 'approved',
            is_primary: true
        });
    }

    if (brandKey.includes('NEW HOLLAND')) {
        if (modelKey.startsWith('TT') || modelKey.includes('TT60') || modelKey.includes('TT55') || modelKey.includes('TT65') || modelKey.includes('TT75')) {
            gallery.push(
                {
                    url: 'https://i.machinio.com/medium/al/5qj7ap/2086954677_2/ddf6/new-holland-tt60-tractor.jpg',
                    source_url: 'https://www.machinio.com/listings/1604-new-holland-tt60-tractor',
                    source_name: 'Machinio TT60 ilan görseli',
                    angle_label: 'ana görünüm',
                    caption: `${brandName} ${modelName} ürün fotoğrafı`,
                    confidence_score: modelKey.includes('TT60') ? 0.86 : 0.68,
                    is_primary: true
                },
                {
                    url: 'https://cnhi-p-001-delivery.sitecorecontenthub.cloud/api/public/content/1918e3190db14d60a6e32f9f1290ef26?t=size500&v=45a64884',
                    source_url: 'https://agriculture.newholland.com/en/asiapacific/products/agricultural-tractors/tt',
                    source_name: 'New Holland resmi TT seri sayfası',
                    angle_label: 'seri görseli',
                    caption: 'New Holland TT seri resmi ürün görseli',
                    confidence_score: 0.74,
                    is_primary: false
                }
            );
        }

        if (modelKey.startsWith('T5') || modelKey.includes('T590') || modelKey.includes('T5.90')) {
            gallery.push(
                {
                    url: 'https://imagedelivery.net/mhuCRcTxCdbPtYk1I1TKMA/roc%2Fbinghamequipment%2F31906f463585214bde2976d0d14ca93c/New%20Holland%20T5.90%20Tractor.jpg/400x400',
                    source_url: 'https://www.binghamequipment.com/products/catalog/equipment/tractors/new-holland/new-holland-t5-90-dual-command-tractor/t5-90-dual-command',
                    source_name: 'Bingham Equipment T5.90 ürün sayfası',
                    angle_label: 'ana görünüm',
                    caption: `${brandName} ${modelName} ürün fotoğrafı`,
                    confidence_score: modelKey.includes('T590') || modelKey.includes('T5.90') ? 0.9 : 0.72,
                    is_primary: true
                },
                {
                    url: 'https://imagedelivery.net/mhuCRcTxCdbPtYk1I1TKMA/roc%2Fbinghamequipment%2F62ef39de8e0f03e92046f0fac8367293/New%20Holland%20T5%20tractor.png/400x400',
                    source_url: 'https://www.binghamequipment.com/products/catalog/equipment/tractors/new-holland/new-holland-t5-90-dual-command-tractor/t5-90-dual-command',
                    source_name: 'Bingham Equipment T5 seri görseli',
                    angle_label: 'seri görünüm',
                    caption: 'New Holland T5 seri ürün görseli',
                    confidence_score: 0.76,
                    is_primary: false
                }
            );
        }
    }

    if (!gallery.length) {
        const brandReference = brandReferenceImages.find(item => item.matches.some(match => brandKey.includes(match)));
        const fallback = brandReference || {
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Tractor-agricultural-machine-cultivating-field.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Tractor-agricultural-machine-cultivating-field.jpg',
            source_name: 'Wikimedia Commons traktör referansı',
            caption: 'Traktör marka/model referans görseli'
        };
        gallery.push({
            ...fallback,
            angle_label: 'referans görünüm',
            caption: `${brandName} ${modelName} için ${fallback.caption || 'referans traktör görseli'}`,
            confidence_score: brandReference ? 0.42 : 0.28,
            is_primary: true
        });
    }

    return dedupeModelGallery(gallery
        .map((item, index) => sanitizeModelGalleryItem(item, {
            source_name: 'Bilinen model görsel kaynağı'
        }, index))
        .filter(Boolean));
}

function mapTechnicalVariantForIntel(row = {}) {
    return {
        id: row.id,
        brand_name: row.marka,
        model_name: row.model || row.tuik_model_adi,
        tuik_model_name: row.tuik_model_adi,
        price_usd: numberOrNull(row.fiyat_usd),
        design: {
            origin: row.mensei || null,
            use_case: row.kullanim_alani || null,
            protection: row.koruma || null,
            drive_type: row.cekis_tipi || null,
            model_years: row.model_yillari || null
        },
        engine: {
            brand: row.motor_marka || null,
            power_hp: numberOrNull(row.motor_gucu_hp),
            rated_rpm: numberOrNull(row.motor_devri_rpm),
            max_torque_nm: numberOrNull(row.maksimum_tork),
            cylinders: numberOrNull(row.silindir_sayisi),
            emission: row.emisyon_seviyesi || null
        },
        transmission: {
            gear_config: row.vites_sayisi || null
        },
        hydraulics: {
            lift_capacity_kg: numberOrNull(row.hidrolik_kaldirma)
        },
        dimensions: {
            fuel_tank_liters: numberOrNull(row.depo_hacmi_lt),
            weight_kg: numberOrNull(row.agirlik),
            wheelbase_mm: numberOrNull(row.dingil_mesafesi),
            length_mm: numberOrNull(row.uzunluk),
            width_mm: numberOrNull(row.genislik),
            height_mm: numberOrNull(row.yukseklik)
        }
    };
}

function buildModelIntelSpecGroups(primary = {}, tractorModel = {}, externalSource = null) {
    const engine = primary.engine || {};
    const design = primary.design || {};
    const transmission = primary.transmission || {};
    const hydraulics = primary.hydraulics || {};
    const dimensions = primary.dimensions || {};
    const externalSpec = (...labels) => {
        const specs = externalSource?.specs || [];
        for (const label of labels) {
            const item = specs.find(spec => String(spec.label || '').toLocaleLowerCase('tr-TR') === String(label || '').toLocaleLowerCase('tr-TR'));
            if (item?.value !== undefined && item.value !== null && item.value !== '') return item.value;
        }
        return null;
    };

    return {
        hero: [
            { label: 'Motor gücü', value: engine.power_hp || tractorModel.horsepower, unit: 'HP' },
            { label: 'Fiyat', value: primary.price_usd || tractorModel.price_usd, format: 'usd' },
            { label: 'Çekiş', value: design.drive_type || tractorModel.drive_type },
            { label: 'Kabin/koruma', value: design.protection || tractorModel.cabin_type }
        ],
        design: [
            { label: 'Kullanım sınıfı', value: design.use_case || tractorModel.category },
            { label: 'Menşei', value: design.origin },
            { label: 'Model yılları', value: design.model_years },
            { label: 'Koruma', value: design.protection || tractorModel.cabin_type },
            { label: 'Çekiş tipi', value: design.drive_type || tractorModel.drive_type },
            { label: 'Kabin donanımı', value: externalSpec('Kabin donanımı') },
            { label: 'Standart konfor', value: externalSpec('Standart konfor') }
        ],
        engine: [
            { label: 'Motor markası', value: engine.brand || tractorModel.engine_brand },
            { label: 'Motor gücü', value: engine.power_hp || tractorModel.horsepower, unit: 'HP' },
            { label: 'Motor devri', value: engine.rated_rpm, unit: 'rpm' },
            { label: 'Silindir / aspirasyon', value: externalSpec('Silindir Sayısı / Aspirasyon') },
            { label: 'Silindir hacmi', value: externalSpec('Silindir Hacmi') },
            { label: 'Maksimum tork', value: engine.max_torque_nm || tractorModel.max_torque_nm || externalSpec('Maksimum Tork') },
            { label: 'Azami tork devri', value: externalSpec('Azami Tork Devri') },
            { label: 'Silindir', value: engine.cylinders || tractorModel.cylinder_count },
            { label: 'Emisyon', value: engine.emission || tractorModel.emission_standard || externalSpec('Emisyon Seviyesi') },
            { label: 'Hava filtresi', value: externalSpec('Hava Filtresi Tipi') }
        ],
        transmission: [
            { label: 'Şanzıman/vites', value: transmission.gear_config || tractorModel.gear_config || externalSpec('Vites Seçeneği') },
            { label: 'Transmisyon tipi', value: tractorModel.transmission_type || externalSpec('Dişli Kutusu Tipi') },
            { label: 'İleri vites', value: tractorModel.forward_gears },
            { label: 'Geri vites', value: tractorModel.reverse_gears },
            { label: 'İleri-geri mekik', value: externalSpec('İleri - Geri Mekik Kolu') },
            { label: 'Çift çeker kumandası', value: externalSpec('Çift Çeker Kumandası') },
            { label: 'Ön diferansiyel kilidi', value: externalSpec('Ön Diferansiyel Kilidi') },
            { label: 'Arka diferansiyel kilidi', value: externalSpec('Arka Diferansiyel Kilidi') },
            { label: 'Shuttle', value: tractorModel.has_shuttle === true ? 'Var' : tractorModel.has_shuttle === false ? 'Yok' : null },
            { label: 'Creeper', value: tractorModel.has_creeper === true ? 'Var' : tractorModel.has_creeper === false ? 'Yok' : null }
        ],
        hydraulics: [
            { label: 'Hidrolik kaldırma', value: hydraulics.lift_capacity_kg || tractorModel.lift_capacity_kg || externalSpec('Kaldırma Kapasitesi') },
            { label: 'Hidrolik kapasite', value: tractorModel.hydraulic_capacity_lpm, unit: 'lt/dk' },
            { label: 'Hidrolik güç çıkışı', value: externalSpec('Hidrolik Güç Çıkışı') },
            { label: 'PTO', value: tractorModel.pto_rpm || externalSpec('Kuyruk Mili Devri') },
            { label: 'PTO tipi', value: externalSpec('PTO Tipi') },
            { label: 'PTO kumanda', value: externalSpec('PTO Kumanda Şekli') },
            { label: 'PTO gücü', value: tractorModel.pto_power_hp, unit: 'HP' },
            { label: 'Yakıt deposu', value: dimensions.fuel_tank_liters || tractorModel.fuel_tank_liters, unit: 'lt' }
        ],
        dimensions: [
            { label: 'Ağırlık', value: dimensions.weight_kg || tractorModel.weight_kg || externalSpec('Yüksüz Kütle - 4WD Kabinli'), unit: 'kg' },
            { label: 'Dingil mesafesi', value: dimensions.wheelbase_mm || tractorModel.wheelbase_mm, unit: 'mm' },
            { label: 'Uzunluk', value: dimensions.length_mm || tractorModel.length_mm, unit: 'mm' },
            { label: 'Genişlik', value: dimensions.width_mm || tractorModel.width_mm, unit: 'mm' },
            { label: 'Yükseklik', value: dimensions.height_mm || tractorModel.height_mm, unit: 'mm' },
            { label: 'Ön lastik', value: tractorModel.front_tire || externalSpec('1. Opsiyon 4WD-Ön', '2. Opsiyon 4WD-Ön') },
            { label: 'Arka lastik', value: tractorModel.rear_tire || externalSpec('1. Opsiyon 4WD-Arka', '2. Opsiyon 4WD-Arka') }
        ]
    };
}

app.get('/api/models', authMiddleware, async (req, res) => {
    try {
        const { brand_id, category, drive_type, cabin_type, hp_min, hp_max, q } = req.query;
        const turkishSqlChars = '\u0130I\u0131\u015E\u015F\u011E\u011F\u00DC\u00FC\u00D6\u00F6\u00C7\u00E7';
        const asciiSqlChars = 'IIISSGGUUOOCC';
        const normalizedSqlText = (expr) => `
            TRANSLATE(
                UPPER(COALESCE(${expr}, '')),
                '${turkishSqlChars}',
                '${asciiSqlChars}'
            )
        `;
        const brandAliasExpr = (expr) => `
            CASE
                WHEN ${normalizedSqlText(expr)} IN ('CASE IH', 'CASEIH') THEN 'CASE'
                WHEN ${normalizedSqlText(expr)} IN ('DEUTZ-FAHR', 'DEUTZ FAHR') THEN 'DEUTZ'
                ELSE ${normalizedSqlText(expr)}
            END
        `;
        const modelNameExpr = `COALESCE(NULLIF(TRIM(tk.model), ''), NULLIF(TRIM(tk.tuik_model_adi), ''))`;
        const useCaseExpr = normalizedSqlText('tk.kullanim_alani');
        const driveExpr = normalizedSqlText('tk.cekis_tipi');
        const protectionExpr = normalizedSqlText('tk.koruma');

        let query = `
            SELECT
                (MIN(tk.id) + 100000)::int AS id,
                b.id AS brand_id,
                b.name AS brand_name,
                b.slug AS brand_slug,
                ${modelNameExpr} AS model_name,
                MIN(NULLIF(TRIM(tk.tuik_model_adi), '')) AS model_code,
                ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) AS horsepower,
                ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) AS price_usd,
                ROUND(AVG(NULLIF(tk.agirlik, 0))::numeric, 0) AS weight_kg,
                MODE() WITHIN GROUP (ORDER BY
                    CASE
                        WHEN ${useCaseExpr} LIKE '%BAHCE%' AND ${useCaseExpr} LIKE '%TARLA%' THEN 'hibrit'
                        WHEN ${useCaseExpr} LIKE '%HIBRIT%' THEN 'hibrit'
                        WHEN ${useCaseExpr} LIKE '%BAHCE%' THEN 'bahce'
                        WHEN ${useCaseExpr} LIKE '%TARLA%' THEN 'tarla'
                        ELSE 'tarla'
                    END
                ) AS category,
                MODE() WITHIN GROUP (ORDER BY
                    CASE
                        WHEN ${protectionExpr} LIKE '%KABIN%' THEN 'kabinli'
                        WHEN ${protectionExpr} LIKE '%ROPS%' OR ${protectionExpr} LIKE '%ROLL%' THEN 'rollbar'
                        ELSE NULLIF(tk.koruma, '')
                    END
                ) AS cabin_type,
                MODE() WITHIN GROUP (ORDER BY
                    CASE
                        WHEN ${driveExpr} LIKE '%4%' THEN '4WD'
                        WHEN ${driveExpr} LIKE '%2%' THEN '2WD'
                        ELSE NULLIF(UPPER(tk.cekis_tipi), '')
                    END
                ) AS drive_type,
                MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.vites_sayisi), '')) AS gear_config,
                MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.motor_marka), '')) AS engine_brand,
                MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.emisyon_seviyesi), '')) AS emission_standard,
                'teknik_veri' AS source_table
            FROM teknik_veri tk
            JOIN brands b ON ${brandAliasExpr('tk.marka')} = ${brandAliasExpr('b.name')}
            WHERE ${modelNameExpr} IS NOT NULL
        `;
        const params = [];
        if (brand_id) { params.push(brand_id); query += ` AND b.id = $${params.length}`; }
        if (category) {
            const normalizedCategory = normalizeTurkishSearchKey(category).toLowerCase();
            if (normalizedCategory === 'bahce') {
                query += ` AND (${useCaseExpr} LIKE '%BAHCE%' OR ${useCaseExpr} LIKE '%HIBRIT%')`;
            } else if (normalizedCategory === 'tarla') {
                query += ` AND (${useCaseExpr} LIKE '%TARLA%' OR ${useCaseExpr} LIKE '%HIBRIT%')`;
            } else if (normalizedCategory === 'hibrit') {
                query += ` AND (${useCaseExpr} LIKE '%HIBRIT%' OR (${useCaseExpr} LIKE '%BAHCE%' AND ${useCaseExpr} LIKE '%TARLA%'))`;
            }
        }
        if (drive_type) {
            const normalizedDrive = normalizeTurkishSearchKey(drive_type);
            if (normalizedDrive.includes('4')) {
                query += ` AND ${driveExpr} LIKE '%4%'`;
            } else if (normalizedDrive.includes('2')) {
                query += ` AND ${driveExpr} LIKE '%2%'`;
            }
        }
        if (cabin_type) {
            const normalizedCabin = normalizeTurkishSearchKey(cabin_type).toLowerCase();
            if (normalizedCabin === 'kabinli' || normalizedCabin === 'kabin') {
                query += ` AND ${protectionExpr} LIKE '%KABIN%'`;
            } else if (normalizedCabin === 'rollbar' || normalizedCabin === 'rops') {
                query += ` AND (${protectionExpr} LIKE '%ROPS%' OR ${protectionExpr} LIKE '%ROLL%')`;
            }
        }
        if (hp_min) { params.push(Number(hp_min)); query += ` AND tk.motor_gucu_hp >= $${params.length}`; }
        if (hp_max) { params.push(Number(hp_max)); query += ` AND tk.motor_gucu_hp <= $${params.length}`; }
        if (q) {
            params.push(`%${normalizeTurkishSearchKey(q)}%`);
            query += ` AND (
                ${normalizedSqlText('tk.model')} LIKE $${params.length}
                OR ${normalizedSqlText('tk.tuik_model_adi')} LIKE $${params.length}
            )`;
        }
        query += `
            GROUP BY b.id, b.name, b.slug, ${modelNameExpr}
            ORDER BY b.name, ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) NULLS LAST, model_name
            LIMIT 500
        `;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Models list error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Model karşılaştırma
app.get('/api/models/compare', authMiddleware, async (req, res) => {
    try {
        const { model_ids } = req.query;
        if (!model_ids) return res.status(400).json({ error: 'model_ids gerekli' });
        const ids = model_ids.split(',').map(Number);
        const result = await pool.query(`
            SELECT m.*, b.name as brand_name, b.primary_color, b.logo_url
            FROM tractor_models m JOIN brands b ON m.brand_id = b.id
            WHERE m.id = ANY($1)
        `, [ids]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/model-intelligence', authMiddleware, async (req, res) => {
    try {
        const brandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;
        const brandQuery = normalizeModelSearch(req.query.brand || '');
        const modelQuery = normalizeModelSearch(req.query.model || req.query.q || '');
        const tuikModelQuery = normalizeModelSearch(req.query.tuik_model_adi || req.query.model_code || '');
        const requestedModelNames = [...new Set([modelQuery, tuikModelQuery].filter(Boolean))];
        const requestedSourceUrl = normalizeModelSearch(req.query.source_url || '');

        if (!brandId && !brandQuery && !modelQuery && !tuikModelQuery && !requestedSourceUrl) {
            return res.status(400).json({ error: 'brand_id, brand, model veya source_url gerekli' });
        }

        let brandProfile = null;
        if (brandId || brandQuery) {
            const profileWhere = brandId
                ? 'b.id = $1'
                : '(UPPER(b.name) = UPPER($1) OR b.slug = LOWER($1))';
            const profileRes = await pool.query(`
                SELECT
                    b.id, b.name, b.slug, b.logo_url, b.primary_color, b.secondary_color,
                    b.country_of_origin, b.parent_company, b.website, b.description,
                    p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url,
                    p.headquarters, p.source_notes_json
                FROM brands b
                LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                WHERE ${profileWhere}
                LIMIT 1
            `, [brandId || brandQuery]);
            brandProfile = profileRes.rows[0] || null;
        }

        let brandAliases = normalizeBrandAliasesForModelIntel(brandProfile?.name || brandQuery);
        const techParams = [];
        const techWhere = [];
        let modelExactIdx = null;
        if (brandAliases.length) {
            techParams.push(brandAliases);
            techWhere.push(`UPPER(tk.marka) = ANY($${techParams.length}::text[])`);
        }
        if (requestedModelNames.length) {
            techParams.push(requestedModelNames.map(toUpperPlain));
            modelExactIdx = techParams.length;
            techParams.push(requestedModelNames.map(value => `%${value}%`));
            const likeIdx = techParams.length;
            techWhere.push(`(
                UPPER(tk.tuik_model_adi) = ANY($${modelExactIdx}::text[])
                OR UPPER(tk.model) = ANY($${modelExactIdx}::text[])
                OR tk.tuik_model_adi ILIKE ANY($${likeIdx}::text[])
                OR tk.model ILIKE ANY($${likeIdx}::text[])
            )`);
        }

        let technicalRows = [];
        if (techWhere.length) {
            const orderExactSql = modelExactIdx
                ? `CASE WHEN UPPER(tk.tuik_model_adi) = ANY($${modelExactIdx}::text[]) OR UPPER(tk.model) = ANY($${modelExactIdx}::text[]) THEN 0 ELSE 1 END,`
                : '';
            const technicalRes = await pool.query(`
                SELECT *
                FROM teknik_veri tk
                WHERE ${techWhere.join(' AND ')}
                ORDER BY
                    ${orderExactSql}
                    tk.motor_gucu_hp NULLS LAST,
                    tk.fiyat_usd NULLS LAST,
                    tk.model
                LIMIT 18
            `, techParams);
            technicalRows = technicalRes.rows;
        }

        if (!brandProfile && technicalRows[0]?.marka) {
            brandAliases = normalizeBrandAliasesForModelIntel(technicalRows[0].marka);
            const profileRes = await pool.query(`
                SELECT
                    b.id, b.name, b.slug, b.logo_url, b.primary_color, b.secondary_color,
                    b.country_of_origin, b.parent_company, b.website, b.description,
                    p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url,
                    p.headquarters, p.source_notes_json
                FROM brands b
                LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                WHERE UPPER(b.name) = ANY($1::text[])
                LIMIT 1
            `, [brandAliases]);
            brandProfile = profileRes.rows[0] || null;
        }

        const tmParams = [];
        const tmWhere = ['m.is_current_model = true'];
        if (brandProfile?.id) {
            tmParams.push(brandProfile.id);
            tmWhere.push(`m.brand_id = $${tmParams.length}`);
        } else if (brandAliases.length) {
            tmParams.push(brandAliases);
            tmWhere.push(`UPPER(b.name) = ANY($${tmParams.length}::text[])`);
        }
        if (requestedModelNames.length) {
            tmParams.push(requestedModelNames.map(value => `%${value}%`));
            tmWhere.push(`m.model_name ILIKE ANY($${tmParams.length}::text[])`);
        }

        const tractorModelRes = await pool.query(`
            SELECT m.*, b.name AS brand_name, b.primary_color, b.logo_url
            FROM tractor_models m
            JOIN brands b ON b.id = m.brand_id
            WHERE ${tmWhere.join(' AND ')}
            ORDER BY m.horsepower NULLS LAST, m.model_name
            LIMIT 6
        `, tmParams);
        const tractorModel = tractorModelRes.rows[0] || {};

        const effectiveBrandName = brandProfile?.name || tractorModel.brand_name || technicalRows[0]?.marka || brandQuery || '';
        const effectiveModelName = technicalRows[0]?.model || technicalRows[0]?.tuik_model_adi || tractorModel.model_name || modelQuery || '';
        if (!brandAliases.length && effectiveBrandName) {
            brandAliases = normalizeBrandAliasesForModelIntel(effectiveBrandName);
        }

        const mappedVariants = technicalRows.map(mapTechnicalVariantForIntel);
        const primaryVariant = mappedVariants[0] || {};
        let specGroups = buildModelIntelSpecGroups(primaryVariant, tractorModel);
        const prices = mappedVariants.map(item => item.price_usd).filter(value => value && value > 0);
        const powers = mappedVariants.map(item => item.engine?.power_hp).filter(value => value && value > 0);
        const priceStats = {
            min_usd: prices.length ? Math.min(...prices) : numberOrNull(tractorModel.price_usd),
            max_usd: prices.length ? Math.max(...prices) : numberOrNull(tractorModel.price_usd),
            avg_usd: prices.length ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length) : numberOrNull(tractorModel.price_usd)
        };
        const hpStats = {
            min_hp: powers.length ? Math.min(...powers) : numberOrNull(tractorModel.horsepower),
            max_hp: powers.length ? Math.max(...powers) : numberOrNull(tractorModel.horsepower),
            avg_hp: powers.length ? Math.round((powers.reduce((sum, value) => sum + value, 0) / powers.length) * 10) / 10 : numberOrNull(tractorModel.horsepower)
        };

        const modelWindowFilter = `
            tv.tescil_yil IS NOT NULL
            AND tv.tescil_ay IS NOT NULL
            AND (tv.model_yili IS NULL OR tv.tescil_yil = tv.model_yili OR tv.tescil_yil = tv.model_yili + 1)
        `;
        const salesParams = [];
        const salesWhere = [modelWindowFilter];
        if (brandAliases.length) {
            salesParams.push(brandAliases);
            salesWhere.push(`UPPER(tv.marka) = ANY($${salesParams.length}::text[])`);
        }
        const salesModelNames = [...new Set([
            technicalRows[0]?.tuik_model_adi,
            tuikModelQuery,
            tractorModel.model_name,
            modelQuery
        ].map(normalizeModelSearch).filter(Boolean))];
        if (salesModelNames.length) {
            salesParams.push(salesModelNames.map(value => `%${value}%`));
            salesWhere.push(`tv.tuik_model_adi ILIKE ANY($${salesParams.length}::text[])`);
        }

        const salesWhereSql = salesWhere.join(' AND ');
        const shouldRunSales = Boolean(salesModelNames.length || brandAliases.length);
        const [
            salesSummaryRes,
            salesYearRes,
            salesProvinceRes,
            salesColorRes,
            salesModelYearRes,
            salesDisplacementRes
        ] = shouldRunSales
            ? await Promise.all([
                pool.query(`
                    SELECT
                        COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales,
                        COUNT(*)::int AS row_count,
                        MIN(tv.tescil_yil)::int AS first_year,
                        MAX(tv.tescil_yil)::int AS latest_year,
                        MAX(MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1)) AS latest_period
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql}
                `, salesParams),
                pool.query(`
                    SELECT tv.tescil_yil AS year, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql}
                    GROUP BY tv.tescil_yil
                    ORDER BY tv.tescil_yil
                `, salesParams),
                pool.query(`
                    SELECT tv.sehir_adi AS province_name, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql}
                    GROUP BY tv.sehir_adi
                    ORDER BY total_sales DESC
                    LIMIT 8
                `, salesParams),
                pool.query(`
                    SELECT NULLIF(TRIM(tv.renk), '') AS color, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql} AND NULLIF(TRIM(tv.renk), '') IS NOT NULL
                    GROUP BY NULLIF(TRIM(tv.renk), '')
                    ORDER BY total_sales DESC
                    LIMIT 6
                `, salesParams),
                pool.query(`
                    SELECT tv.model_yili AS model_year, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql} AND tv.model_yili IS NOT NULL
                    GROUP BY tv.model_yili
                    ORDER BY tv.model_yili DESC
                    LIMIT 8
                `, salesParams),
                pool.query(`
                    SELECT NULLIF(TRIM(tv.motor_hacmi_cc), '') AS displacement, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                    FROM tuik_veri tv
                    WHERE ${salesWhereSql} AND NULLIF(TRIM(tv.motor_hacmi_cc), '') IS NOT NULL
                    GROUP BY NULLIF(TRIM(tv.motor_hacmi_cc), '')
                    ORDER BY total_sales DESC
                    LIMIT 6
                `, salesParams)
            ])
            : [{ rows: [{}] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];

        const sourceUrl = requestedSourceUrl || inferKnownModelSourceUrl(effectiveBrandName, effectiveModelName);
        const externalSource = sourceUrl ? await fetchExternalModelSource(sourceUrl) : null;
        specGroups = buildModelIntelSpecGroups(primaryVariant, tractorModel, externalSource);
        const galleryTuikModelName = technicalRows[0]?.tuik_model_adi || tuikModelQuery || salesModelNames[0] || '';
        const persistedGallery = await getModelImageGalleryFromDb({
            brandName: effectiveBrandName,
            modelName: effectiveModelName,
            tuikModelName: galleryTuikModelName
        });
        const externalGallery = dedupeModelGallery([
            externalSource?.image_url
                ? {
                    url: externalSource.image_url,
                    label: `${externalSource.image_provider || externalSource.provider || 'Harici kaynak'} görseli`,
                    source: externalSource.image_source_url || externalSource.url || sourceUrl || '',
                    source_name: externalSource.image_provider || externalSource.provider || 'Harici kaynak',
                    model_match_level: externalSource.model_match_level || 'unknown',
                    verification_status: externalSource.verification_status || 'candidate',
                    review_status: externalSource.review_status || 'candidate',
                    confidence_score: externalSource.review_status === 'approved' ? 0.96 : 0.75,
                    is_primary: true
                }
                : null,
            ...(Array.isArray(externalSource?.image_gallery) ? externalSource.image_gallery : [])
        ]
            .filter(Boolean)
            .map((item, index) => sanitizeModelGalleryItem(item, {
                source_url: externalSource?.url || sourceUrl || '',
                source_name: externalSource?.provider || 'Harici kaynak',
                model_match_level: externalSource?.model_match_level || 'unknown',
                verification_status: externalSource?.verification_status || 'candidate',
                review_status: externalSource?.review_status || 'candidate'
            }, index))
            .filter(Boolean));
        const fallbackGallery = inferKnownModelImageGallery(effectiveBrandName, effectiveModelName);
        const callbackBase = getModelIntelRuntimeBase(req);
        const photoSearchPlan = buildModelPhotoSearchPlan({
            brandName: effectiveBrandName,
            modelName: effectiveModelName,
            tuikModelName: galleryTuikModelName,
            brandProfile: brandProfile || {},
            sourceUrl,
            callbackUrl: callbackBase ? `${callbackBase}/api/model-intelligence/gallery-callback` : ''
        });
        const candidateGallery = [
            ...persistedGallery,
            ...externalGallery,
            ...fallbackGallery
        ]
            .filter(Boolean)
            .filter((item, index, list) => list.findIndex(candidate => candidate.url === item.url) === index);
        const imageGallery = filterPublishableModelGallery(candidateGallery);
        const galleryStatus = {
            image_count: imageGallery.length,
            candidate_count: candidateGallery.length,
            blocked_candidate_count: Math.max(0, candidateGallery.length - imageGallery.length),
            persisted_count: persistedGallery.length,
            external_count: externalGallery.length,
            fallback_count: fallbackGallery.length,
            source: imageGallery.length ? (imageGallery[0].source_name || 'verified_gallery') : 'source_needed',
            source_label: imageGallery.length ? (imageGallery[0].source_name || 'Doğrulanmış model görseli') : 'Doğrulanmış model görseli bekleniyor',
            policy: 'Sadece onaylı, tam model eşleşmeli ve doğrulanmış görseller yayınlanır.',
            n8n_ready: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL),
            sync_endpoint: '/api/model-intelligence/gallery-sync'
        };
        const sourceLinks = buildModelIntelSearchLinks({
            brandName: effectiveBrandName,
            modelName: effectiveModelName,
            brandProfile: brandProfile || {}
        });
        if (sourceUrl && !sourceLinks.some(item => item.url === sourceUrl)) {
            sourceLinks.unshift({
                type: 'live-source',
                label: 'Canlı okunan teknik kaynak',
                url: sourceUrl,
                note: externalSource?.provider || 'Harici teknik kaynak'
            });
        }

        const dataCoverage = [
            { key: 'technical', label: 'Teknik çekirdek', status: mappedVariants.length ? 'ready' : 'missing', source: 'teknik_veri' },
            { key: 'sales', label: 'Model satış izi', status: Number(salesSummaryRes.rows[0]?.total_sales || 0) > 0 ? 'ready' : 'missing', source: 'tuik_veri' },
            { key: 'images', label: 'Fotoğraf/görsel', status: imageGallery.length ? 'ready' : 'source_needed', source: galleryStatus.source_label },
            { key: 'factory', label: 'Fabrika ve tedarik izi', status: primaryVariant.design?.origin ? 'partial' : 'source_needed', source: 'resmi marka kaynakları' },
            { key: 'used_market', label: 'Model yılı fiyat koridoru', status: 'source_linked', source: 'sahibinden.com araması' }
        ];

        const externalSpec = (label) => (externalSource?.specs || []).find(item => item.label === label)?.value || null;
        const sourceCards = [
            {
                label: 'Model görseli',
                value: imageGallery.length ? `${imageGallery.length} görsel hazır` : 'Görsel bekliyor',
                note: imageGallery.length
                    ? `${imageGallery[0].label} rapor vitrinine bağlandı; galeri ${galleryStatus.source_label} kaynağından besleniyor.`
                    : 'n8n taraması resmi ürün sayfası, katalog ve bayi kaynaklarından galeri adaylarını toplayabilir.',
                status: imageGallery.length ? 'ready' : 'source_needed'
            },
            {
                label: 'Teknik özellik kaynağı',
                value: externalSource?.specs?.length
                    ? `${externalSource.specs.length} harici alan`
                    : `${mappedVariants.length} teknik varyant`,
                note: externalSource?.specs?.length
                    ? `${externalSource.provider || 'Harici kaynak'} üzerinden motor, transmisyon, lastik, ağırlık ve emisyon alanları alındı.`
                    : 'Çekirdek teknik bilgiler teknik_veri tablosundan okunuyor.',
                status: externalSource?.specs?.length || mappedVariants.length ? 'ready' : 'missing'
            },
            {
                label: 'Motor ve aktarma',
                value: [
                    primaryVariant.engine?.brand || externalSpec('Motor imalatçısı'),
                    primaryVariant.engine?.power_hp ? `${primaryVariant.engine.power_hp} HP` : null,
                    externalSpec('Maksimum Tork'),
                    primaryVariant.transmission?.gear_config || externalSpec('Transmisyon') || externalSpec('Vites Seçeneği')
                ].filter(Boolean).join(' · ') || 'Kaynak bekliyor',
                note: 'Motor markası, güç ve vites mimarisi tek kartta özetlenir.',
                status: primaryVariant.engine?.brand || primaryVariant.engine?.power_hp || primaryVariant.transmission?.gear_config || externalSpec('Motor imalatçısı') ? 'ready' : 'source_needed'
            },
            {
                label: 'Fiyat bandı',
                value: priceStats.min_usd || priceStats.max_usd
                    ? (priceStats.min_usd !== priceStats.max_usd
                        ? `${formatModelIntelUsd(priceStats.min_usd)} - ${formatModelIntelUsd(priceStats.max_usd)}`
                        : formatModelIntelUsd(priceStats.avg_usd || priceStats.max_usd || priceStats.min_usd))
                    : 'Fiyat bekliyor',
                note: 'Fiyat kaynağı teknik_veri.fiyat_usd alanıdır.',
                status: priceStats.min_usd || priceStats.max_usd ? 'ready' : 'missing'
            },
            {
                label: 'Türkiye satış izi',
                value: `${Number(salesSummaryRes.rows[0]?.total_sales || 0).toLocaleString('tr-TR')} adet`,
                note: `${salesSummaryRes.rows[0]?.first_year || '-'}-${salesSummaryRes.rows[0]?.latest_year || '-'} aralığında tuik_veri N ve N-1 penceresi.`,
                status: Number(salesSummaryRes.rows[0]?.total_sales || 0) > 0 ? 'ready' : 'missing'
            },
            {
                label: 'Resmi kanal',
                value: brandProfile?.website_url || brandProfile?.website ? 'Marka sitesi var' : 'Resmi link bekliyor',
                note: brandProfile?.price_list_url
                    ? 'Marka portalında fiyat/katalog bağlantısı da tanımlı.'
                    : 'Resmi ürün sayfası ve katalog bağlantısı marka portal profilinden beslenir.',
                status: brandProfile?.website_url || brandProfile?.website ? 'ready' : 'source_needed'
            }
        ];

        const subsystemSignals = [
            {
                label: 'Motor',
                value: [
                    primaryVariant.engine?.brand || externalSpec('Motor Markası'),
                    primaryVariant.engine?.power_hp ? `${primaryVariant.engine.power_hp} HP` : externalSpec('Nominal Motor Gücü'),
                    externalSpec('Silindir Hacmi'),
                    externalSpec('Maksimum Tork'),
                    primaryVariant.engine?.emission || externalSpec('Emisyon Seviyesi')
                ].filter(Boolean).join(' · ') || null,
                note: 'Motor markası, güç, hacim, tork, devir ve emisyon bilgisi teknik veri/resmi kaynakla doğrulanır'
            },
            {
                label: 'Şanzıman',
                value: [
                    primaryVariant.transmission?.gear_config || tractorModel.gear_config || externalSpec('Vites Seçeneği'),
                    externalSpec('Dişli Kutusu Tipi'),
                    externalSpec('İleri - Geri Mekik Kolu')
                ].filter(Boolean).join(' · ') || null,
                note: 'Vites mimarisi, dişli kutusu tipi ve ileri-geri mekik bilgisi resmi kaynakla desteklenir'
            },
            {
                label: 'Kabin ve tasarım',
                value: [
                    primaryVariant.design?.protection || tractorModel.cabin_type,
                    primaryVariant.design?.drive_type || tractorModel.drive_type,
                    externalSpec('Kabin donanımı')
                ].filter(Boolean).join(' · ') || null,
                note: 'Kabin, çekiş ve konfor donanımları resmi ürün sayfasından tamamlanır'
            },
            {
                label: 'Lastik ve aks',
                value: [
                    [tractorModel.front_tire || externalSpec('1. Opsiyon 4WD-Ön'), tractorModel.rear_tire || externalSpec('1. Opsiyon 4WD-Arka')].filter(Boolean).join(' / '),
                    [externalSpec('2. Opsiyon 4WD-Ön'), externalSpec('2. Opsiyon 4WD-Arka')].filter(Boolean).join(' / ')
                ].filter(Boolean).join(' · ') || null,
                note: 'Lastik opsiyonları ve aks donanımı resmi katalog/ürün kaynağı üzerinden tamamlanır'
            },
            {
                label: 'Hidrolik/PTO',
                value: [
                    primaryVariant.hydraulics?.lift_capacity_kg ? `${primaryVariant.hydraulics.lift_capacity_kg} kg` : externalSpec('Kaldırma Kapasitesi'),
                    externalSpec('Hidrolik Güç Çıkışı'),
                    tractorModel.pto_rpm || externalSpec('Kuyruk Mili Devri'),
                    externalSpec('PTO Kumanda Şekli')
                ].filter(Boolean).join(' · ') || null,
                note: 'Kaldırma, hidrolik çıkış, PTO devri ve PTO kumandası tek sekmede izlenir'
            }
        ];

        res.json({
            profile: {
                brand_id: brandProfile?.id || tractorModel.brand_id || null,
                brand_name: effectiveBrandName || null,
                brand_slug: brandProfile?.slug || null,
                model_name: effectiveModelName || null,
                tuik_model_name: technicalRows[0]?.tuik_model_adi || tuikModelQuery || salesModelNames[0] || null,
                display_name: compactModelIntelText(`${effectiveBrandName} ${effectiveModelName}`),
                brand_color: brandProfile?.primary_color || tractorModel.primary_color || '#3b82f6',
                brand_logo_url: brandProfile?.logo_url || tractorModel.logo_url || null,
                country_of_origin: brandProfile?.country_of_origin || null,
                parent_company: brandProfile?.parent_company || null,
                headquarters: brandProfile?.headquarters || null
            },
            metrics: {
                variant_count: mappedVariants.length,
                tractor_model_count: tractorModelRes.rows.length,
                price: priceStats,
                horsepower: hpStats
            },
            spec_groups: specGroups,
            variants: mappedVariants,
            catalog_models: tractorModelRes.rows,
            sales: {
                summary: salesSummaryRes.rows[0] || {},
                yearly: salesYearRes.rows,
                top_provinces: salesProvinceRes.rows,
                colors: salesColorRes.rows,
                model_years: salesModelYearRes.rows,
                displacements: salesDisplacementRes.rows
            },
            subsystem_signals: subsystemSignals,
            external_source: externalSource,
            image_gallery: imageGallery,
            gallery_status: galleryStatus,
            photo_search_plan: photoSearchPlan,
            source_cards: sourceCards,
            source_links: sourceLinks,
            data_coverage: dataCoverage,
            automation: {
                n8n_model_intel_webhook_configured: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL),
                suggested_payload: {
                    ...photoSearchPlan,
                    brand: effectiveBrandName,
                    model: effectiveModelName,
                    tuik_model_adi: technicalRows[0]?.tuik_model_adi || null,
                    source_url: sourceUrl || null,
                    tasks: ['official_product_page', 'photo_gallery', 'factory_supply_chain', 'transmission_detail', 'used_market_price_by_model_year']
                }
            },
            meta: {
                generated_at: new Date().toISOString(),
                primary_sources: ['teknik_veri', 'tuik_veri', 'tractor_models'],
                model_window_note: 'Model bazlı satış izi N ve N-1 kuralına göre tuik_veri üzerinden hesaplandı.',
                source_url: sourceUrl || null
            }
        });
    } catch (err) {
        console.error('Model intelligence error:', err);
        res.status(500).json({ error: 'Model röntgen raporu hazırlanamadı' });
    }
});

app.post('/api/model-intelligence/gallery-sync', authMiddleware, async (req, res) => {
    try {
        const body = req.body || {};
        const brandId = body.brand_id ? parseInt(body.brand_id, 10) : null;
        let brandName = normalizeModelSearch(body.brand || body.brand_name || '');
        const modelName = normalizeModelSearch(body.model || body.model_name || body.q || '');
        const tuikModelName = normalizeModelSearch(body.tuik_model_adi || body.tuik_model_name || modelName);
        const sourceUrl = normalizeModelImageUrl(body.source_url || '');

        let brandProfile = null;
        if (brandId || brandName) {
            const profileWhere = brandId
                ? 'b.id = $1'
                : '(UPPER(b.name) = UPPER($1) OR b.slug = LOWER($1))';
            const profileRes = await pool.query(`
                SELECT
                    b.id, b.name, b.slug, b.website,
                    p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url
                FROM brands b
                LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                WHERE ${profileWhere}
                LIMIT 1
            `, [brandId || brandName]);
            brandProfile = profileRes.rows[0] || null;
            brandName = brandName || brandProfile?.name || '';
        }

        if (!brandName || !modelName) {
            return res.status(400).json({ error: 'Galeri taraması için marka ve model gerekli' });
        }

        const callbackBase = getModelIntelRuntimeBase(req);
        const photoSearchPlan = buildModelPhotoSearchPlan({
            brandName,
            modelName,
            tuikModelName,
            brandProfile: brandProfile || {},
            sourceUrl,
            callbackUrl: callbackBase ? `${callbackBase}/api/model-intelligence/gallery-callback` : ''
        });
        const existingImages = await getModelImageGalleryFromDb({ brandName, modelName, tuikModelName });

        if (!N8N_MODEL_INTEL_WEBHOOK_URL) {
            return res.json({
                status: 'not_configured',
                message: 'N8N_MODEL_INTEL_WEBHOOK_URL tanımlanınca galeri taraması bu uçtan tetiklenir.',
                images: existingImages,
                new_images: [],
                photo_search_plan: photoSearchPlan
            });
        }

        const n8nResult = await fetchN8nModelImageGallery({
            ...photoSearchPlan,
            requested_by: {
                id: req.user?.id || null,
                email: req.user?.email || null,
                role: req.user?.role || null
            },
            requested_at: new Date().toISOString()
        });
        const savedImages = n8nResult.images.length
            ? await upsertModelImageGallery({ brandName, modelName, tuikModelName, images: n8nResult.images })
            : [];
        const publishableSavedImages = filterPublishableModelGallery(savedImages);
        const mergedImages = filterPublishableModelGallery([...publishableSavedImages, ...existingImages]);

        res.json({
            status: n8nResult.status,
            error: n8nResult.error || null,
            images: mergedImages,
            new_images: publishableSavedImages,
            candidate_count: savedImages.length,
            blocked_candidate_count: Math.max(0, savedImages.length - publishableSavedImages.length),
            photo_search_plan: photoSearchPlan,
            n8n: {
                configured: true,
                image_count: n8nResult.images.length,
                raw_status: n8nResult.raw?.status || null
            }
        });
    } catch (err) {
        console.error('Model gallery sync error:', err);
        res.status(500).json({ error: 'Model fotoğraf galerisi taraması başlatılamadı' });
    }
});

app.post('/api/model-intelligence/gallery-callback', async (req, res) => {
    try {
        const webhookKey = req.get('x-webhook-key') || req.get('x-media-watch-key') || req.query.key || '';
        if (!MEDIA_WATCH_WEBHOOK_KEY) {
            return res.status(503).json({ error: 'Webhook anahtarı yapılandırılmadı' });
        }
        if (webhookKey !== MEDIA_WATCH_WEBHOOK_KEY) {
            return res.status(401).json({ error: 'Yetkisiz webhook' });
        }

        const body = req.body || {};
        const brandName = normalizeModelSearch(body.brand || body.brand_name || '');
        const modelName = normalizeModelSearch(body.model || body.model_name || '');
        const tuikModelName = normalizeModelSearch(body.tuik_model_adi || body.tuik_model_name || modelName);
        const images = body.images || body.image_gallery || body.gallery || [];

        if (!brandName || !modelName || !Array.isArray(images) || !images.length) {
            return res.status(400).json({ error: 'brand, model ve images alanları gerekli' });
        }

        const savedImages = await upsertModelImageGallery({ brandName, modelName, tuikModelName, images });
        res.json({
            ok: true,
            saved_count: savedImages.length,
            images: savedImages
        });
    } catch (err) {
        console.error('Model gallery callback error:', err);
        res.status(500).json({ error: 'Model fotoğraf galerisi kaydedilemedi' });
    }
});

// ============================================
// MODEL IMAGE ADMIN — Marka Merkezi Görsel Yönetimi
// (anayasa: skills/model-gorsel-dogruluk-anayasasi/SKILL.md)
// ============================================

// Coverage: marka bazında fotoğrafı olan / olmayan model sayısı
app.get('/api/admin/model-images/coverage', authMiddleware, adminOnly, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                b.id AS brand_id,
                b.name AS brand_name,
                b.slug AS brand_slug,
                COUNT(DISTINCT tm.model_name) AS total_models,
                COUNT(DISTINCT CASE
                    WHEN mig.id IS NOT NULL THEN tm.model_name
                END) AS covered_models,
                COUNT(DISTINCT CASE
                    WHEN cand.id IS NOT NULL AND cand.review_status = 'candidate' THEN tm.model_name
                END) AS pending_models
            FROM brands b
            LEFT JOIN tractor_models tm ON tm.brand_id = b.id
            LEFT JOIN model_image_gallery mig
                ON UPPER(mig.brand_name) = UPPER(b.name)
                AND UPPER(mig.model_name) = UPPER(tm.model_name)
                AND mig.is_active = true
                AND mig.review_status = 'approved'
            LEFT JOIN model_image_gallery cand
                ON UPPER(cand.brand_name) = UPPER(b.name)
                AND UPPER(cand.model_name) = UPPER(tm.model_name)
                AND cand.is_active = true
            GROUP BY b.id, b.name, b.slug
            ORDER BY b.name
        `);

        const rows = result.rows.map(r => ({
            brand_id: Number(r.brand_id),
            brand_name: r.brand_name,
            brand_slug: r.brand_slug,
            total_models: Number(r.total_models || 0),
            covered_models: Number(r.covered_models || 0),
            pending_models: Number(r.pending_models || 0),
            missing_models: Math.max(0, Number(r.total_models || 0) - Number(r.covered_models || 0)),
            coverage_pct: r.total_models ? Number((Number(r.covered_models) / Number(r.total_models) * 100).toFixed(1)) : 0
        }));

        const overall = rows.reduce((acc, row) => {
            acc.total += row.total_models;
            acc.covered += row.covered_models;
            acc.pending += row.pending_models;
            return acc;
        }, { total: 0, covered: 0, pending: 0 });

        res.json({
            overall: {
                ...overall,
                missing: Math.max(0, overall.total - overall.covered),
                coverage_pct: overall.total ? Number((overall.covered / overall.total * 100).toFixed(1)) : 0
            },
            by_brand: rows,
            bridge: {
                configured: Boolean(MODEL_IMAGE_BRIDGE_URL),
                url: MODEL_IMAGE_BRIDGE_URL,
                n8n_webhook: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL)
            }
        });
    } catch (err) {
        console.error('Model image coverage error:', err);
        res.status(500).json({ error: 'Coverage hesaplanamadı' });
    }
});

// Onay bekleyen aday görseller
app.get('/api/admin/model-images/pending', authMiddleware, adminOnly, async (req, res) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 60);
        const brandFilter = compactModelIntelText(req.query.brand || '');
        const params = [];
        let where = "WHERE is_active = true AND review_status = 'candidate'";
        if (brandFilter) {
            params.push(brandFilter);
            where += ` AND UPPER(brand_name) = UPPER($${params.length})`;
        }
        params.push(limit);

        const result = await pool.query(`
            SELECT id, brand_name, model_name, tuik_model_adi, image_url, source_url, source_name,
                   angle_label, caption, width, height, confidence_score, model_match_level,
                   verification_status, review_status, raw_payload, created_at, updated_at
            FROM model_image_gallery
            ${where}
            ORDER BY confidence_score DESC NULLS LAST, created_at DESC
            LIMIT $${params.length}
        `, params);

        res.json({
            count: result.rows.length,
            items: result.rows.map(row => ({
                ...row,
                confidence_score: row.confidence_score === null ? null : Number(row.confidence_score),
                raw_payload: typeof row.raw_payload === 'object' ? row.raw_payload : null
            }))
        });
    } catch (err) {
        console.error('Model image pending error:', err);
        res.status(500).json({ error: 'Aday görseller okunamadı' });
    }
});

// Eksik (fotoğrafsız) modeller
app.get('/api/admin/model-images/missing', authMiddleware, adminOnly, async (req, res) => {
    try {
        const limit = Math.min(500, parseInt(req.query.limit, 10) || 80);
        const brandFilter = compactModelIntelText(req.query.brand || '');
        const params = [];
        let where = '';
        if (brandFilter) {
            params.push(brandFilter);
            where = `AND UPPER(b.name) = UPPER($${params.length})`;
        }
        params.push(limit);

        const result = await pool.query(`
            SELECT b.name AS brand_name, b.slug AS brand_slug, tm.model_name,
                   tv.tuik_model_adi,
                   COUNT(cand.id) AS candidate_count
            FROM tractor_models tm
            JOIN brands b ON b.id = tm.brand_id
            LEFT JOIN teknik_veri tv ON UPPER(tv.marka) = UPPER(b.name)
                AND UPPER(tv.tuik_model_adi) = UPPER(tm.model_name)
            LEFT JOIN model_image_gallery cand
                ON UPPER(cand.brand_name) = UPPER(b.name)
                AND UPPER(cand.model_name) = UPPER(tm.model_name)
                AND cand.is_active = true
                AND cand.review_status = 'candidate'
            WHERE NOT EXISTS (
                SELECT 1 FROM model_image_gallery mig
                WHERE UPPER(mig.brand_name) = UPPER(b.name)
                  AND UPPER(mig.model_name) = UPPER(tm.model_name)
                  AND mig.is_active = true
                  AND mig.review_status = 'approved'
            )
            ${where}
            GROUP BY b.name, b.slug, tm.model_name, tv.tuik_model_adi
            ORDER BY b.name, tm.model_name
            LIMIT $${params.length}
        `, params);

        res.json({
            count: result.rows.length,
            items: result.rows.map(r => ({
                brand_name: r.brand_name,
                brand_slug: r.brand_slug,
                model_name: r.model_name,
                tuik_model_adi: r.tuik_model_adi,
                candidate_count: Number(r.candidate_count || 0)
            }))
        });
    } catch (err) {
        console.error('Model image missing error:', err);
        res.status(500).json({ error: 'Eksik modeller okunamadı' });
    }
});

// Manuel onay — anayasa kuralına uygun değerleri yazar
app.post('/api/admin/model-images/:id/approve', authMiddleware, adminOnly, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Geçersiz id' });
        const setPrimary = req.body?.is_primary === true;

        const result = await pool.query(`
            UPDATE model_image_gallery
            SET review_status = 'approved',
                verification_status = 'manual_approved',
                model_match_level = CASE
                    WHEN model_match_level IN ('exact_product_page','exact_model','manual_verified') THEN model_match_level
                    ELSE 'manual_verified'
                END,
                confidence_score = GREATEST(COALESCE(confidence_score, 0), 0.90),
                verified_at = NOW(),
                is_primary = CASE WHEN $2 THEN true ELSE is_primary END,
                is_active = true,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, setPrimary]);

        if (!result.rows.length) return res.status(404).json({ error: 'Görsel bulunamadı' });

        if (setPrimary) {
            await pool.query(`
                UPDATE model_image_gallery
                SET is_primary = false
                WHERE id <> $1
                  AND UPPER(brand_name) = UPPER($2)
                  AND UPPER(model_name) = UPPER($3)
            `, [id, result.rows[0].brand_name, result.rows[0].model_name]);
        }

        res.json({ ok: true, image: result.rows[0] });
    } catch (err) {
        console.error('Model image approve error:', err);
        res.status(500).json({ error: 'Onay başarısız' });
    }
});

// Manuel red
app.post('/api/admin/model-images/:id/reject', authMiddleware, adminOnly, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Geçersiz id' });
        const reason = compactModelIntelText(req.body?.reason || '').slice(0, 240);

        const result = await pool.query(`
            UPDATE model_image_gallery
            SET review_status = 'rejected',
                verification_status = 'rejected',
                is_active = false,
                is_primary = false,
                raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, brand_name, model_name, image_url, review_status
        `, [id, JSON.stringify({ rejection_reason: reason, rejected_at: new Date().toISOString() })]);

        if (!result.rows.length) return res.status(404).json({ error: 'Görsel bulunamadı' });
        res.json({ ok: true, image: result.rows[0] });
    } catch (err) {
        console.error('Model image reject error:', err);
        res.status(500).json({ error: 'Red başarısız' });
    }
});

// Bridge tetikleme — tek model
app.post('/api/admin/model-images/sync', authMiddleware, adminOnly, async (req, res) => {
    try {
        const brand = compactModelIntelText(req.body?.brand || '');
        const model = compactModelIntelText(req.body?.model || '');
        const tuik = compactModelIntelText(req.body?.tuik_model_adi || model);
        if (!brand || !model) return res.status(400).json({ error: 'brand ve model gerekli' });
        if (!MEDIA_WATCH_WEBHOOK_KEY) return res.status(503).json({ error: 'MEDIA_WATCH_WEBHOOK_KEY yapılandırılmadı' });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        try {
            const response = await fetch(`${MODEL_IMAGE_BRIDGE_URL}/sync-model`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY },
                body: JSON.stringify({ brand, model, tuik_model_adi: tuik, run_id: `admin_${Date.now()}_${req.user.id}` })
            });
            const text = await response.text();
            const data = text ? JSON.parse(text) : {};
            if (!response.ok) return res.status(response.status).json({ error: 'bridge_error', detail: data });
            res.json({ ok: true, bridge: data });
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        console.error('Model image sync error:', err);
        res.status(502).json({ error: 'Bridge çağrısı başarısız', detail: err.message });
    }
});

// Bridge tetikleme — toplu eksik tarama
app.post('/api/admin/model-images/sync-missing', authMiddleware, adminOnly, async (req, res) => {
    try {
        if (!MEDIA_WATCH_WEBHOOK_KEY) return res.status(503).json({ error: 'MEDIA_WATCH_WEBHOOK_KEY yapılandırılmadı' });
        const limit = Math.min(50, parseInt(req.body?.limit, 10) || 12);
        const brand = compactModelIntelText(req.body?.brand || '');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        try {
            const response = await fetch(`${MODEL_IMAGE_BRIDGE_URL}/sync-missing`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY },
                body: JSON.stringify({ limit, brand: brand || undefined, run_id: `admin_bulk_${Date.now()}_${req.user.id}` })
            });
            const text = await response.text();
            const data = text ? JSON.parse(text) : {};
            if (!response.ok) return res.status(response.status).json({ error: 'bridge_error', detail: data });
            res.json({ ok: true, bridge: data });
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        console.error('Model image bulk sync error:', err);
        res.status(502).json({ error: 'Bridge toplu çağrısı başarısız', detail: err.message });
    }
});

// n8n / bridge log alıcısı (run trace kaydı)
app.post('/api/admin/model-images/log', async (req, res) => {
    try {
        const webhookKey = req.get('x-webhook-key') || req.get('x-media-watch-key') || req.query.key || '';
        if (!MEDIA_WATCH_WEBHOOK_KEY || webhookKey !== MEDIA_WATCH_WEBHOOK_KEY) {
            return res.status(401).json({ error: 'Yetkisiz' });
        }
        const summary = req.body?.summary || null;
        const trace = req.body?.trace || null;
        if (summary) {
            console.log('[model-image-run]', JSON.stringify(summary));
        }
        // Trace'i hafif tutmak için sadece ilk 80 satırını sakla
        const compactTrace = trace ? {
            run_id: trace.run_id || summary?.run_id || null,
            started_at: trace.started_at || null,
            finished_at: trace.finished_at || summary?.finished_at || null,
            results: Array.isArray(trace.results) ? trace.results.slice(0, 80) : null
        } : null;
        res.json({ ok: true, recorded: Boolean(summary || compactTrace) });
    } catch (err) {
        console.error('Model image log error:', err);
        res.status(500).json({ error: 'Log alınamadı' });
    }
});

// ============================================
// WEATHER
// ============================================
app.get('/api/weather/:province_id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM weather_data WHERE province_id = $1
            ORDER BY date DESC LIMIT 14
        `, [req.params.province_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/weather/:province_id/forecast', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM weather_data WHERE province_id = $1 AND is_forecast = true
            ORDER BY date ASC LIMIT 7
        `, [req.params.province_id]);
        if (result.rows.length) {
            return res.json(result.rows);
        }

        const province = await getEnrichedProvinceById(req.params.province_id);
        if (!province) {
            return res.json([]);
        }

        const referenceProfile = getProvinceReferenceArchetype(province);
        return res.json(buildProvinceReferenceForecastRows(province, referenceProfile));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// CLIMATE ANALYSIS (10 Year)
// ============================================
app.get('/api/climate/:province_id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM climate_analysis WHERE province_id = $1
            ORDER BY year DESC, month
        `, [req.params.province_id]);
        if (result.rows.length) {
            return res.json(result.rows);
        }

        const province = await getEnrichedProvinceById(req.params.province_id);
        if (!province) {
            return res.json([]);
        }

        const referenceProfile = getProvinceReferenceArchetype(province);
        return res.json(buildProvinceReferenceClimateRows(referenceProfile, new Date().getFullYear()));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// SOIL & CROP DATA
// ============================================
app.get('/api/soil/:province_id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM soil_data WHERE province_id = $1', [req.params.province_id]);
        if (result.rows.length) {
            return res.json(result.rows);
        }

        const province = await getEnrichedProvinceById(req.params.province_id);
        if (!province) {
            return res.json([]);
        }

        const referenceProfile = getProvinceReferenceArchetype(province);
        return res.json(buildProvinceFallbackSoils(
            province,
            referenceProfile,
            referenceProfile.dominant_hp_range,
            referenceProfile.dominant_tractor_type,
            referenceProfile.dominant_drive_type
        ));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/crops/:province_id', authMiddleware, async (req, res) => {
    try {
        const { year } = req.query;
        const targetYear = year || new Date().getFullYear();
        const result = await pool.query(
            'SELECT * FROM crop_data WHERE province_id = $1 AND year = $2 ORDER BY cultivation_area_hectare DESC',
            [req.params.province_id, targetYear]
        );
        if (result.rows.length) {
            return res.json(result.rows);
        }

        const province = await getEnrichedProvinceById(req.params.province_id);
        if (!province) {
            return res.json([]);
        }

        const referenceProfile = getProvinceReferenceArchetype(province);
        return res.json(buildProvinceFallbackCrops(province, referenceProfile, Number(targetYear)));
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

const PROVINCE_REFERENCE_ARCHETYPES = {
    akdeniz: {
        label: 'Akdeniz referans profili',
        climate_zone: 'Akdeniz gecis kusagi',
        annual_rainfall_mm: 720,
        avg_temperature: 18.8,
        elevation_m: 140,
        agricultural_area_hectare: 265000,
        soil_type: 'Aluvyal / killi-tinli',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '75-105 HP',
        primary_crops: [
            { name: 'Pamuk', type: 'endustriyel', share: 0.24, yield_ton_per_ha: 4.8, hp_min: 95, hp_max: 125, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
            { name: 'Misir', type: 'tahil', share: 0.22, yield_ton_per_ha: 9.5, hp_min: 85, hp_max: 115, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
            { name: 'Narenciye', type: 'meyve', share: 0.18, yield_ton_per_ha: 25, hp_min: 55, hp_max: 85, planting_season: 'Yillik', harvest_season: 'Kas-Oca', tractor_types: ['bahce', 'dar'] },
            { name: 'Acik alan sebze', type: 'sebze', share: 0.16, yield_ton_per_ha: 30, hp_min: 50, hp_max: 75, planting_season: 'Sub-Nis', harvest_season: 'Haz-Eki', tractor_types: ['hibrit', 'bahce'] }
        ],
        soil_layers: [
            { soil_type: 'Aluvyal tarla zemini', soil_texture: 'Tinli-killi', ph_level: 7.1, organic_matter_pct: 2.2, hp_range: '80-110 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sulama ve agir ekipman gecislerinde cekis kaybi dusurulmeli.' },
            { soil_type: 'Bahce tabani', soil_texture: 'Tinli', ph_level: 6.8, organic_matter_pct: 2.5, hp_range: '55-80 HP', tractor_type: 'bahce', drive_type: '2WD', note: 'Sira arasi manevra ve dusuk agirlikli paketler verimlidir.' }
        ],
        monthly_temp: [10, 11, 13, 17, 21, 26, 29, 29, 26, 21, 15, 11],
        monthly_rain: [110, 90, 70, 45, 25, 10, 4, 5, 15, 45, 80, 105],
        monthly_humidity: [70, 68, 66, 63, 60, 58, 56, 57, 59, 63, 67, 70],
        monthly_frost: [1.2, 0.8, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.8],
        monthly_drought: [-0.4, -0.2, 0.1, 0.4, 0.8, 1.1, 1.3, 1.2, 0.7, 0.2, -0.1, -0.3],
        monthly_gdd: [40, 55, 95, 160, 240, 320, 380, 370, 290, 190, 90, 45]
    },
    ege: {
        label: 'Ege referans profili',
        climate_zone: 'Ege - Akdeniz gecisi',
        annual_rainfall_mm: 690,
        avg_temperature: 17.1,
        elevation_m: 180,
        agricultural_area_hectare: 240000,
        soil_type: 'Tinli / kumlu-tinli',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'hibrit',
        dominant_hp_range: '65-95 HP',
        primary_crops: [
            { name: 'Zeytin', type: 'meyve', share: 0.20, yield_ton_per_ha: 3.8, hp_min: 50, hp_max: 80, planting_season: 'Yillik', harvest_season: 'Kas-Oca', tractor_types: ['bahce', 'dar'] },
            { name: 'Uzum', type: 'meyve', share: 0.16, yield_ton_per_ha: 9, hp_min: 45, hp_max: 75, planting_season: 'Yillik', harvest_season: 'Agu-Eyl', tractor_types: ['bahce', 'dar'] },
            { name: 'Pamuk', type: 'endustriyel', share: 0.18, yield_ton_per_ha: 4.4, hp_min: 90, hp_max: 120, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
            { name: 'Misir silaj', type: 'yem', share: 0.14, yield_ton_per_ha: 10.5, hp_min: 75, hp_max: 105, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', 'hibrit'] }
        ],
        soil_layers: [
            { soil_type: 'Bag-bahce zemini', soil_texture: 'Tinli', ph_level: 6.9, organic_matter_pct: 2.1, hp_range: '50-80 HP', tractor_type: 'bahce', drive_type: '2WD', note: 'Dar iz ve PTO operasyonlari on plandadir.' },
            { soil_type: 'Ova tarla zemini', soil_texture: 'Kumlu-tinli', ph_level: 7.0, organic_matter_pct: 1.9, hp_range: '75-105 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Yuksek sezon temposunda cekis ve tasima kapasitesi kritik olur.' }
        ],
        monthly_temp: [8, 9, 12, 16, 21, 26, 29, 29, 24, 19, 13, 9],
        monthly_rain: [95, 80, 65, 45, 30, 15, 6, 6, 15, 45, 75, 95],
        monthly_humidity: [72, 70, 68, 64, 60, 56, 53, 54, 58, 63, 68, 72],
        monthly_frost: [2, 1.2, 0.4, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1.6],
        monthly_drought: [-0.3, -0.1, 0.1, 0.4, 0.7, 0.9, 1.1, 1.0, 0.6, 0.2, 0, -0.2],
        monthly_gdd: [25, 40, 80, 150, 230, 310, 360, 355, 270, 170, 80, 35]
    },
    marmara: {
        label: 'Marmara referans profili',
        climate_zone: 'Marmara dengeli iklim',
        annual_rainfall_mm: 760,
        avg_temperature: 14.6,
        elevation_m: 220,
        agricultural_area_hectare: 210000,
        soil_type: 'Tinli / killi-tinli',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '70-100 HP',
        primary_crops: [
            { name: 'Bugday', type: 'tahil', share: 0.22, yield_ton_per_ha: 5.6, hp_min: 70, hp_max: 95, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla'] },
            { name: 'Aycicegi', type: 'endustriyel', share: 0.20, yield_ton_per_ha: 2.6, hp_min: 75, hp_max: 105, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
            { name: 'Misir', type: 'tahil', share: 0.16, yield_ton_per_ha: 9.2, hp_min: 80, hp_max: 110, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['tarla', '4wd'] },
            { name: 'Sebze', type: 'sebze', share: 0.12, yield_ton_per_ha: 26, hp_min: 45, hp_max: 70, planting_season: 'Sub-Nis', harvest_season: 'Haz-Eki', tractor_types: ['hibrit'] }
        ],
        soil_layers: [
            { soil_type: 'Ova tarla zemini', soil_texture: 'Killi-tinli', ph_level: 6.8, organic_matter_pct: 2.4, hp_range: '75-105 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sonbahar ve ilkbahar yagislari cekis tarafini belirginlestirir.' },
            { soil_type: 'Bahce-parsel zemini', soil_texture: 'Tinli', ph_level: 6.6, organic_matter_pct: 2.7, hp_range: '50-75 HP', tractor_type: 'hibrit', drive_type: '2WD', note: 'Kompakt ve manevrasi guclu setup daha verimli olur.' }
        ],
        monthly_temp: [5, 6, 9, 14, 18, 23, 26, 26, 21, 16, 10, 7],
        monthly_rain: [85, 70, 65, 55, 45, 35, 25, 20, 35, 60, 75, 90],
        monthly_humidity: [76, 74, 72, 69, 66, 64, 61, 62, 67, 71, 74, 76],
        monthly_frost: [4, 3, 1.5, 0.4, 0, 0, 0, 0, 0, 0.8, 2.2, 3.5],
        monthly_drought: [-0.2, -0.1, 0, 0.2, 0.4, 0.6, 0.8, 0.7, 0.3, 0.1, -0.1, -0.2],
        monthly_gdd: [10, 20, 55, 115, 190, 270, 320, 315, 225, 130, 50, 18]
    },
    'ic anadolu': {
        label: 'İç Anadolu referans profili',
        climate_zone: 'Karasal - kurak iç bölge',
        annual_rainfall_mm: 410,
        avg_temperature: 11.5,
        elevation_m: 980,
        agricultural_area_hectare: 380000,
        soil_type: 'Kireçli / killi-tinli',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '80-110 HP',
        primary_crops: [
            { name: 'Buğday', type: 'tahil', share: 0.30, yield_ton_per_ha: 4.2, hp_min: 80, hp_max: 105, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla', '4wd'] },
            { name: 'Arpa', type: 'tahil', share: 0.18, yield_ton_per_ha: 3.8, hp_min: 75, hp_max: 100, planting_season: 'Eki-Kas', harvest_season: 'Haz', tractor_types: ['tarla'] },
            { name: 'Şeker pancarı', type: 'endustriyel', share: 0.16, yield_ton_per_ha: 7.5, hp_min: 95, hp_max: 125, planting_season: 'Mar-Nis', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
            { name: 'Yonca', type: 'yem', share: 0.12, yield_ton_per_ha: 8.5, hp_min: 65, hp_max: 90, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['tarla', 'hibrit'] }
        ],
        soil_layers: [
            { soil_type: 'Kireçli ova zemini', soil_texture: 'Killi-tinli', ph_level: 7.8, organic_matter_pct: 1.5, hp_range: '85-115 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Kuraklık ve ağır çekiş gerektiren ekipmanlar güç rezervini ön plana çıkarır.' },
            { soil_type: 'Kuru tarım parçası', soil_texture: 'Tinli', ph_level: 7.5, organic_matter_pct: 1.4, hp_range: '70-95 HP', tractor_type: 'tarla', drive_type: '2WD', note: 'Düşük yakıtlı, ekonomik ve uzun iş günlerine uygun platformlar tercih edilir.' }
        ],
        monthly_temp: [-1, 1, 5, 11, 16, 21, 25, 25, 19, 12, 5, 0],
        monthly_rain: [40, 35, 38, 45, 50, 30, 12, 10, 18, 28, 32, 38],
        monthly_humidity: [74, 70, 65, 60, 55, 50, 44, 42, 46, 55, 66, 73],
        monthly_frost: [10, 7, 4, 1, 0, 0, 0, 0, 0.2, 1.5, 4.5, 8],
        monthly_drought: [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.2, 1.3, 0.9, 0.5, 0.3, 0.2],
        monthly_gdd: [0, 5, 25, 85, 160, 240, 310, 300, 210, 110, 30, 5]
    },
    karadeniz: {
        label: 'Karadeniz referans profili',
        climate_zone: 'Nemli Karadeniz iklimi',
        annual_rainfall_mm: 1080,
        avg_temperature: 13.2,
        elevation_m: 420,
        agricultural_area_hectare: 145000,
        soil_type: 'Asidik tinli / organik zengin',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'bahce',
        dominant_hp_range: '55-80 HP',
        primary_crops: [
            { name: 'Findik', type: 'meyve', share: 0.24, yield_ton_per_ha: 2.2, hp_min: 45, hp_max: 70, planting_season: 'Yillik', harvest_season: 'Agu-Eyl', tractor_types: ['bahce', 'dar'] },
            { name: 'Misir', type: 'tahil', share: 0.18, yield_ton_per_ha: 7.4, hp_min: 60, hp_max: 85, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['hibrit', '4wd'] },
            { name: 'Cay', type: 'meyve', share: 0.16, yield_ton_per_ha: 4.1, hp_min: 40, hp_max: 60, planting_season: 'Yillik', harvest_season: 'May-Eki', tractor_types: ['bahce', 'dar'] },
            { name: 'Yem bitkileri', type: 'yem', share: 0.14, yield_ton_per_ha: 8, hp_min: 55, hp_max: 80, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['hibrit'] }
        ],
        soil_layers: [
            { soil_type: 'Yamac bahce zemini', soil_texture: 'Tinli', ph_level: 6.3, organic_matter_pct: 3.1, hp_range: '45-70 HP', tractor_type: 'bahce', drive_type: '4WD', note: 'Egim ve nem, 4WD dar sasi platformlarini one cikarir.' },
            { soil_type: 'Nemli ova zemini', soil_texture: 'Milli-tinli', ph_level: 6.5, organic_matter_pct: 3.4, hp_range: '60-85 HP', tractor_type: 'hibrit', drive_type: '4WD', note: 'Yagisli donemlerde cekis ve zemin basinci dikkatle yonetilmelidir.' }
        ],
        monthly_temp: [7, 7, 8, 11, 15, 20, 23, 24, 21, 17, 13, 9],
        monthly_rain: [95, 80, 75, 65, 60, 55, 45, 45, 55, 80, 95, 105],
        monthly_humidity: [78, 78, 79, 78, 77, 76, 75, 76, 77, 79, 80, 80],
        monthly_frost: [3, 2, 1.2, 0.4, 0, 0, 0, 0, 0, 0.4, 1.2, 2.4],
        monthly_drought: [-0.5, -0.5, -0.4, -0.2, 0, 0.1, 0.2, 0.2, 0, -0.1, -0.3, -0.4],
        monthly_gdd: [8, 12, 25, 70, 130, 210, 260, 270, 210, 140, 70, 25]
    },
    'dogu anadolu': {
        label: 'Dogu Anadolu referans profili',
        climate_zone: 'Yuksek rakim karasal iklim',
        annual_rainfall_mm: 470,
        avg_temperature: 8.4,
        elevation_m: 1450,
        agricultural_area_hectare: 210000,
        soil_type: 'Killi / tasil orgulu',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '75-105 HP',
        primary_crops: [
            { name: 'Arpa', type: 'tahil', share: 0.24, yield_ton_per_ha: 3.5, hp_min: 70, hp_max: 95, planting_season: 'Nis-May', harvest_season: 'Agu', tractor_types: ['tarla', '4wd'] },
            { name: 'Bugday', type: 'tahil', share: 0.20, yield_ton_per_ha: 3.8, hp_min: 75, hp_max: 100, planting_season: 'Nis-May', harvest_season: 'Agu', tractor_types: ['tarla', '4wd'] },
            { name: 'Patates', type: 'sebze', share: 0.12, yield_ton_per_ha: 20, hp_min: 65, hp_max: 90, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['hibrit', '4wd'] },
            { name: 'Yem bitkileri', type: 'yem', share: 0.16, yield_ton_per_ha: 7.2, hp_min: 60, hp_max: 85, planting_season: 'May', harvest_season: 'Tem-Eyl', tractor_types: ['tarla'] }
        ],
        soil_layers: [
            { soil_type: 'Yuksek rakim tarla zemini', soil_texture: 'Killi', ph_level: 7.3, organic_matter_pct: 2.0, hp_range: '80-110 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Kisa sezon ve cekis ihtiyaci nedeniyle guc rezervi onemlidir.' },
            { soil_type: 'Serin mera / yem parcasi', soil_texture: 'Tinli', ph_level: 7.0, organic_matter_pct: 2.4, hp_range: '60-85 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Balya ve tasima icin PTO verimi guclu setuplar daha anlamlidir.' }
        ],
        monthly_temp: [-6, -4, 1, 8, 13, 18, 22, 22, 17, 10, 2, -3],
        monthly_rain: [55, 50, 55, 70, 75, 40, 18, 12, 20, 35, 45, 52],
        monthly_humidity: [72, 70, 66, 60, 57, 52, 48, 46, 50, 58, 66, 71],
        monthly_frost: [16, 13, 8, 3, 0.4, 0, 0, 0, 0.6, 3, 8, 13],
        monthly_drought: [0.1, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.0, 0.6, 0.3, 0.2, 0.1],
        monthly_gdd: [0, 0, 10, 60, 130, 210, 280, 275, 190, 95, 20, 0]
    },
    'guneydogu anadolu': {
        label: 'Guneydogu Anadolu referans profili',
        climate_zone: 'Sicak-kurak step kusagi',
        annual_rainfall_mm: 520,
        avg_temperature: 16.9,
        elevation_m: 640,
        agricultural_area_hectare: 330000,
        soil_type: 'Kirecli / milli-killi',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '85-120 HP',
        primary_crops: [
            { name: 'Bugday', type: 'tahil', share: 0.28, yield_ton_per_ha: 4.4, hp_min: 80, hp_max: 110, planting_season: 'Eki-Kas', harvest_season: 'Haz', tractor_types: ['tarla'] },
            { name: 'Mercimek', type: 'tahil', share: 0.14, yield_ton_per_ha: 1.9, hp_min: 70, hp_max: 95, planting_season: 'Kas-Ara', harvest_season: 'Haz', tractor_types: ['tarla'] },
            { name: 'Pamuk', type: 'endustriyel', share: 0.18, yield_ton_per_ha: 4.6, hp_min: 95, hp_max: 125, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
            { name: 'Misir', type: 'tahil', share: 0.16, yield_ton_per_ha: 9.1, hp_min: 85, hp_max: 115, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] }
        ],
        soil_layers: [
            { soil_type: 'Sulamali ova zemini', soil_texture: 'Milli-killi', ph_level: 7.6, organic_matter_pct: 1.7, hp_range: '90-120 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sira arasi ve agir ekipman operasyonlari ayni donemde yogunlasir.' },
            { soil_type: 'Kuru tarim parcasi', soil_texture: 'Tinli', ph_level: 7.7, organic_matter_pct: 1.3, hp_range: '75-100 HP', tractor_type: 'tarla', drive_type: '2WD', note: 'Ekonomik cekis ve dusuk yakit on plana cikar.' }
        ],
        monthly_temp: [4, 6, 10, 16, 22, 29, 33, 33, 28, 21, 12, 6],
        monthly_rain: [75, 65, 55, 40, 25, 8, 2, 2, 5, 20, 40, 68],
        monthly_humidity: [70, 66, 60, 54, 48, 39, 32, 32, 38, 48, 60, 68],
        monthly_frost: [3, 1.5, 0.4, 0, 0, 0, 0, 0, 0, 0.2, 0.8, 2],
        monthly_drought: [0.1, 0.2, 0.4, 0.6, 0.9, 1.2, 1.5, 1.5, 1.1, 0.6, 0.3, 0.1],
        monthly_gdd: [15, 30, 70, 140, 240, 360, 430, 425, 320, 200, 75, 25]
    },
    default: {
        label: 'Genel mekanizasyon referans profili',
        climate_zone: 'Iliman gecis kusagi',
        annual_rainfall_mm: 610,
        avg_temperature: 13.5,
        elevation_m: 360,
        agricultural_area_hectare: 180000,
        soil_type: 'Tinli',
        dominant_drive_type: '4WD',
        dominant_tractor_type: 'tarla',
        dominant_hp_range: '70-95 HP',
        primary_crops: [
            { name: 'Bugday', type: 'tahil', share: 0.26, yield_ton_per_ha: 4.6, hp_min: 70, hp_max: 95, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla'] },
            { name: 'Misir', type: 'tahil', share: 0.18, yield_ton_per_ha: 8.5, hp_min: 75, hp_max: 105, planting_season: 'Nis-May', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
            { name: 'Yem bitkileri', type: 'yem', share: 0.14, yield_ton_per_ha: 7.3, hp_min: 60, hp_max: 85, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['tarla', 'hibrit'] }
        ],
        soil_layers: [
            { soil_type: 'Genel tarla zemini', soil_texture: 'Tinli', ph_level: 7.0, organic_matter_pct: 2.0, hp_range: '70-95 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Cok amacli saha operasyonlari icin dengeli kurulum gerekir.' }
        ],
        monthly_temp: [4, 5, 8, 13, 18, 23, 27, 27, 22, 16, 10, 6],
        monthly_rain: [70, 60, 55, 50, 45, 30, 15, 12, 20, 38, 55, 65],
        monthly_humidity: [73, 71, 68, 64, 60, 56, 52, 51, 56, 63, 69, 72],
        monthly_frost: [5, 4, 1.8, 0.4, 0, 0, 0, 0, 0, 0.7, 2, 4],
        monthly_drought: [-0.1, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.9, 0.5, 0.2, 0, -0.1],
        monthly_gdd: [10, 18, 45, 100, 180, 260, 320, 315, 230, 135, 55, 20]
    }
};

function getProvinceReferenceArchetype(province = {}) {
    const regionKey = normalizeSearchText(province.region || '');
    if (!regionKey) return PROVINCE_REFERENCE_ARCHETYPES.default;
    if (PROVINCE_REFERENCE_ARCHETYPES[regionKey]) return PROVINCE_REFERENCE_ARCHETYPES[regionKey];

    const fuzzyKey = Object.keys(PROVINCE_REFERENCE_ARCHETYPES)
        .filter(key => key !== 'default')
        .find(key => regionKey.includes(key) || key.includes(regionKey));

    return fuzzyKey ? PROVINCE_REFERENCE_ARCHETYPES[fuzzyKey] : PROVINCE_REFERENCE_ARCHETYPES.default;
}

function enrichProvinceWithReference(province = {}) {
    const reference = getProvinceReferenceArchetype(province);
    return {
        ...province,
        climate_zone: province.climate_zone || reference.climate_zone,
        annual_rainfall_mm: province.annual_rainfall_mm || reference.annual_rainfall_mm,
        avg_temperature: province.avg_temperature || reference.avg_temperature,
        elevation_m: province.elevation_m || reference.elevation_m,
        agricultural_area_hectare: province.agricultural_area_hectare || reference.agricultural_area_hectare,
        soil_type: province.soil_type || reference.soil_type,
        primary_crops: Array.isArray(province.primary_crops) && province.primary_crops.length
            ? province.primary_crops
            : reference.primary_crops.map(item => item.name)
    };
}

async function getEnrichedProvinceById(provinceId) {
    const result = await pool.query('SELECT * FROM provinces WHERE id = $1 LIMIT 1', [provinceId]);
    const province = result.rows[0] || null;
    return province ? enrichProvinceWithReference(province) : null;
}

function buildProvinceReferenceClimateRows(referenceProfile = {}, targetYear = new Date().getFullYear()) {
    const years = Array.from({ length: 6 }, (_, index) => targetYear - 5 + index);
    return years.flatMap((year, index) => {
        const warmingShift = (index - 2.5) * 0.12;
        const rainfallFactor = 1 + ((2.5 - index) * 0.03);
        return Array.from({ length: 12 }, (_, monthIndex) => ({
            year,
            month: monthIndex + 1,
            avg_temp: roundMetric((referenceProfile.monthly_temp?.[monthIndex] || 0) + warmingShift, 1),
            avg_rainfall_mm: roundMetric(Math.max(0, (referenceProfile.monthly_rain?.[monthIndex] || 0) * rainfallFactor), 1),
            avg_humidity: roundMetric(Math.min(90, Math.max(25, (referenceProfile.monthly_humidity?.[monthIndex] || 0) - (warmingShift * 1.2))), 1),
            frost_days: roundMetric(Math.max(0, (referenceProfile.monthly_frost?.[monthIndex] || 0) - Math.max(0, warmingShift * 0.8)), 1),
            drought_index: roundMetric((referenceProfile.monthly_drought?.[monthIndex] || 0) + Math.max(0, warmingShift * 0.5), 2),
            growing_degree_days: roundMetric(Math.max(0, (referenceProfile.monthly_gdd?.[monthIndex] || 0) + Math.max(0, warmingShift * 10)), 1)
        }));
    });
}

function buildProvinceFallbackCrops(province = {}, referenceProfile = {}, targetYear = new Date().getFullYear()) {
    const agArea = Number(province.agricultural_area_hectare || referenceProfile.agricultural_area_hectare || 180000);
    return (referenceProfile.primary_crops || []).map((crop, index) => {
        const area = Math.round(agArea * Number(crop.share || 0));
        return {
            id: -(province.id * 100 + index + 1),
            province_id: province.id,
            crop_name: crop.name,
            crop_type: crop.type,
            cultivation_area_hectare: area,
            annual_production_tons: Math.round(area * Number(crop.yield_ton_per_ha || 0)),
            year: targetYear,
            planting_season: crop.planting_season,
            harvest_season: crop.harvest_season,
            requires_hp_min: crop.hp_min,
            requires_hp_max: crop.hp_max,
            suitable_tractor_types: crop.tractor_types || [],
            source: 'province_reference_profile'
        };
    });
}

function buildProvinceFallbackSoils(province = {}, referenceProfile = {}, dominantHpRange = '', dominantCategory = '', dominantDrive = '') {
    return (referenceProfile.soil_layers || []).map((soil, index) => ({
        id: -(province.id * 100 + index + 1),
        province_id: province.id,
        soil_type: soil.soil_type || province.soil_type || referenceProfile.soil_type,
        soil_texture: soil.soil_texture || 'Tinli',
        ph_level: soil.ph_level,
        organic_matter_pct: soil.organic_matter_pct,
        suitable_crops: (referenceProfile.primary_crops || []).slice(index, index + 2).map(item => item.name),
        recommended_hp_range: soil.hp_range || dominantHpRange || referenceProfile.dominant_hp_range,
        recommended_tractor_type: soil.tractor_type || dominantCategory || referenceProfile.dominant_tractor_type,
        recommended_drive_type: soil.drive_type || dominantDrive || referenceProfile.dominant_drive_type,
        notes: soil.note || 'Bolgesel referans profilinden uretildi.',
        source: 'province_reference_profile'
    }));
}

function buildProvinceReferenceForecastRows(province = {}, referenceProfile = {}, dayCount = 7) {
    const today = new Date();
    const monthIndex = today.getMonth();
    const monthTemp = Number(referenceProfile.monthly_temp?.[monthIndex] ?? province.avg_temperature ?? 14);
    const monthRain = Number(referenceProfile.monthly_rain?.[monthIndex] ?? ((province.annual_rainfall_mm || referenceProfile.annual_rainfall_mm || 360) / 12));
    const monthHumidity = Number(referenceProfile.monthly_humidity?.[monthIndex] ?? 60);
    const weeklyRainTarget = Math.max(0, Number((monthRain / 4.3).toFixed(1)));
    const rainySlots = weeklyRainTarget >= 18
        ? [1, 3, 5]
        : weeklyRainTarget >= 8
            ? [2, 5]
            : weeklyRainTarget >= 3
                ? [3]
                : [];

    return Array.from({ length: dayCount }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() + index);

        const tempOffset = ((index % 4) - 1.5) * 1.1;
        const avgTemp = monthTemp + tempOffset;
        const tempMax = Number((avgTemp + (monthTemp >= 22 ? 6.5 : 5.5)).toFixed(1));
        const tempMin = Number((avgTemp - (monthTemp >= 22 ? 5.5 : 4.5)).toFixed(1));
        const rainfall = rainySlots.includes(index)
            ? Number((weeklyRainTarget / Math.max(rainySlots.length, 1)).toFixed(1))
            : 0;
        const humidity = Math.min(90, Math.max(35, monthHumidity + (rainfall > 0 ? 8 : -3) + (index % 3 === 0 ? 2 : -1)));
        const windSpeed = Number((14 + (index % 3) * 2 + (rainfall > 0 ? 4 : 0)).toFixed(0));

        let weatherCondition = 'clear';
        if (rainfall >= 3) {
            weatherCondition = 'rain';
        } else if (tempMin <= 0) {
            weatherCondition = 'snow';
        } else if (humidity >= 72) {
            weatherCondition = 'cloud';
        }

        return {
            id: -((Number(province.id) || 0) * 1000 + index + 1),
            province_id: province.id,
            date: date.toISOString().slice(0, 10),
            weather_condition: weatherCondition,
            temp_max: tempMax,
            temp_min: tempMin,
            rainfall_mm: rainfall,
            humidity_pct: Number(humidity.toFixed(0)),
            wind_speed_kmh: windSpeed,
            is_forecast: true,
            source: 'province_reference_profile'
        };
    });
}

function hpRangeFromHorsepower(hp) {
    const value = Number(hp || 0);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value <= 39) return '1-39';
    if (value <= 49) return '40-49';
    if (value <= 54) return '50-54';
    if (value <= 59) return '55-59';
    if (value <= 69) return '60-69';
    if (value <= 79) return '70-79';
    if (value <= 89) return '80-89';
    if (value <= 99) return '90-99';
    if (value <= 109) return '100-109';
    if (value <= 119) return '110-119';
    return '120+';
}

function parseHpBand(rangeLabel = '') {
    const text = String(rangeLabel || '');
    const matches = text.match(/\d+/g) || [];
    if (!matches.length) return { min: null, max: null, mid: null };
    const min = Number(matches[0]);
    const max = matches[1] ? Number(matches[1]) : (text.includes('+') ? min + 20 : min);
    return { min, max, mid: Number(((min + max) / 2).toFixed(1)) };
}

function normalizeModelCategory(value = '') {
    const normalized = normalizeSearchText(value);
    if (!normalized) return 'tarla';
    if (normalized.includes('bah')) return 'bahce';
    if (normalized.includes('hib')) return 'hibrit';
    return 'tarla';
}

function normalizeModelDriveType(value = '') {
    const normalized = String(value || '').toUpperCase();
    if (normalized.includes('2')) return '2WD';
    return '4WD';
}

function computeHpFitScore(hp, min, max) {
    if (!Number.isFinite(Number(hp)) || !Number.isFinite(Number(min)) || !Number.isFinite(Number(max))) return 12;
    const numericHp = Number(hp);
    if (numericHp >= Number(min) && numericHp <= Number(max)) return 28;
    const gap = numericHp < Number(min) ? Number(min) - numericHp : numericHp - Number(max);
    if (gap <= 5) return 23;
    if (gap <= 10) return 18;
    if (gap <= 20) return 12;
    if (gap <= 30) return 7;
    return 3;
}

function computeModelProvinceCompatibility(model = {}, province = {}) {
    const reference = getProvinceReferenceArchetype(province);
    const enrichedProvince = enrichProvinceWithReference(province);
    const hp = Number(model.horsepower || 0);
    const category = normalizeModelCategory(model.category);
    const driveType = normalizeModelDriveType(model.drive_type);
    const crops = reference.primary_crops || [];
    const soils = reference.soil_layers || [];

    let bestCrop = null;
    let cropScore = 0;
    crops.forEach(crop => {
        let score = computeHpFitScore(hp, crop.hp_min, crop.hp_max);
        const tractorTypes = crop.tractor_types || [];
        if (tractorTypes.includes(category)) score += 10;
        else if (category === 'hibrit' && (tractorTypes.includes('tarla') || tractorTypes.includes('bahce'))) score += 6;
        if (tractorTypes.includes('4wd') && driveType === '4WD') score += 6;
        if (tractorTypes.includes('dar') && category === 'bahce') score += 4;
        if (score > cropScore) {
            cropScore = score;
            bestCrop = crop;
        }
    });

    let bestSoil = null;
    let soilScore = 0;
    soils.forEach(soil => {
        const hpBand = parseHpBand(soil.hp_range || reference.dominant_hp_range);
        let score = computeHpFitScore(hp, hpBand.min, hpBand.max);
        if (normalizeModelCategory(soil.tractor_type || reference.dominant_tractor_type) === category) score += 10;
        if (normalizeModelDriveType(soil.drive_type || reference.dominant_drive_type) === driveType) score += 8;
        if (score > soilScore) {
            soilScore = score;
            bestSoil = soil;
        }
    });

    let categoryScore = category === normalizeModelCategory(reference.dominant_tractor_type) ? 14 : 6;
    if (category === 'hibrit') categoryScore = 10;
    let driveScore = driveType === normalizeModelDriveType(reference.dominant_drive_type) ? 12 : 5;
    if (Number(enrichedProvince.elevation_m || 0) > 900 && driveType === '4WD') driveScore += 3;

    const finalScore = Math.max(42, Math.min(96, Math.round((cropScore * 0.38) + (soilScore * 0.30) + categoryScore + driveScore)));
    const label = finalScore >= 86
        ? 'Doğal liderlik'
        : finalScore >= 76
            ? 'Güçlü uyum'
        : finalScore >= 64
                ? 'Seçici uyum'
                : 'Sınırlı uyum';

    const notes = [
        bestCrop ? `${bestCrop.name} ekseninde HP uyumu belirgin.` : `${reference.label} ile genel uyum kuruluyor.`,
        bestSoil?.note || '',
        driveType === normalizeModelDriveType(reference.dominant_drive_type)
            ? `${driveType} çekiş mimarisi bölgenin saha karakteriyle örtüşüyor.`
            : ''
    ].filter(Boolean);

    return {
        score: finalScore,
        label,
        dominant_crop: bestCrop?.name || reference.primary_crops?.[0]?.name || null,
        reference_label: reference.label,
        soil_type: enrichedProvince.soil_type,
        climate_zone: enrichedProvince.climate_zone,
        annual_rainfall_mm: Number(enrichedProvince.annual_rainfall_mm || 0) || null,
        avg_temperature: Number(enrichedProvince.avg_temperature || 0) || null,
        elevation_m: Number(enrichedProvince.elevation_m || 0) || null,
        agricultural_area_hectare: Number(enrichedProvince.agricultural_area_hectare || 0) || null,
        primary_crops: Array.isArray(enrichedProvince.primary_crops) ? enrichedProvince.primary_crops : [],
        recommended_hp_range: bestSoil?.hp_range || reference.dominant_hp_range,
        recommended_drive_type: bestSoil?.drive_type || reference.dominant_drive_type,
        recommended_tractor_type: bestSoil?.tractor_type || reference.dominant_tractor_type,
        note: notes.slice(0, 2).join(' ')
    };
}

function buildModelRegionMission({ fitScore = 0, modelSharePct = 0, yoyPct = null, opportunityScore = 0 }) {
    if (fitScore >= 84 && modelSharePct >= 12) return 'Kale bölge';
    if (opportunityScore >= 82) return 'Sıcak beyaz alan';
    if (fitScore >= 78 && (yoyPct == null || yoyPct >= 0)) return 'Yatırım cephesi';
    if (fitScore < 64) return 'Seçici saha';
    return 'Derinleştir';
}

function aggregateProvinceBrandRows(rows = [], previousBrandMap = new Map(), marketTotal = 0) {
    const map = new Map();

    (rows || []).forEach(row => {
        const brandId = Number(row.brand_id || 0);
        if (!brandId) return;

        if (!map.has(brandId)) {
            map.set(brandId, {
                brand_id: brandId,
                brand_name: row.brand_name,
                slug: row.brand_slug,
                primary_color: row.primary_color,
                total_sales: 0
            });
        }

        map.get(brandId).total_sales += Number(row.total_sales || 0);
    });

    return Array.from(map.values())
        .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'))
        .map((row, index) => {
            const previousSales = Number(previousBrandMap.get(row.brand_id) || 0);
            return {
                ...row,
                previous_sales: previousSales,
                share_pct: marketTotal > 0 ? roundMetric((row.total_sales * 100) / marketTotal, 1) : 0,
                yoy_pct: calculateYoY(row.total_sales, previousSales),
                rank: index + 1
            };
        });
}

function aggregateProvinceMixRows(rows = [], valueGetter, totalBase = 0, labelKey = 'label') {
    const map = new Map();

    (rows || []).forEach(row => {
        const rawLabel = valueGetter(row);
        const label = rawLabel ? String(rawLabel) : 'belirsiz';
        if (!map.has(label)) map.set(label, 0);
        map.set(label, map.get(label) + Number(row.total_sales || 0));
    });

    return Array.from(map.entries())
        .map(([label, totalSales]) => ({
            [labelKey]: label,
            label,
            total_sales: totalSales,
            share_pct: totalBase > 0 ? roundMetric((totalSales * 100) / totalBase, 1) : 0
        }))
        .sort((left, right) => right.total_sales - left.total_sales || String(left.label || '').localeCompare(String(right.label || ''), 'tr'));
}

app.get('/api/province-intelligence/:province_id', authMiddleware, async (req, res) => {
    try {
        const provinceId = parseInt(req.params.province_id, 10);
        if (!Number.isFinite(provinceId)) {
            return res.status(400).json({ error: 'Geçerli province_id gerekli' });
        }

        const latestRes = await pool.query('SELECT MAX(year) as max_year, MIN(year) as min_year FROM sales_view');
        const maxYear = parseInt(latestRes.rows[0]?.max_year, 10) || new Date().getFullYear();
        const minYear = parseInt(latestRes.rows[0]?.min_year, 10) || maxYear;
        const requestedYear = req.query.year ? parseInt(req.query.year, 10) : maxYear;
        const targetYear = Number.isFinite(requestedYear) ? Math.min(Math.max(requestedYear, minYear), maxYear) : maxYear;
        const prevYear = targetYear - 1;
        const focusBrandId = req.user.role === 'admin'
            ? (req.query.brand_id ? parseInt(req.query.brand_id, 10) : null)
            : req.user.brand_id;

        const normalizedBrandExpr = `
            CASE
                WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                ELSE tv.marka
            END
        `;
        const categoryHintExpr = `
            CASE
                WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' AND LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'hibrit'
                WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' THEN 'bahce'
                WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                ELSE NULL
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
                WHEN tk.motor_gucu_hp > 119 THEN '120+'
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

        const provinceRes = await pool.query(`
            SELECT id, name, plate_code, region, latitude, longitude, population, agricultural_area_hectare,
                   primary_crops, soil_type, climate_zone, annual_rainfall_mm, avg_temperature, elevation_m
            FROM provinces
            WHERE id = $1
        `, [provinceId]);
        const provinceRow = provinceRes.rows[0];
        const province = enrichProvinceWithReference(provinceRow || {});
        if (!provinceRow) {
            return res.status(404).json({ error: 'İl bulunamadı' });
        }

        const regionReference = getProvinceReferenceArchetype(province);
        const referenceProfile = {
            label: regionReference.label,
            climate_zone: regionReference.climate_zone,
            soil_type: regionReference.soil_type,
            dominant_drive_type: regionReference.dominant_drive_type,
            dominant_tractor_type: regionReference.dominant_tractor_type,
            dominant_hp_range: regionReference.dominant_hp_range,
            primary_crops: regionReference.primary_crops,
            soil_layers: regionReference.soil_layers,
            climate_rows: buildProvinceReferenceClimateRows(regionReference, targetYear)
        };

        const cropYearRes = await pool.query(`
            SELECT COALESCE(
                MAX(CASE WHEN year <= $2 THEN year END),
                MAX(year)
            ) as crop_year
            FROM crop_data
            WHERE province_id = $1
        `, [provinceId, targetYear]);
        const cropYear = parseInt(cropYearRes.rows[0]?.crop_year, 10) || targetYear;

        const [
            soilRes,
            cropsRes,
            currentOverviewRes,
            previousOverviewRes,
            topBrandsRes,
            hpRes,
            categoryRes,
            driveRes,
            cabinRes,
            topModelsRes,
            currentTuikMixRes,
            previousTuikMixRes
        ] = await Promise.all([
            pool.query('SELECT * FROM soil_data WHERE province_id = $1 ORDER BY organic_matter_pct DESC NULLS LAST, soil_type ASC', [provinceId]),
            pool.query(
                'SELECT * FROM crop_data WHERE province_id = $1 AND year = $2 ORDER BY cultivation_area_hectare DESC NULLS LAST, annual_production_tons DESC NULLS LAST',
                [provinceId, cropYear]
            ),
            pool.query(
                `SELECT COALESCE(SUM(quantity), 0)::int as total_sales, COUNT(DISTINCT brand_id)::int as active_brand_count
                 FROM sales_view
                 WHERE province_id = $1 AND year = $2`,
                [provinceId, targetYear]
            ),
            pool.query(
                `SELECT COALESCE(SUM(quantity), 0)::int as total_sales
                 FROM sales_view
                 WHERE province_id = $1 AND year = $2`,
                [provinceId, prevYear]
            ),
            pool.query(`
                WITH previous_brand AS (
                    SELECT brand_id, SUM(quantity)::int as previous_sales
                    FROM sales_view
                    WHERE province_id = $1 AND year = $3
                    GROUP BY brand_id
                )
                SELECT
                    b.id as brand_id,
                    b.name as brand_name,
                    b.slug,
                    b.primary_color,
                    SUM(s.quantity)::int as total_sales,
                    COALESCE(pb.previous_sales, 0)::int as previous_sales
                FROM sales_view s
                JOIN brands b ON s.brand_id = b.id
                LEFT JOIN previous_brand pb ON pb.brand_id = b.id
                WHERE s.province_id = $1 AND s.year = $2
                GROUP BY b.id, b.name, b.slug, b.primary_color, pb.previous_sales
                ORDER BY total_sales DESC, b.name ASC
                LIMIT 12
            `, [provinceId, targetYear, prevYear]),
            pool.query(`
                SELECT COALESCE(hp_range, 'belirsiz') as hp_range, SUM(quantity)::int as total_sales
                FROM sales_view
                WHERE province_id = $1 AND year = $2
                GROUP BY hp_range
                ORDER BY total_sales DESC, hp_range ASC
            `, [provinceId, targetYear]),
            pool.query(`
                SELECT COALESCE(category, 'belirsiz') as label, SUM(quantity)::int as total_sales
                FROM sales_view
                WHERE province_id = $1 AND year = $2
                GROUP BY category
                ORDER BY total_sales DESC, label ASC
            `, [provinceId, targetYear]),
            pool.query(`
                SELECT UPPER(COALESCE(drive_type, 'belirsiz')) as label, SUM(quantity)::int as total_sales
                FROM sales_view
                WHERE province_id = $1 AND year = $2
                GROUP BY drive_type
                ORDER BY total_sales DESC, label ASC
            `, [provinceId, targetYear]),
            pool.query(`
                SELECT LOWER(COALESCE(cabin_type, 'belirsiz')) as label, SUM(quantity)::int as total_sales
                FROM sales_view
                WHERE province_id = $1 AND year = $2
                GROUP BY cabin_type
                ORDER BY total_sales DESC, label ASC
            `, [provinceId, targetYear]),
            pool.query(`
                WITH model_totals AS (
                    SELECT
                        ${normalizedBrandExpr} as normalized_brand_name,
                        tv.marka,
                        tv.tuik_model_adi,
                        SUM(tv.satis_adet)::int as total_sales
                    FROM tuik_veri tv
                    WHERE tv.tescil_yil = $1
                      AND tv.sehir_kodu = $2
                    GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                    ORDER BY total_sales DESC, tv.marka ASC, tv.tuik_model_adi ASC
                    LIMIT 36
                )
                SELECT
                    b.id as brand_id,
                    b.name as brand_name,
                    b.slug as brand_slug,
                    b.primary_color,
                    COALESCE(NULLIF(tk.model, ''), mt.tuik_model_adi) as model_name,
                    mt.tuik_model_adi,
                    mt.total_sales,
                    ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                    ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                    ${categoryHintExpr} as category_hint,
                    LOWER(MAX(COALESCE(tk.cekis_tipi, ''))) as drive_type,
                    MAX(COALESCE(tk.koruma, '')) as protection,
                    MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                    MAX(COALESCE(tk.mensei, '')) as origin,
                    MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                    CASE
                        WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                        ELSE NULL
                    END as estimated_revenue_usd
                FROM model_totals mt
                JOIN brands b
                    ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                LEFT JOIN teknik_veri tk
                    ON UPPER(mt.marka) = UPPER(tk.marka)
                   AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                GROUP BY
                    b.id, b.name, b.slug, b.primary_color,
                    COALESCE(NULLIF(tk.model, ''), mt.tuik_model_adi),
                    mt.tuik_model_adi,
                    mt.total_sales,
                    ${categoryHintExpr}
                ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
                LIMIT 24
            `, [targetYear, parseInt(province.plate_code, 10)]),
            pool.query(`
                WITH model_totals AS (
                    SELECT
                        ${normalizedBrandExpr} as normalized_brand_name,
                        tv.marka,
                        tv.tuik_model_adi,
                        SUM(tv.satis_adet)::int as total_sales
                    FROM tuik_veri tv
                    WHERE tv.tescil_yil = $1
                      AND tv.sehir_kodu = $2
                    GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                )
                SELECT
                    b.id as brand_id,
                    b.name as brand_name,
                    b.slug as brand_slug,
                    b.primary_color,
                    COALESCE(NULLIF(MAX(tk.model), ''), mt.tuik_model_adi) as model_name,
                    mt.tuik_model_adi,
                    mt.total_sales,
                    ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                    ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                    COALESCE(MAX(${categoryHintExpr}), 'belirsiz') as category_hint,
                    COALESCE(MAX(${hpRangeExpr}), 'belirsiz') as hp_range,
                    COALESCE(UPPER(MAX(NULLIF(tk.cekis_tipi, ''))), 'belirsiz') as drive_type,
                    COALESCE(MAX(${cabinTypeExpr}), 'belirsiz') as cabin_type,
                    MAX(COALESCE(tk.koruma, '')) as protection,
                    MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                    MAX(COALESCE(tk.mensei, '')) as origin,
                    MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                    CASE
                        WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                        ELSE NULL
                    END as estimated_revenue_usd
                FROM model_totals mt
                JOIN brands b
                    ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                LEFT JOIN teknik_veri tk
                    ON UPPER(mt.marka) = UPPER(tk.marka)
                   AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                GROUP BY
                    b.id, b.name, b.slug, b.primary_color,
                    mt.tuik_model_adi,
                    mt.total_sales
                ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
            `, [targetYear, parseInt(province.plate_code, 10)]),
            pool.query(`
                WITH model_totals AS (
                    SELECT
                        ${normalizedBrandExpr} as normalized_brand_name,
                        tv.marka,
                        tv.tuik_model_adi,
                        SUM(tv.satis_adet)::int as total_sales
                    FROM tuik_veri tv
                    WHERE tv.tescil_yil = $1
                      AND tv.sehir_kodu = $2
                    GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                )
                SELECT
                    b.id as brand_id,
                    b.name as brand_name,
                    b.slug as brand_slug,
                    b.primary_color,
                    COALESCE(NULLIF(MAX(tk.model), ''), mt.tuik_model_adi) as model_name,
                    mt.tuik_model_adi,
                    mt.total_sales,
                    ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                    ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                    COALESCE(MAX(${categoryHintExpr}), 'belirsiz') as category_hint,
                    COALESCE(MAX(${hpRangeExpr}), 'belirsiz') as hp_range,
                    COALESCE(UPPER(MAX(NULLIF(tk.cekis_tipi, ''))), 'belirsiz') as drive_type,
                    COALESCE(MAX(${cabinTypeExpr}), 'belirsiz') as cabin_type,
                    MAX(COALESCE(tk.koruma, '')) as protection,
                    MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                    MAX(COALESCE(tk.mensei, '')) as origin,
                    MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                    CASE
                        WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                        ELSE NULL
                    END as estimated_revenue_usd
                FROM model_totals mt
                JOIN brands b
                    ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                LEFT JOIN teknik_veri tk
                    ON UPPER(mt.marka) = UPPER(tk.marka)
                   AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                GROUP BY
                    b.id, b.name, b.slug, b.primary_color,
                    mt.tuik_model_adi,
                    mt.total_sales
                ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
            `, [prevYear, parseInt(province.plate_code, 10)])
        ]);

        const mapProvinceModelRow = row => {
            const totalSales = parseInt(row.total_sales || 0, 10) || 0;
            return {
                brand_id: parseInt(row.brand_id, 10),
                brand_name: row.brand_name,
                brand_slug: row.brand_slug || row.slug,
                primary_color: row.primary_color,
                model_name: row.model_name,
                tuik_model_adi: row.tuik_model_adi,
                total_sales: totalSales,
                avg_hp: row.avg_hp != null ? Number(row.avg_hp) : null,
                avg_price_usd: row.avg_price_usd != null ? Number(row.avg_price_usd) : null,
                estimated_revenue_usd: row.estimated_revenue_usd != null ? Number(row.estimated_revenue_usd) : null,
                category_hint: row.category_hint || null,
                hp_range: row.hp_range || null,
                drive_type: row.drive_type || null,
                cabin_type: row.cabin_type || null,
                protection: row.protection || null,
                gear_config: row.gear_config || null,
                origin: row.origin || null,
                engine_brand: row.engine_brand || null
            };
        };

        const fallbackCurrentRows = currentTuikMixRes.rows.map(mapProvinceModelRow);
        const fallbackPreviousRows = previousTuikMixRes.rows.map(mapProvinceModelRow);

        let marketTotal = parseInt(currentOverviewRes.rows[0]?.total_sales || 0, 10);
        let previousTotal = parseInt(previousOverviewRes.rows[0]?.total_sales || 0, 10);
        let activeBrandCount = parseInt(currentOverviewRes.rows[0]?.active_brand_count || 0, 10);

        let topBrands = topBrandsRes.rows.map((row, index) => {
            const totalSales = parseInt(row.total_sales, 10) || 0;
            const previousSales = parseInt(row.previous_sales, 10) || 0;
            return {
                brand_id: parseInt(row.brand_id, 10),
                brand_name: row.brand_name,
                slug: row.slug,
                primary_color: row.primary_color,
                total_sales: totalSales,
                previous_sales: previousSales,
                share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0,
                yoy_pct: calculateYoY(totalSales, previousSales),
                rank: index + 1
            };
        });

        const mapShareRows = (rows, labelKey = 'label') => rows.map(row => {
            const totalSales = parseInt(row.total_sales, 10) || 0;
            return {
                label: row[labelKey],
                total_sales: totalSales,
                share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0
            };
        });

        let hpMix = hpRes.rows.map(row => {
            const totalSales = parseInt(row.total_sales, 10) || 0;
            return {
                hp_range: row.hp_range,
                total_sales: totalSales,
                share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0
            };
        });
        let categoryMix = mapShareRows(categoryRes.rows);
        let driveMix = mapShareRows(driveRes.rows);
        let cabinMix = mapShareRows(cabinRes.rows);
        let topModels = topModelsRes.rows.map(row => ({
            ...mapProvinceModelRow(row),
            share_pct: marketTotal > 0 ? roundMetric(((parseInt(row.total_sales, 10) || 0) * 100) / marketTotal, 1) : 0
        }));
        let marketSource = 'sales_view';

        if (marketTotal <= 0 && fallbackCurrentRows.length > 0) {
            marketSource = 'tuik_veri';
            marketTotal = fallbackCurrentRows.reduce((sum, item) => sum + Number(item.total_sales || 0), 0);
            previousTotal = fallbackPreviousRows.reduce((sum, item) => sum + Number(item.total_sales || 0), 0);
            activeBrandCount = new Set(fallbackCurrentRows.map(item => Number(item.brand_id || 0)).filter(Boolean)).size;

            const previousBrandMap = fallbackPreviousRows.reduce((map, item) => {
                const brandId = Number(item.brand_id || 0);
                if (!brandId) return map;
                map.set(brandId, (map.get(brandId) || 0) + Number(item.total_sales || 0));
                return map;
            }, new Map());

            topBrands = aggregateProvinceBrandRows(fallbackCurrentRows, previousBrandMap, marketTotal).slice(0, 12);
            hpMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.hp_range || 'belirsiz', marketTotal, 'hp_range');
            categoryMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.category_hint || 'belirsiz', marketTotal);
            driveMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.drive_type || 'belirsiz', marketTotal);
            cabinMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.cabin_type || 'belirsiz', marketTotal);
            topModels = [...fallbackCurrentRows]
                .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'))
                .slice(0, 24)
                .map(item => ({
                    ...item,
                    share_pct: marketTotal > 0 ? roundMetric((Number(item.total_sales || 0) * 100) / marketTotal, 1) : 0
                }));
        }

        const dominantHpRange = hpMix[0]?.hp_range || referenceProfile.dominant_hp_range;
        const dominantCategory = categoryMix[0]?.label || referenceProfile.dominant_tractor_type;
        const dominantDrive = driveMix[0]?.label || referenceProfile.dominant_drive_type;
        const finalCropRows = cropsRes.rows.length
            ? cropsRes.rows
            : buildProvinceFallbackCrops(province, regionReference, targetYear);
        const finalSoilRows = soilRes.rows.length
            ? soilRes.rows
            : buildProvinceFallbackSoils(province, regionReference, dominantHpRange, dominantCategory, dominantDrive);
        const focusBrand = focusBrandId
            ? topBrands.find(item => item.brand_id === Number(focusBrandId)) || null
            : null;

        const weightedHpTotal = topModels.reduce((sum, item) => sum + ((item.avg_hp || 0) * item.total_sales), 0);
        const weightedSales = topModels.reduce((sum, item) => sum + item.total_sales, 0);
        const weightedAvgHp = weightedSales > 0 ? roundMetric(weightedHpTotal / weightedSales, 1) : null;
        const weightedPriceTotal = topModels.reduce((sum, item) => sum + ((item.avg_price_usd || 0) * item.total_sales), 0);
        const weightedAvgPrice = weightedSales > 0 ? roundMetric(weightedPriceTotal / weightedSales, 0) : null;

        res.json({
            province,
            period: {
                year: targetYear,
                previous_year: prevYear,
                crop_year: cropYear,
                max_year: maxYear,
                min_year: minYear
            },
            overview: {
                market_total_sales: marketTotal,
                previous_total_sales: previousTotal,
                yoy_pct: calculateYoY(marketTotal, previousTotal),
                active_brand_count: activeBrandCount,
                dominant_hp: hpMix[0]?.hp_range || null,
                weighted_avg_hp: weightedAvgHp,
                weighted_avg_price_usd: weightedAvgPrice,
                top_brand_name: topBrands[0]?.brand_name || null,
                top_brand_share_pct: topBrands[0]?.share_pct || 0
            },
            focus_brand: focusBrand,
            soil: finalSoilRows,
            crops: finalCropRows,
            top_brands: topBrands,
            hp_mix: hpMix,
            category_mix: categoryMix,
            drive_mix: driveMix,
            cabin_mix: cabinMix,
            top_models: topModels,
            reference_profile: {
                ...referenceProfile,
                soil_source: soilRes.rows.length ? 'soil_data' : 'province_reference_profile',
                crop_source: cropsRes.rows.length ? 'crop_data' : 'province_reference_profile',
                market_source: marketSource,
                is_reference_active: !soilRes.rows.length || !cropsRes.rows.length || marketSource !== 'sales_view'
            },
            source_stack: Array.from(new Set([
                marketSource,
                'tuik_veri',
                'teknik_veri',
                soilRes.rows.length ? 'soil_data' : 'province_reference_profile',
                cropsRes.rows.length ? 'crop_data' : 'province_reference_profile'
            ]))
        });
    } catch (err) {
        console.error('Province intelligence error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// AI INSIGHTS
// ============================================
function resolveMediaWatchScopedBrandId(req, requestedBrandId = null) {
    if (req.user?.role === 'admin') {
        return requestedBrandId ? parseInt(requestedBrandId, 10) : null;
    }
    return parseInt(req.user?.brand_id || 0, 10) || null;
}

function normalizeMediaWatchChannel(value = '') {
    const normalized = normalizeSearchText(value || '');
    if (normalized.includes('social') || ['x', 'twitter', 'instagram', 'facebook', 'youtube', 'tiktok'].some(token => normalized.includes(token))) return 'social';
    if (normalized.includes('forum')) return 'forum';
    if (normalized.includes('sikayet') || normalized.includes('complaint')) return 'complaint';
    if (normalized.includes('bakan') || normalized.includes('resmi') || normalized.includes('official') || normalized.includes('regulation')) return 'official';
    if (normalized.includes('video') || normalized.includes('youtube')) return 'video';
    if (normalized.includes('report') || normalized.includes('rapor')) return 'report';
    return 'news';
}

function normalizeMediaWatchItemType(value = '') {
    const normalized = normalizeSearchText(value || '');
    if (normalized.includes('launch') || normalized.includes('product') || normalized.includes('urun') || normalized.includes('release')) return 'launch';
    if (normalized.includes('complaint') || normalized.includes('sikayet') || normalized.includes('ariza')) return 'complaint';
    if (normalized.includes('regulation') || normalized.includes('karar') || normalized.includes('destek') || normalized.includes('teblig')) return 'regulation';
    if (normalized.includes('review') || normalized.includes('yorum') || normalized.includes('inceleme')) return 'review';
    if (normalized.includes('campaign') || normalized.includes('kampanya')) return 'campaign';
    if (normalized.includes('service') || normalized.includes('servis') || normalized.includes('yedek')) return 'service';
    if (normalized.includes('forum') || normalized.includes('discussion') || normalized.includes('tartisma')) return 'discussion';
    return 'news';
}

function normalizeMediaWatchSentiment(label = '', score = null) {
    if (label) {
        const normalized = normalizeSearchText(label);
        if (normalized.includes('neg')) return 'negative';
        if (normalized.includes('pos')) return 'positive';
        if (normalized.includes('mix')) return 'mixed';
        if (normalized.includes('warn')) return 'negative';
    }

    const numeric = Number(score);
    if (!Number.isFinite(numeric)) return 'neutral';
    if (numeric <= -0.2) return 'negative';
    if (numeric >= 0.2) return 'positive';
    return 'neutral';
}

function clampScore(value, min = -1, max = 1) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(max, Math.max(min, numeric));
}

function normalizeArrayJson(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function buildMediaWatchDedupeHash(item = {}, brandId = null) {
    const fingerprint = [
        brandId || '',
        item.external_id || '',
        item.source_url || '',
        item.title || '',
        item.published_at || '',
        item.channel_type || '',
        item.item_type || ''
    ].join('|');

    return crypto.createHash('sha1').update(fingerprint).digest('hex');
}

async function resolveMediaWatchBrandId(input = {}) {
    const directId = parseInt(input.brand_id || input.brandId || 0, 10);
    if (directId) return directId;

    const slug = String(input.brand_slug || input.brandSlug || '').trim();
    if (slug) {
        const result = await pool.query('SELECT id FROM brands WHERE slug = $1 LIMIT 1', [slug]);
        if (result.rows[0]?.id) return Number(result.rows[0].id);
    }

    const brandName = String(input.brand_name || input.brandName || '').trim();
    if (brandName) {
        const result = await pool.query('SELECT id FROM brands WHERE UPPER(name) = UPPER($1) LIMIT 1', [brandName]);
        if (result.rows[0]?.id) return Number(result.rows[0].id);
    }

    return null;
}

function truncateDbText(value, maxLength) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function upsertMediaWatchSource(item = {}) {
    const sourceCodeBase = String(item.source_code || item.sourceCode || item.source_domain || item.sourceDomain || item.source_name || item.sourceName || '').trim();
    if (!sourceCodeBase) return null;

    const sourceCode = normalizeSearchText(sourceCodeBase).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || null;
    if (!sourceCode) return null;

    const title = truncateDbText(item.source_name || item.sourceName || item.publisher || item.source_domain || item.sourceDomain || sourceCodeBase, 255);
    const publisher = truncateDbText(item.publisher || item.source_name || item.sourceName || item.platform_name || item.platformName || '', 150);
    const sourceType = normalizeMediaWatchChannel(item.channel_type || item.channelType || item.source_type || item.sourceType || 'news');
    const officialUrl = truncateDbText(item.source_homepage || item.sourceHomepage || item.official_url || item.officialUrl || item.source_url || item.sourceUrl || '', 500);

    const result = await pool.query(`
        INSERT INTO intelligence_sources (source_code, title, publisher, source_type, official_url, notes, is_active, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        ON CONFLICT (source_code) DO UPDATE SET
            title = EXCLUDED.title,
            publisher = COALESCE(EXCLUDED.publisher, intelligence_sources.publisher),
            source_type = EXCLUDED.source_type,
            official_url = COALESCE(EXCLUDED.official_url, intelligence_sources.official_url),
            notes = COALESCE(EXCLUDED.notes, intelligence_sources.notes),
            updated_at = NOW()
        RETURNING id
    `, [
        sourceCode,
        title || sourceCodeBase,
        publisher,
        sourceType,
        officialUrl,
        item.notes || null
    ]);

    return result.rows[0]?.id || null;
}

async function upsertMediaWatchRun(payload = {}, fallbackBrandId = null) {
    const runKey = String(payload.run_key || payload.runKey || '').trim();
    if (!runKey) return null;

    const brandId = await resolveMediaWatchBrandId(payload) || fallbackBrandId || null;
    const result = await pool.query(`
        INSERT INTO media_watch_runs (brand_id, workflow_code, run_key, status, trigger_source, item_count, error_message, started_at, finished_at, meta_json, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10, NOW())
        ON CONFLICT (run_key) DO UPDATE SET
            brand_id = COALESCE(EXCLUDED.brand_id, media_watch_runs.brand_id),
            workflow_code = COALESCE(EXCLUDED.workflow_code, media_watch_runs.workflow_code),
            status = COALESCE(EXCLUDED.status, media_watch_runs.status),
            trigger_source = COALESCE(EXCLUDED.trigger_source, media_watch_runs.trigger_source),
            item_count = GREATEST(COALESCE(EXCLUDED.item_count, 0), COALESCE(media_watch_runs.item_count, 0)),
            error_message = COALESCE(EXCLUDED.error_message, media_watch_runs.error_message),
            finished_at = COALESCE(EXCLUDED.finished_at, media_watch_runs.finished_at),
            meta_json = COALESCE(EXCLUDED.meta_json, media_watch_runs.meta_json),
            updated_at = NOW()
        RETURNING *
    `, [
        brandId,
        payload.workflow_code || payload.workflowCode || null,
        runKey,
        payload.status || 'completed',
        payload.trigger_source || payload.triggerSource || 'n8n',
        Number(payload.item_count || payload.itemCount || 0),
        payload.error_message || payload.errorMessage || null,
        payload.started_at || payload.startedAt || null,
        payload.finished_at || payload.finishedAt || null,
        JSON.stringify(payload.meta_json || payload.meta || {})
    ]);

    return result.rows[0] || null;
}

async function upsertMediaWatchItems(items = [], options = {}) {
    const insertedRows = [];
    const runId = options.runId || null;
    const fallbackBrandId = options.brandId || null;

    for (const rawItem of items) {
        const brandId = await resolveMediaWatchBrandId(rawItem) || fallbackBrandId;
        if (!brandId) continue;

        const sourceId = await upsertMediaWatchSource(rawItem);
        const channelType = normalizeMediaWatchChannel(rawItem.channel_type || rawItem.channelType || rawItem.platform_name || rawItem.platformName || rawItem.source_type || rawItem.sourceType || 'news');
        const itemType = normalizeMediaWatchItemType(rawItem.item_type || rawItem.itemType || rawItem.signal_type || rawItem.signalType || rawItem.topic_type || rawItem.topicType || channelType);
        const sentimentScore = clampScore(rawItem.sentiment_score ?? rawItem.sentimentScore, -1, 1);
        const severityScore = clampScore(rawItem.severity_score ?? rawItem.severityScore, 0, 1);
        const relevanceScore = clampScore(rawItem.relevance_score ?? rawItem.relevanceScore, 0, 1);
        const sentimentLabel = normalizeMediaWatchSentiment(rawItem.sentiment_label || rawItem.sentimentLabel, sentimentScore);
        const dedupeHash = buildMediaWatchDedupeHash({
            ...rawItem,
            channel_type: channelType,
            item_type: itemType
        }, brandId);

        const result = await pool.query(`
            INSERT INTO media_watch_items (
                brand_id, province_id, source_id, run_id, channel_type, item_type, platform_name,
                source_name, source_domain, source_url, title, summary, content_text, ai_summary,
                author_name, external_id, language_code, country_code, model_name, product_name,
                complaint_area, issue_type, sentiment_label, sentiment_score, severity_score, relevance_score,
                published_at, collected_at, engagement_json, tags_json, topics_json, entities_json,
                recommendations_json, raw_payload, dedupe_hash, is_active, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26,
                $27, NOW(), $28, $29, $30, $31,
                $32, $33, $34, true, NOW()
            )
            ON CONFLICT (dedupe_hash) DO UPDATE SET
                source_id = COALESCE(EXCLUDED.source_id, media_watch_items.source_id),
                run_id = COALESCE(EXCLUDED.run_id, media_watch_items.run_id),
                summary = COALESCE(EXCLUDED.summary, media_watch_items.summary),
                content_text = COALESCE(EXCLUDED.content_text, media_watch_items.content_text),
                ai_summary = COALESCE(EXCLUDED.ai_summary, media_watch_items.ai_summary),
                sentiment_label = COALESCE(EXCLUDED.sentiment_label, media_watch_items.sentiment_label),
                sentiment_score = COALESCE(EXCLUDED.sentiment_score, media_watch_items.sentiment_score),
                severity_score = COALESCE(EXCLUDED.severity_score, media_watch_items.severity_score),
                relevance_score = COALESCE(EXCLUDED.relevance_score, media_watch_items.relevance_score),
                engagement_json = COALESCE(EXCLUDED.engagement_json, media_watch_items.engagement_json),
                tags_json = COALESCE(EXCLUDED.tags_json, media_watch_items.tags_json),
                topics_json = COALESCE(EXCLUDED.topics_json, media_watch_items.topics_json),
                entities_json = COALESCE(EXCLUDED.entities_json, media_watch_items.entities_json),
                recommendations_json = COALESCE(EXCLUDED.recommendations_json, media_watch_items.recommendations_json),
                raw_payload = COALESCE(EXCLUDED.raw_payload, media_watch_items.raw_payload),
                updated_at = NOW(),
                is_active = true
            RETURNING *
        `, [
            brandId,
            rawItem.province_id || rawItem.provinceId || null,
            sourceId,
            runId,
            channelType,
            itemType,
            truncateDbText(rawItem.platform_name || rawItem.platformName || '', 120),
            truncateDbText(rawItem.source_name || rawItem.sourceName || rawItem.publisher || '', 255),
            truncateDbText(rawItem.source_domain || rawItem.sourceDomain || '', 255),
            truncateDbText(rawItem.source_url || rawItem.sourceUrl || '', 1000),
            rawItem.title || 'İsimsiz kayıt',
            rawItem.summary || null,
            rawItem.content_text || rawItem.contentText || rawItem.content || null,
            rawItem.ai_summary || rawItem.aiSummary || null,
            truncateDbText(rawItem.author_name || rawItem.authorName || '', 255),
            truncateDbText(rawItem.external_id || rawItem.externalId || '', 255),
            truncateDbText(rawItem.language_code || rawItem.languageCode || 'tr', 10),
            truncateDbText(rawItem.country_code || rawItem.countryCode || 'TR', 10),
            truncateDbText(rawItem.model_name || rawItem.modelName || '', 255),
            truncateDbText(rawItem.product_name || rawItem.productName || '', 255),
            truncateDbText(rawItem.complaint_area || '', 120),
            truncateDbText(rawItem.issue_type || rawItem.issueType || '', 120),
            sentimentLabel,
            sentimentScore,
            severityScore,
            relevanceScore,
            rawItem.published_at || rawItem.publishedAt || rawItem.collected_at || rawItem.collectedAt || new Date().toISOString(),
            JSON.stringify(rawItem.engagement_json || rawItem.engagement || {}),
            JSON.stringify(normalizeArrayJson(rawItem.tags_json || rawItem.tags)),
            JSON.stringify(normalizeArrayJson(rawItem.topics_json || rawItem.topics)),
            JSON.stringify(normalizeArrayJson(rawItem.entities_json || rawItem.entities)),
            JSON.stringify(rawItem.recommendations_json || rawItem.recommendations || {}),
            JSON.stringify(rawItem.raw_payload || rawItem),
            dedupeHash
        ]);

        if (result.rows[0]) insertedRows.push(result.rows[0]);
    }

    return insertedRows;
}

function pickTopCounts(rows = [], picker, limit = 6) {
    const map = new Map();
    rows.forEach(row => {
        const value = picker(row);
        if (!value) return;
        map.set(value, (map.get(value) || 0) + 1);
    });
    return [...map.entries()]
        .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), 'tr'))
        .slice(0, limit)
        .map(([label, count]) => ({ label, count }));
}

function averageMediaWatchScore(rows = [], picker) {
    if (!rows.length) return 0;
    const total = rows.reduce((sum, row) => sum + Number(picker(row) || 0), 0);
    return Number((total / rows.length).toFixed(2));
}

function buildMediaWatchAlertKey(brandId, alertType, scopeValue = '') {
    const base = [
        brandId || '',
        alertType || '',
        normalizeSearchText(scopeValue || '')
    ].join('|');
    return crypto.createHash('sha1').update(base).digest('hex');
}

function buildMediaWatchAlertTitle(alertType, scopeLabel, count, brandName = '') {
    const label = scopeLabel || brandName || 'Genel gundem';
    if (alertType === 'complaint-pressure') return `${label} icin toplam sikayet baskisi ${count} kayda ulasti`;
    if (alertType === 'complaint-cluster') return `${label} ekseninde ${count} tekrar eden sikayet sinyali`;
    if (alertType === 'service-backlog') return `${label} ekseninde satis sonrasi baskisi artiyor`;
    if (alertType === 'forum-buzz') return `${label} icin forum tartismasi hizlandi`;
    if (alertType === 'launch-buzz') return `${label} icin lansman ve sosyal gorunurluk firsati`;
    if (alertType === 'official-impact') return `${label} icin resmi karar / destek etkisi`;
    return `${label} icin medya alarmi`;
}

function buildMediaWatchAlertSummary(alertType, rows = [], scopeLabel = '', brandName = '') {
    const firstItem = rows[0] || {};
    const channelMix = pickTopCounts(rows, item => item.platform_name || item.source_domain || item.channel_type, 3)
        .map(item => `${item.label} (${item.count})`)
        .join(', ');
    const modelMix = pickTopCounts(rows, item => item.product_name || item.model_name, 2)
        .map(item => `${item.label} (${item.count})`)
        .join(', ');
    const lastSeen = rows
        .map(item => item.published_at || item.created_at)
        .filter(Boolean)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];

    if (alertType === 'complaint-pressure') {
        return `${brandName || 'Marka'} icin son donemde toplam ${rows.length} sikayet / ariza kaydi toplandi. Kanal karmasi: ${channelMix || 'veri yok'}. ${modelMix ? `Dagilan urun / model izi: ${modelMix}. ` : ''}${lastSeen ? `Son sinyal: ${new Date(lastSeen).toLocaleString('tr-TR')}.` : ''}`;
    }
    if (alertType === 'complaint-cluster') {
        return `${brandName || 'Marka'} icin ${scopeLabel || 'saha'} ekseninde ${rows.length} sikayet / ariza sinyali toplandi. Kanal karmasi: ${channelMix || 'veri yok'}. ${modelMix ? `Urun / model yoğunluğu: ${modelMix}. ` : ''}${lastSeen ? `Son sinyal: ${new Date(lastSeen).toLocaleString('tr-TR')}.` : ''}`;
    }
    if (alertType === 'service-backlog') {
        return `${scopeLabel || 'Satis sonrasi'} tarafinda servis, garanti veya yedek parca baskisi goruluyor. Kanal karmasi: ${channelMix || 'veri yok'}.`;
    }
    if (alertType === 'forum-buzz') {
        return `${scopeLabel || 'Kullanici gundemi'} etrafinda forum / tartisma yogunlugu var. ${modelMix ? `Konusulan modeller: ${modelMix}. ` : ''}Kanal karmasi: ${channelMix || 'veri yok'}.`;
    }
    if (alertType === 'launch-buzz') {
        return `${scopeLabel || brandName || 'Marka'} icin lansman, video veya sosyal web gorunurlugu toplandi. ${modelMix ? `One cikan urunler: ${modelMix}. ` : ''}Kanal karmasi: ${channelMix || 'veri yok'}.`;
    }
    if (alertType === 'official-impact') {
        return `${brandName || 'Marka'} ile ilgili resmi karar, destek veya mevzuat sinyali bulundu. Kaynaklar: ${channelMix || 'veri yok'}.`;
    }
    return `${brandName || 'Marka'} icin medya alarmi toplandi.`;
}

function buildMediaWatchAlertsFromItems(brand = {}, items = []) {
    const alerts = [];
    const openItems = (items || []).filter(item => item && item.is_active !== false);

    const pushAlert = (alertType, scopeLabel, rows, options = {}) => {
        const validRows = (rows || []).filter(Boolean);
        if (!validRows.length) return;

        const severityMax = Math.max(...validRows.map(item => Number(item.severity_score || 0)), 0);
        const avgSeverity = averageMediaWatchScore(validRows, item => item.severity_score);
        const confidence = averageMediaWatchScore(validRows, item => item.relevance_score);
        const sourceCount = new Set(validRows.map(item => item.source_domain || item.source_name || item.platform_name).filter(Boolean)).size;
        const firstSeenAt = validRows
            .map(item => item.published_at || item.created_at)
            .filter(Boolean)
            .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
        const lastSeenAt = validRows
            .map(item => item.published_at || item.created_at)
            .filter(Boolean)
            .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
        const alertLevel = options.alertLevel || (
            severityMax >= 0.9 || validRows.length >= 5
                ? 'critical'
                : avgSeverity >= 0.65 || validRows.length >= 3
                    ? 'warning'
                    : 'watch'
        );

        alerts.push({
            alert_key: buildMediaWatchAlertKey(brand.id, alertType, `${scopeLabel}|${options.actionOwner || ''}`),
            alert_level: alertLevel,
            alert_type: alertType,
            title: buildMediaWatchAlertTitle(alertType, scopeLabel, validRows.length, brand.name),
            summary: buildMediaWatchAlertSummary(alertType, validRows, scopeLabel, brand.name),
            action_owner: options.actionOwner || 'Ust yonetim',
            source_count: sourceCount,
            item_count: validRows.length,
            average_severity: avgSeverity,
            confidence_score: confidence,
            source_item_ids_json: validRows.map(item => item.id).filter(Boolean),
            meta_json: {
                scope_label: scopeLabel || null,
                top_sources: pickTopCounts(validRows, item => item.source_domain || item.source_name || item.platform_name, 4),
                top_products: pickTopCounts(validRows, item => item.product_name || item.model_name, 4),
                top_topics: pickTopCounts(validRows.flatMap(item => normalizeArrayJson(item.topics_json).map(topic => ({ topic }))), entry => entry.topic, 4)
            },
            first_seen_at: firstSeenAt,
            last_seen_at: lastSeenAt
        });
    };

    const complaintRows = openItems.filter(item =>
        ['complaint', 'service'].includes(item.item_type) ||
        ['complaint', 'forum'].includes(item.channel_type) ||
        item.sentiment_label === 'negative'
    );
    if (complaintRows.length >= 4) {
        pushAlert('complaint-pressure', `${brand.name || 'Marka'} genel baski`, complaintRows, {
            actionOwner: 'Satis sonrasi',
            alertLevel: complaintRows.length >= 8 ? 'critical' : 'warning'
        });
    }
    const complaintGroups = new Map();
    complaintRows.forEach(item => {
        const key = item.complaint_area || item.issue_type || item.product_name || item.model_name || 'genel';
        if (!complaintGroups.has(key)) complaintGroups.set(key, []);
        complaintGroups.get(key).push(item);
    });
    complaintGroups.forEach((rows, scopeLabel) => {
        const maxSeverity = Math.max(...rows.map(item => Number(item.severity_score || 0)), 0);
        if (rows.length < 2 && maxSeverity < 0.86) return;
        const issueKey = normalizeSearchText(scopeLabel);
        const actionOwner = ['motor', 'sanziman', 'hidrolik', 'elektrik', 'teknik'].some(token => issueKey.includes(token))
            ? 'Ar-Ge'
            : 'Satis sonrasi';
        pushAlert('complaint-cluster', scopeLabel, rows, { actionOwner });
    });

    const serviceRows = complaintRows.filter(item => (item.complaint_area || '').includes('satis') || (item.issue_type || '').includes('servis'));
    if (serviceRows.length >= 2) {
        pushAlert('service-backlog', 'Servis / garanti', serviceRows, {
            actionOwner: 'Satis sonrasi',
            alertLevel: serviceRows.length >= 4 ? 'critical' : 'warning'
        });
    }

    const forumRows = openItems.filter(item => item.channel_type === 'forum' || item.item_type === 'discussion');
    const forumGroups = new Map();
    forumRows.forEach(item => {
        const key = item.product_name || item.model_name || item.issue_type || 'Genel forum';
        if (!forumGroups.has(key)) forumGroups.set(key, []);
        forumGroups.get(key).push(item);
    });
    forumGroups.forEach((rows, scopeLabel) => {
        if (rows.length < 2) return;
        const negativeCount = rows.filter(item => item.sentiment_label === 'negative').length;
        pushAlert('forum-buzz', scopeLabel, rows, {
            actionOwner: negativeCount >= 2 ? 'Pazarlama' : 'Satis',
            alertLevel: negativeCount >= 2 ? 'warning' : 'watch'
        });
    });

    const launchRows = openItems.filter(item =>
        ['launch', 'review', 'campaign'].includes(item.item_type) ||
        ['social', 'video'].includes(item.channel_type)
    );
    const launchGroups = new Map();
    launchRows.forEach(item => {
        const key = item.product_name || item.model_name || item.title || 'Marka gundemi';
        if (!launchGroups.has(key)) launchGroups.set(key, []);
        launchGroups.get(key).push(item);
    });
    launchGroups.forEach((rows, scopeLabel) => {
        const positiveCount = rows.filter(item => item.sentiment_label === 'positive').length;
        if (rows.length < 2 && positiveCount < 2) return;
        pushAlert('launch-buzz', scopeLabel, rows, {
            actionOwner: 'Pazarlama',
            alertLevel: rows.length >= 5 ? 'warning' : 'watch'
        });
    });

    const officialRows = openItems.filter(item => item.item_type === 'regulation' || ['official', 'report'].includes(item.channel_type));
    if (officialRows.length > 0) {
        const latestOfficial = officialRows
            .sort((left, right) => new Date(right.published_at || right.created_at).getTime() - new Date(left.published_at || left.created_at).getTime())
            .slice(0, 4);
        pushAlert('official-impact', 'Resmi kararlar', latestOfficial, {
            actionOwner: 'Ust yonetim',
            alertLevel: latestOfficial.some(item => Number(item.severity_score || 0) >= 0.82) ? 'critical' : 'warning'
        });
    }

    return alerts
        .sort((left, right) =>
            Number(right.average_severity || 0) - Number(left.average_severity || 0) ||
            Number(right.item_count || 0) - Number(left.item_count || 0)
        )
        .slice(0, 8);
}

async function loadRecentMediaWatchItems(brandId, options = {}) {
    const limit = Math.max(20, Math.min(300, Number(options.limit || 250)));
    const windowDays = Math.max(3, Math.min(45, Number(options.windowDays || 30)));
    const result = await pool.query(`
        SELECT *
        FROM media_watch_items
        WHERE brand_id = $1
          AND is_active = true
          AND (
              COALESCE(published_at, created_at) >= NOW() - ($2::text || ' days')::interval
              OR COALESCE(collected_at, created_at) >= NOW() - ($2::text || ' days')::interval
          )
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT $3
    `, [brandId, windowDays, limit]);
    return result.rows;
}

async function syncMediaWatchAlerts(brandId, options = {}) {
    if (!brandId) return [];

    const brandRes = await pool.query('SELECT id, name, slug FROM brands WHERE id = $1 LIMIT 1', [brandId]);
    const brand = brandRes.rows[0];
    if (!brand) return [];

    const items = Array.isArray(options.items) && options.items.length
        ? options.items
        : await loadRecentMediaWatchItems(brandId, {
            limit: options.limit || 250,
            windowDays: options.windowDays || 30
        });

    const alerts = buildMediaWatchAlertsFromItems(brand, items);
    const alertKeys = alerts.map(item => item.alert_key);
    const client = await pool.connect();
    const rows = [];

    try {
        await client.query('BEGIN');

        if (alertKeys.length > 0) {
            await client.query(`
                UPDATE media_watch_alerts
                SET is_open = false,
                    updated_at = NOW()
                WHERE brand_id = $1
                  AND is_open = true
                  AND NOT (alert_key = ANY($2::varchar[]))
            `, [brandId, alertKeys]);
        } else {
            await client.query(`
                UPDATE media_watch_alerts
                SET is_open = false,
                    updated_at = NOW()
                WHERE brand_id = $1
                  AND is_open = true
            `, [brandId]);
        }

        for (const alert of alerts) {
            const result = await client.query(`
                INSERT INTO media_watch_alerts (
                    brand_id, run_id, brief_id, alert_key, alert_level, alert_type, title, summary,
                    action_owner, source_count, item_count, average_severity, confidence_score,
                    source_item_ids_json, meta_json, first_seen_at, last_seen_at, is_open, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, true, NOW()
                )
                ON CONFLICT (alert_key) DO UPDATE SET
                    run_id = COALESCE(EXCLUDED.run_id, media_watch_alerts.run_id),
                    brief_id = COALESCE(EXCLUDED.brief_id, media_watch_alerts.brief_id),
                    alert_level = EXCLUDED.alert_level,
                    alert_type = EXCLUDED.alert_type,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    action_owner = EXCLUDED.action_owner,
                    source_count = EXCLUDED.source_count,
                    item_count = EXCLUDED.item_count,
                    average_severity = EXCLUDED.average_severity,
                    confidence_score = EXCLUDED.confidence_score,
                    source_item_ids_json = EXCLUDED.source_item_ids_json,
                    meta_json = EXCLUDED.meta_json,
                    first_seen_at = COALESCE(media_watch_alerts.first_seen_at, EXCLUDED.first_seen_at),
                    last_seen_at = GREATEST(COALESCE(media_watch_alerts.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
                    is_open = true,
                    updated_at = NOW()
                RETURNING *
            `, [
                brandId,
                options.runId || null,
                options.briefId || null,
                alert.alert_key,
                alert.alert_level,
                alert.alert_type,
                truncateDbText(alert.title, 255),
                alert.summary || null,
                truncateDbText(alert.action_owner, 80),
                Number(alert.source_count || 0),
                Number(alert.item_count || 0),
                Number(alert.average_severity || 0),
                Number(alert.confidence_score || 0),
                JSON.stringify(alert.source_item_ids_json || []),
                JSON.stringify(alert.meta_json || {}),
                alert.first_seen_at || null,
                alert.last_seen_at || null
            ]);
            if (result.rows[0]) rows.push(result.rows[0]);
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('Media watch alert rollback error:', rollbackErr);
        }
        throw err;
    } finally {
        client.release();
    }

    try {
        await syncMediaWatchAlertNotifications(brandId, rows);
    } catch (notificationErr) {
        console.error('Media watch alert notification sync error:', notificationErr);
    }

    return rows;
}

async function syncMediaWatchAlertNotifications(brandId, alerts = []) {
    const notifiableAlerts = (alerts || []).filter(item => ['critical', 'warning'].includes(String(item.alert_level || '')));
    if (!brandId || !notifiableAlerts.length) return [];

    const usersRes = await pool.query(`
        SELECT id, full_name, role
        FROM users
        WHERE is_active = true
          AND (role = 'admin' OR brand_id = $1)
        ORDER BY role = 'admin' DESC, id ASC
    `, [brandId]);

    const inserted = [];
    for (const user of usersRes.rows) {
        for (const alert of notifiableAlerts) {
            const existingRes = await pool.query(`
                SELECT id, COALESCE(data_json->>'alert_level', '') AS alert_level
                FROM notifications
                WHERE user_id = $1
                  AND type = 'media_watch_alert'
                  AND COALESCE(data_json->>'alert_key', '') = $2
                ORDER BY created_at DESC
                LIMIT 1
            `, [user.id, alert.alert_key]);

            const existing = existingRes.rows[0];
            if (existing?.alert_level === alert.alert_level) continue;

            const levelLabel = alert.alert_level === 'critical' ? 'Kritik alarm' : 'Yakın izleme';
            const result = await pool.query(`
                INSERT INTO notifications (
                    user_id, brand_id, type, title, body, is_read, data_json, created_at
                ) VALUES (
                    $1, $2, 'media_watch_alert', $3, $4, false, $5, NOW()
                )
                RETURNING *
            `, [
                user.id,
                brandId,
                truncateDbText(`[${levelLabel}] ${alert.title || 'Medya alarmi'}`, 500),
                truncateDbText(`${alert.summary || 'Detay bekleniyor.'} Aksiyon sahibi: ${alert.action_owner || 'Ust yonetim'}.`, 4000),
                JSON.stringify({
                    alert_id: alert.id,
                    alert_key: alert.alert_key,
                    alert_level: alert.alert_level,
                    alert_type: alert.alert_type,
                    item_count: alert.item_count,
                    source_count: alert.source_count,
                    action_owner: alert.action_owner
                })
            ]);

            if (result.rows[0]) inserted.push(result.rows[0]);
        }
    }

    return inserted;
}

function buildMediaWatchFallbackBrief(brand = {}, items = [], windowDays = 14) {
    const complaints = items.filter(item => item.item_type === 'complaint');
    const launches = items.filter(item => item.item_type === 'launch');
    const regulations = items.filter(item => item.item_type === 'regulation');
    const negative = items.filter(item => item.sentiment_label === 'negative');
    const topIssues = pickTopCounts(complaints, item => item.complaint_area || item.issue_type || item.product_name || item.model_name || 'Genel şikayet', 4);
    const topChannels = pickTopCounts(items, item => item.platform_name || item.source_domain || item.channel_type, 5);
    const topProducts = pickTopCounts(items, item => item.product_name || item.model_name, 4);
    const riskLevel = complaints.length >= 8 || regulations.length >= 3 ? 'critical' : complaints.length >= 3 || negative.length >= 8 ? 'warning' : 'watch';

    return {
        risk_level: riskLevel,
        executive_summary_md: [
            `## ${brand.name || 'Marka'} medya takip özeti`,
            `Son ${windowDays} günde ${items.length} sinyal toplandı.`,
            `Şikayet: ${complaints.length} | Lansman / yeni ürün: ${launches.length} | Resmi karar / destek: ${regulations.length}.`,
            topIssues.length ? `En yoğun geri bildirim eksenleri: ${topIssues.map(item => `${item.label} (${item.count})`).join(', ')}.` : 'Şikayet ekseni henüz yoğun değil.',
            topProducts.length ? `En görünür ürün / model başlıkları: ${topProducts.map(item => `${item.label} (${item.count})`).join(', ')}.` : 'Belirgin ürün yoğunluğu yok.'
        ].join('\n\n'),
        sections_json: {
            board_brief_md: [
                `### Üst Yönetim Brifi`,
                `- Medya görünürlüğü ${items.length} kayıt ile ${riskLevel === 'critical' ? 'kritik' : riskLevel === 'warning' ? 'yakın izleme' : 'kontrollü'} seviyede.`,
                `- En aktif kanallar: ${topChannels.map(item => `${item.label} (${item.count})`).join(', ') || 'veri yok'}.`,
                `- Sonuç: Marka gündemi tek bir kanal sorunu değil; ürün, satış sonrası ve resmi duyurular birlikte izlenmeli.`
            ].join('\n'),
            marketing_md: [
                `### Pazarlama`,
                launches.length
                    ? `- Lansman konuşmaları görünür. Ürün mesajı, bayi / saha videosu ve teknik içerik aynı haftada beslenmeli.`
                    : `- Yeni ürün sinyali zayıf. Organik görünürlük için teknik içerik, kullanıcı hikayesi ve tarım odaklı haber dağıtımı artırılmalı.`,
                negative.length
                    ? `- Negatif yorum başlıkları için hazır cevap kütüphanesi ve sosyal medya kriz matrisi önerilir.`
                    : `- Duygu tonu dengeli. Test sürüşü, performans ve yakıt ekonomisi temaları öne çıkarılabilir.`
            ].join('\n'),
            arge_md: [
                `### Ar-Ge`,
                topIssues.length
                    ? `- İlk inceleme gereken alanlar: ${topIssues.map(item => item.label).join(', ')}.`
                    : `- Toplanan veri daha çok görünürlük ve kanal etkisi üretiyor; teknik problem yoğunluğu sınırlı.`,
                `- Forum ve şikayet içeriklerinde tekrarlayan arıza tipleri ayrı etiketlerle izlenmeli.`
            ].join('\n'),
            aftersales_md: [
                `### Satış Sonrası`,
                complaints.length
                    ? `- Şikayet hattı ve servis süreçleri için günlük vaka listesi çıkarılmalı.`
                    : `- Satış sonrası görünümü sakin. Yine de erken uyarı için servis, yedek parça ve garanti başlıkları izlenmeli.`,
                `- Her yüksek riskli kayıt için önerilen çözüm kartı ve cevap SLA takibi eklenmeli.`
            ].join('\n'),
            issue_solutions_md: [
                `### Arıza / Çözüm Önerileri`,
                topIssues.length
                    ? topIssues.map(item => `- ${item.label}: saha servis kontrol listesi, kullanıcı eğitim notu ve parça/işçilik kontrolü hazırlanmalı.`).join('\n')
                    : `- Belirgin arıza kümesi yok. Çözüm öneri motoru kayıt geldikçe zenginleşecek.`
            ].join('\n'),
            monitoring_gaps_md: [
                `### İzleme Açıkları`,
                `- Sosyal ağ API anahtarları ve forum kaynakları n8n tarafında tam bağlanmalı.`,
                `- Her kayda platform, ürün, şikayet alanı ve etki skoru zorunlu etiket olarak yazılmalı.`
            ].join('\n')
        },
        source_mix_json: {
            channels: topChannels,
            products: topProducts,
            issues: topIssues
        }
    };
}

async function generateMediaWatchBriefRecord(brandId, options = {}) {
    const windowDays = Math.max(3, Math.min(30, Number(options.windowDays || 14)));
    const brandRes = await pool.query('SELECT id, name, slug FROM brands WHERE id = $1 LIMIT 1', [brandId]);
    const brand = brandRes.rows[0];
    if (!brand) throw new Error('Marka bulunamadi');

    const itemsRes = await pool.query(`
        SELECT *
        FROM media_watch_items
        WHERE brand_id = $1
          AND is_active = true
          AND (
              published_at >= NOW() - ($2::text || ' days')::interval
              OR COALESCE(collected_at, created_at) >= NOW() - ($2::text || ' days')::interval
          )
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT 60
    `, [brandId, windowDays]);
    const items = itemsRes.rows;
    const fallback = buildMediaWatchFallbackBrief(brand, items, windowDays);
    let sections = fallback.sections_json;
    let executiveSummary = fallback.executive_summary_md;
    let aiModel = 'rule-based';

    if (items.length > 0) {
        const digest = items.slice(0, 40).map((item, index) => (
            `${index + 1}. [${item.channel_type}/${item.item_type}] ${item.title}\n` +
            `Kaynak: ${item.source_name || item.source_domain || '-'} | Tarih: ${item.published_at || item.created_at}\n` +
            `Duygu: ${item.sentiment_label || '-'} (${item.sentiment_score ?? '-'}) | Ciddiyet: ${item.severity_score ?? '-'}\n` +
            `Urun/Model: ${item.product_name || item.model_name || '-'} | Sikayet: ${item.complaint_area || item.issue_type || '-'}\n` +
            `Ozet: ${(item.summary || item.ai_summary || item.content_text || '').slice(0, 280)}`
        )).join('\n\n');

        const ai = await callGroqJson(
            'Sen tarim ve traktör sektöründe çalışan çok kıdemli bir medya istihbarat yöneticisisin. Verilen kayıtlar için JSON dön. Sadece geçerli JSON üret. Alanlar: executive_summary_md, board_brief_md, marketing_md, arge_md, aftersales_md, issue_solutions_md, monitoring_gaps_md, risk_level. Metinleri Türkçe, kısa ama yönetici seviyesinde, maddeli ve aksiyon odaklı yaz.',
            `Marka: ${brand.name}\nPencere: son ${windowDays} gün\nKayıt sayısı: ${items.length}\n\nKayıtlar:\n${digest}`
        );

        if (ai && typeof ai === 'object') {
            executiveSummary = ai.executive_summary_md || executiveSummary;
            sections = {
                board_brief_md: ai.board_brief_md || sections.board_brief_md,
                marketing_md: ai.marketing_md || sections.marketing_md,
                arge_md: ai.arge_md || sections.arge_md,
                aftersales_md: ai.aftersales_md || sections.aftersales_md,
                issue_solutions_md: ai.issue_solutions_md || sections.issue_solutions_md,
                monitoring_gaps_md: ai.monitoring_gaps_md || sections.monitoring_gaps_md
            };
            fallback.risk_level = ai.risk_level || fallback.risk_level;
            aiModel = MINIMAX_MODEL;
        }
    }

    const insertRes = await pool.query(`
        INSERT INTO media_watch_briefs (
            brand_id, run_id, brief_type, period_label, window_days, item_count,
            risk_level, executive_summary_md, sections_json, source_mix_json, ai_model, created_by, is_active
        ) VALUES (
            $1, $2, 'executive', $3, $4, $5,
            $6, $7, $8, $9, $10, $11, true
        )
        RETURNING *
    `, [
        brandId,
        options.runId || null,
        `Son ${windowDays} gün`,
        windowDays,
        items.length,
        fallback.risk_level,
        executiveSummary,
        JSON.stringify(sections || {}),
        JSON.stringify(fallback.source_mix_json || {}),
        aiModel,
        options.createdBy || 'system'
    ]);

    const alerts = await syncMediaWatchAlerts(brandId, {
        runId: options.runId || null,
        briefId: insertRes.rows[0]?.id || null,
        items,
        windowDays: Math.max(windowDays, 30)
    });

    return {
        ...insertRes.rows[0],
        brand,
        sections_json: sections,
        source_mix_json: fallback.source_mix_json || {},
        alerts
    };
}

async function buildMediaWatchOverview(brandId) {
    const [brandRes, itemsRes, briefRes, runsRes, workflowsRes, alertsRes] = await Promise.all([
        pool.query('SELECT id, name, slug, primary_color, secondary_color, accent_color, logo_url FROM brands WHERE id = $1 LIMIT 1', [brandId]),
        pool.query(`
            SELECT *
            FROM media_watch_items
            WHERE brand_id = $1 AND is_active = true
            ORDER BY COALESCE(published_at, created_at) DESC
            LIMIT 250
        `, [brandId]),
        pool.query(`
            SELECT *
            FROM media_watch_briefs
            WHERE brand_id = $1 AND is_active = true
            ORDER BY created_at DESC
            LIMIT 1
        `, [brandId]),
        pool.query(`
            SELECT *
            FROM media_watch_runs
            WHERE brand_id = $1
            ORDER BY COALESCE(started_at, created_at) DESC
            LIMIT 12
        `, [brandId]),
        pool.query(`
            SELECT *
            FROM n8n_workflows
            WHERE workflow_type IN ('media-watch', 'media_monitoring', 'media-intelligence')
            ORDER BY title
        `),
        pool.query(`
            SELECT *
            FROM media_watch_alerts
            WHERE brand_id = $1 AND is_open = true
            ORDER BY
                CASE alert_level
                    WHEN 'critical' THEN 1
                    WHEN 'warning' THEN 2
                    WHEN 'watch' THEN 3
                    ELSE 4
                END,
                COALESCE(last_seen_at, updated_at, created_at) DESC
            LIMIT 12
        `, [brandId])
    ]);

    const brand = brandRes.rows[0] || null;
    const items = itemsRes.rows || [];
    const alerts = alertsRes.rows || [];
    const now = Date.now();
    const mentions24h = items.filter(item => {
        const date = new Date(item.published_at || item.created_at).getTime();
        return Number.isFinite(date) && now - date <= 24 * 60 * 60 * 1000;
    }).length;
    const complaints = items.filter(item => item.item_type === 'complaint');
    const launches = items.filter(item => item.item_type === 'launch');
    const regulations = items.filter(item => item.item_type === 'regulation');
    const critical = items.filter(item => Number(item.severity_score || 0) >= 0.75);
    const channelMix = pickTopCounts(items, item => item.channel_type, 8);
    const sourceMix = pickTopCounts(items, item => item.source_name || item.source_domain, 8);
    const productMix = pickTopCounts(items, item => item.product_name || item.model_name, 6);
    const complaintMix = pickTopCounts(complaints, item => item.complaint_area || item.issue_type, 6);
    const topicMix = pickTopCounts(items.flatMap(item => normalizeArrayJson(item.topics_json).map(topic => ({ topic }))), entry => entry.topic, 8);

    return {
        brand,
        items,
        alerts,
        latest_brief: briefRes.rows[0] || null,
        runs: runsRes.rows || [],
        workflows: workflowsRes.rows || [],
        overview: {
            mentions_24h: mentions24h,
            mentions_total: items.length,
            complaint_count: complaints.length,
            launch_count: launches.length,
            regulation_count: regulations.length,
            critical_count: critical.length,
            open_alert_count: alerts.length,
            critical_alert_count: alerts.filter(item => item.alert_level === 'critical').length,
            warning_alert_count: alerts.filter(item => item.alert_level === 'warning').length,
            active_source_count: new Set(items.map(item => item.source_domain || item.source_name).filter(Boolean)).size,
            last_published_at: items[0]?.published_at || items[0]?.created_at || null,
            last_run_at: runsRes.rows[0]?.started_at || null,
            channel_mix: channelMix,
            source_mix: sourceMix,
            product_mix: productMix,
            complaint_mix: complaintMix,
            topic_mix: topicMix,
            alert_mix: pickTopCounts(alerts, item => item.alert_type, 6)
        }
    };
}

function isMediaWatchWebhookAuthorized(req) {
    const headerKey = String(req.headers['x-media-watch-key'] || req.headers['x-n8n-key'] || '').trim();
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!MEDIA_WATCH_WEBHOOK_KEY) return false;
    return headerKey === MEDIA_WATCH_WEBHOOK_KEY || bearer === MEDIA_WATCH_WEBHOOK_KEY;
}

app.get('/api/insights', authMiddleware, requireFeature('ai_insights', 'ai_insights_limited'), requireAiQuota(), async (req, res) => {
    try {
        const { brand_id, province_id, type } = req.query;
        const userBrandId = req.user.role === 'admin' ? brand_id : req.user.brand_id;

        let query = `SELECT ai.*, b.name as brand_name, p.name as province_name
            FROM ai_insights ai
            LEFT JOIN brands b ON ai.brand_id = b.id
            LEFT JOIN provinces p ON ai.province_id = p.id
            WHERE ai.is_active = true AND (ai.expires_at IS NULL OR ai.expires_at > NOW())`;
        const params = [];
        if (userBrandId) { params.push(userBrandId); query += ` AND (ai.brand_id = $${params.length} OR ai.brand_id IS NULL)`; }
        if (province_id) { params.push(province_id); query += ` AND ai.province_id = $${params.length}`; }
        if (type) { params.push(type); query += ` AND ai.insight_type = $${params.length}`; }
        query += ' ORDER BY ai.created_at DESC LIMIT 50';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// n8n webhook - AI insight kaydetme
app.post('/api/insights', async (req, res) => {
    try {
        const { brand_id, province_id, insight_type, title, content, data_json, confidence_score } = req.body;
        const result = await pool.query(`
            INSERT INTO ai_insights (brand_id, province_id, insight_type, title, content, data_json, confidence_score)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [brand_id, province_id, insight_type, title, content, JSON.stringify(data_json || {}), confidence_score]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// MEDIA WATCH
// ============================================
app.get('/api/media-watch/overview', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });
        const payload = await buildMediaWatchOverview(brandId);
        res.json(payload);
    } catch (err) {
        console.error('Media watch overview error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/media-watch/alerts', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const params = [brandId];
        let query = `
            SELECT *
            FROM media_watch_alerts
            WHERE brand_id = $1
              AND is_open = true
        `;

        if (req.query.level) {
            params.push(String(req.query.level));
            query += ` AND alert_level = $${params.length}`;
        }
        if (req.query.type) {
            params.push(String(req.query.type));
            query += ` AND alert_type = $${params.length}`;
        }

        params.push(Math.min(20, Math.max(4, parseInt(req.query.limit || '8', 10))));
        query += `
            ORDER BY
                CASE alert_level
                    WHEN 'critical' THEN 1
                    WHEN 'warning' THEN 2
                    WHEN 'watch' THEN 3
                    ELSE 4
                END,
                COALESCE(last_seen_at, updated_at, created_at) DESC
            LIMIT $${params.length}
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Media watch alerts error:', err);
        res.status(500).json({ error: 'Sunucu hatasÄ±' });
    }
});

app.get('/api/media-watch/items', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const params = [brandId];
        let query = `
            SELECT item.*, prov.name AS province_name, src.title AS source_title
            FROM media_watch_items item
            LEFT JOIN provinces prov ON prov.id = item.province_id
            LEFT JOIN intelligence_sources src ON src.id = item.source_id
            WHERE item.brand_id = $1 AND item.is_active = true
        `;

        if (req.query.channel) {
            params.push(req.query.channel);
            query += ` AND item.channel_type = $${params.length}`;
        }
        if (req.query.type) {
            params.push(req.query.type);
            query += ` AND item.item_type = $${params.length}`;
        }
        if (req.query.sentiment) {
            params.push(req.query.sentiment);
            query += ` AND item.sentiment_label = $${params.length}`;
        }
        if (req.query.search) {
            params.push(`%${req.query.search}%`);
            query += ` AND (item.title ILIKE $${params.length} OR COALESCE(item.summary, '') ILIKE $${params.length} OR COALESCE(item.content_text, '') ILIKE $${params.length})`;
        }

        query += ' ORDER BY COALESCE(item.published_at, item.created_at) DESC';
        params.push(Math.min(200, Math.max(20, parseInt(req.query.limit || '80', 10))));
        query += ` LIMIT $${params.length}`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Media watch items error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/media-watch/brief', authMiddleware, requireFeature('ai_brief', 'media_watch'), async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const result = await pool.query(`
            SELECT *
            FROM media_watch_briefs
            WHERE brand_id = $1 AND is_active = true
            ORDER BY created_at DESC
            LIMIT 1
        `, [brandId]);

        res.json(result.rows[0] || null);
    } catch (err) {
        console.error('Media watch brief error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/media-watch/brief/generate', authMiddleware, async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.body.brand_id || req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });
        const brief = await generateMediaWatchBriefRecord(brandId, {
            windowDays: req.body.window_days || req.query.window_days || 14,
            createdBy: req.user?.role || 'user'
        });
        res.json(brief);
    } catch (err) {
        console.error('Media watch brief generate error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/media-watch/alerts/rebuild', authMiddleware, async (req, res) => {
    try {
        const brandId = resolveMediaWatchScopedBrandId(req, req.body.brand_id || req.query.brand_id);
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const alerts = await syncMediaWatchAlerts(brandId, {
            windowDays: req.body.window_days || req.query.window_days || 30
        });

        res.json({
            success: true,
            brand_id: brandId,
            alert_count: alerts.length,
            critical_count: alerts.filter(item => item.alert_level === 'critical').length,
            warning_count: alerts.filter(item => item.alert_level === 'warning').length,
            alerts
        });
    } catch (err) {
        console.error('Media watch alerts rebuild error:', err);
        res.status(500).json({ error: 'Sunucu hatasÄ±' });
    }
});

app.post('/api/media-watch/alerts/refresh', async (req, res) => {
    try {
        if (!isMediaWatchWebhookAuthorized(req)) {
            return res.status(401).json({ error: 'Webhook yetkisiz' });
        }

        const brandId = await resolveMediaWatchBrandId(req.body || {});
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const alerts = await syncMediaWatchAlerts(brandId, {
            runId: req.body.run_id || req.body.runId || null,
            windowDays: req.body.window_days || req.body.windowDays || 30
        });

        res.json({
            success: true,
            brand_id: brandId,
            alert_count: alerts.length,
            critical_count: alerts.filter(item => item.alert_level === 'critical').length,
            warning_count: alerts.filter(item => item.alert_level === 'warning').length
        });
    } catch (err) {
        console.error('Media watch alerts refresh error:', err);
        res.status(500).json({ error: 'Sunucu hatasÄ±' });
    }
});

app.post('/api/media-watch/brief/refresh', async (req, res) => {
    try {
        if (!isMediaWatchWebhookAuthorized(req)) {
            return res.status(401).json({ error: 'Webhook yetkisiz' });
        }

        const brandId = await resolveMediaWatchBrandId(req.body || {});
        if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });

        const brief = await generateMediaWatchBriefRecord(brandId, {
            runId: req.body.run_id || req.body.runId || null,
            windowDays: req.body.window_days || req.body.windowDays || 14,
            createdBy: req.body.created_by || req.body.createdBy || 'n8n'
        });

        res.json({
            success: true,
            brand_id: brandId,
            brief_id: brief.id,
            risk_level: brief.risk_level,
            item_count: brief.item_count
        });
    } catch (err) {
        console.error('Media watch brief refresh error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/media-watch/ingest', async (req, res) => {
    try {
        if (!isMediaWatchWebhookAuthorized(req)) {
            return res.status(401).json({ error: 'Webhook yetkisiz' });
        }

        const payload = req.body || {};
        const items = Array.isArray(payload.items) ? payload.items : (payload.item ? [payload.item] : []);
        const brandId = await resolveMediaWatchBrandId(payload);
        const run = await upsertMediaWatchRun(payload, brandId);
        const inserted = await upsertMediaWatchItems(items, {
            runId: run?.id || null,
            brandId
        });

        if (run?.id) {
            await pool.query(`
                UPDATE media_watch_runs
                SET item_count = $2,
                    status = CASE WHEN status = 'queued' THEN 'completed' ELSE status END,
                    finished_at = COALESCE(finished_at, NOW()),
                    updated_at = NOW()
                WHERE id = $1
            `, [run.id, inserted.length]);
        }

        const alerts = brandId ? await syncMediaWatchAlerts(brandId, {
            runId: run?.id || null,
            windowDays: 30
        }) : [];

        res.json({
            success: true,
            run_id: run?.id || null,
            inserted_count: inserted.length,
            brand_id: brandId || null,
            alert_count: alerts.length
        });
    } catch (err) {
        console.error('Media watch ingest error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// MEDIA WATCH — Kaynak Registry + Manuel Tetikleme + Coğrafi İstatistikler
// ============================================
const MEDIA_WATCH_BRIDGE_PORT = parseInt(process.env.MEDIA_WATCH_BRIDGE_PORT || '3011', 10);
const MEDIA_WATCH_BRIDGE_URL = (process.env.MEDIA_WATCH_BRIDGE_URL || `http://127.0.0.1:${MEDIA_WATCH_BRIDGE_PORT}`).replace(/\/$/, '');

app.get('/api/media-watch/sources', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const r = await fetch(`${MEDIA_WATCH_BRIDGE_URL}/api/media-watch/sources`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (r && r.ok) return res.json(await r.json());
        res.json({ international: [], sector: [], oem_groups: {}, total: 0, languages: [], countries: [] });
    } catch (err) {
        res.status(500).json({ error: 'Bridge erişilemedi' });
    }
});

// Coğrafi/dil istatistikleri (DB tabanlı, son 30 gün)
app.get('/api/media-watch/coverage', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const brandId = req.query.brand_id ? Number(req.query.brand_id) : null;
        const params = brandId ? [brandId] : [];
        const where = brandId ? 'WHERE brand_id = $1 AND' : 'WHERE';
        const [byCountry, byLanguage, bySource, totals] = await Promise.all([
            pool.query(`SELECT COALESCE(country_code,'TR') AS country, COUNT(*)::int AS items
                        FROM media_watch_items ${where} published_at >= NOW() - INTERVAL '30 days'
                        GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, params),
            pool.query(`SELECT COALESCE(language,'tr') AS language, COUNT(*)::int AS items
                        FROM media_watch_items ${where} published_at >= NOW() - INTERVAL '30 days'
                        GROUP BY 1 ORDER BY 2 DESC`, params),
            pool.query(`SELECT COALESCE(source_name,'-') AS source, COALESCE(source_domain,'-') AS domain,
                               COUNT(*)::int AS items, MAX(published_at) AS latest
                        FROM media_watch_items ${where} published_at >= NOW() - INTERVAL '30 days'
                        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 25`, params),
            pool.query(`SELECT COUNT(*)::int AS total,
                               COUNT(DISTINCT country_code)::int AS country_count,
                               COUNT(DISTINCT language)::int AS language_count,
                               COUNT(DISTINCT source_domain)::int AS source_count,
                               COUNT(*) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours')::int AS last_24h
                        FROM media_watch_items ${where} published_at >= NOW() - INTERVAL '30 days'`, params)
        ]);
        res.json({
            totals: totals.rows[0] || {},
            by_country: byCountry.rows,
            by_language: byLanguage.rows,
            by_source: bySource.rows
        });
    } catch (err) {
        console.error('media-watch coverage error', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Manuel tarama tetikleme (Enterprise + admin) — bridge'i çağırır
app.post('/api/media-watch/run-now', authMiddleware, requireFeature('media_watch'), async (req, res) => {
    try {
        const isElite = req.user.role === 'admin' || (req.subscription && req.subscription.tier_rank >= 3);
        if (!isElite) {
            return res.status(402).json({ code: 'ENTERPRISE_REQUIRED', error: 'Manuel tarama Enterprise pakette' });
        }
        const { pack, brand_id } = req.body || {};
        const packCode = ['pack-1','pack-2','pack-3','pack-4','pack-5','pack-6'].includes(pack) ? pack : null;
        const url = packCode
            ? `${MEDIA_WATCH_BRIDGE_URL}/api/media-watch/push-${packCode}`
            : `${MEDIA_WATCH_BRIDGE_URL}/api/media-watch/push-all`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand_id: brand_id || null }),
            signal: AbortSignal.timeout(60000)
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json(json);
        res.json(json);
    } catch (err) {
        console.error('media-watch run-now error', err);
        res.status(500).json({ error: err.message || 'Bridge çağrı hatası' });
    }
});

// AI çeviri (Türkçe olmayan haberleri TR'ye çevirip özet üret)
app.post('/api/media-watch/translate', authMiddleware, requireFeature('ai_brief', 'media_watch'), async (req, res) => {
    try {
        const { item_id } = req.body || {};
        if (!item_id) return res.status(400).json({ error: 'item_id zorunlu' });
        const r = await pool.query(`SELECT id, language, title, summary, content_text FROM media_watch_items WHERE id = $1`, [item_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Kayıt bulunamadı' });
        const item = r.rows[0];
        if ((item.language || 'tr') === 'tr') {
            return res.json({ skipped: true, reason: 'already_turkish' });
        }
        const groqKey = process.env.GROQ_API_KEY || '';
        if (!groqKey) {
            return res.status(503).json({ error: 'AI servisi yapılandırılmadı (GROQ_API_KEY yok)' });
        }
        const prompt = `Aşağıdaki tarım sektörü haberini TÜRKÇE'ye çevir ve 3 cümleyle özetle.\nORİJİNAL DİL: ${item.language}\nBAŞLIK: ${item.title}\nÖZET: ${item.summary || item.content_text || ''}\n\nLütfen sadece JSON döndür:\n{"translated_title": "...", "translated_summary": "..."}`;
        const aiResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 600
            }),
            signal: AbortSignal.timeout(15000)
        });
        const aiJson = await aiResp.json();
        const text = aiJson?.choices?.[0]?.message?.content || '';
        const parsed = (() => { try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { return {}; } })();
        if (parsed.translated_title || parsed.translated_summary) {
            await pool.query(
                `UPDATE media_watch_items SET translated_title = $1, translated_summary = $2,
                 translation_model = 'llama-3.3-70b-versatile', translated_at = NOW(),
                 original_title = COALESCE(original_title, title) WHERE id = $3`,
                [parsed.translated_title || null, parsed.translated_summary || null, item.id]
            );
            // AI usage record (Enterprise/Growth kotası)
            try {
                if (typeof recordAiUsage === 'function') {
                    await recordAiUsage(req.user.id, 'media_watch_translate', 'llama-3.3-70b-versatile', aiJson?.usage?.prompt_tokens || 0, aiJson?.usage?.completion_tokens || 0);
                }
            } catch (e) {}
        }
        res.json({ success: true, ...parsed });
    } catch (err) {
        console.error('media-watch translate error', err);
        res.status(500).json({ error: err.message || 'Çeviri hatası' });
    }
});

// ============================================
// SUBSCRIPTION & PAYMENT
// ============================================
const billingProviders = require('./billing/providers');

// Plan feature key cache (5 dk TTL)
const _planFeatureCache = new Map();
async function getPlanFeatureKeys(planId) {
    if (!planId) return [];
    const cached = _planFeatureCache.get(planId);
    if (cached && (Date.now() - cached.t) < 5 * 60 * 1000) return cached.keys;
    const r = await pool.query('SELECT feature_keys FROM subscription_plans WHERE id = $1', [planId]);
    let keys = [];
    try {
        const raw = r.rows[0]?.feature_keys;
        keys = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    } catch (e) { keys = []; }
    _planFeatureCache.set(planId, { keys, t: Date.now() });
    return keys;
}

async function getUserActiveSubscription(userId) {
    if (!userId) return null;
    const r = await pool.query(`
        SELECT s.*, sp.name as plan_name, sp.slug as plan_slug, sp.tier_rank, sp.feature_keys,
               sp.features, sp.has_ai_insights, sp.has_competitor_analysis, sp.has_weather_data, sp.has_export
        FROM subscriptions s
        JOIN subscription_plans sp ON s.plan_id = sp.id
        WHERE s.user_id = $1 AND s.status IN ('active', 'trialing', 'pending')
        ORDER BY s.created_at DESC LIMIT 1
    `, [userId]);
    return r.rows[0] || null;
}

async function getPreviewPlanSlug(userId) {
    if (!userId) return null;
    const r = await pool.query(`SELECT preview_plan_slug, is_superuser FROM users WHERE id = $1`, [userId]);
    if (!r.rows[0] || !r.rows[0].is_superuser) return null;
    return r.rows[0].preview_plan_slug || null;
}
async function getPreviewPlanFeatures(planSlug) {
    if (!planSlug) return null;
    const r = await pool.query(`SELECT feature_keys, plan_limits, tier_rank, slug, name FROM subscription_plans WHERE slug = $1`, [planSlug]);
    if (r.rows.length === 0) return null;
    let keys = [], limits = {};
    try { keys = typeof r.rows[0].feature_keys === 'string' ? JSON.parse(r.rows[0].feature_keys) : r.rows[0].feature_keys || []; } catch (e) {}
    try { limits = typeof r.rows[0].plan_limits === 'string' ? JSON.parse(r.rows[0].plan_limits) : r.rows[0].plan_limits || {}; } catch (e) {}
    return { feature_keys: keys, plan_limits: limits, tier_rank: r.rows[0].tier_rank, plan_slug: r.rows[0].slug, plan_name: r.rows[0].name };
}

async function userHasFeature(userId, featureKey, userRole) {
    if (userRole === 'admin') {
        // Superuser preview modu — admin sadece seçtiği paketin özelliklerini görsün
        const preview = await getPreviewPlanSlug(userId);
        if (preview) {
            const p = await getPreviewPlanFeatures(preview);
            return p ? p.feature_keys.includes(featureKey) : true;
        }
        return true;
    }
    const sub = await getUserActiveSubscription(userId);
    if (!sub) return false;
    if (sub.status !== 'active' && sub.status !== 'trialing') return false;
    let keys = [];
    try {
        keys = typeof sub.feature_keys === 'string' ? JSON.parse(sub.feature_keys) : (Array.isArray(sub.feature_keys) ? sub.feature_keys : []);
    } catch (e) { keys = []; }
    return keys.includes(featureKey);
}

// requireFeature middleware (bir veya birden çok özellik anahtarı verilebilir; biri varsa geçer)
function requireFeature(...featureKeys) {
    return async (req, res, next) => {
        try {
            if (req.user?.role === 'admin') {
                // Superuser preview: seçtiği paketin özelliklerini geçer
                const preview = await getPreviewPlanSlug(req.user.id);
                if (preview) {
                    const p = await getPreviewPlanFeatures(preview);
                    if (p && featureKeys.some(k => p.feature_keys.includes(k))) return next();
                    if (!p) return next();
                    return res.status(402).json({
                        code: 'FEATURE_LOCKED_PREVIEW',
                        error: `Önizleme paketinizde (${p.plan_name}) bu özellik yok. Plan değiştirin veya önizlemeyi kapatın.`,
                        current_plan: preview, required_features: featureKeys
                    });
                }
                return next();
            }
            const sub = await getUserActiveSubscription(req.user?.id);
            if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) {
                return res.status(402).json({
                    error: 'Aktif abonelik gerekiyor',
                    code: 'NO_ACTIVE_SUBSCRIPTION',
                    required_features: featureKeys,
                    upgrade_url: '/?page=subscription'
                });
            }
            let keys = [];
            try {
                keys = typeof sub.feature_keys === 'string' ? JSON.parse(sub.feature_keys) : (Array.isArray(sub.feature_keys) ? sub.feature_keys : []);
            } catch (e) { keys = []; }
            const hasAccess = featureKeys.some(k => keys.includes(k));
            if (!hasAccess) {
                return res.status(402).json({
                    error: 'Bu özellik için planınızı yükseltmeniz gerekiyor',
                    code: 'FEATURE_LOCKED',
                    current_plan: sub.plan_slug,
                    current_tier: sub.tier_rank,
                    required_features: featureKeys,
                    upgrade_url: '/?page=subscription'
                });
            }
            req.subscription = sub;
            next();
        } catch (err) {
            console.error('requireFeature error:', err);
            res.status(500).json({ error: 'Yetkilendirme kontrolü başarısız' });
        }
    };
}

// Plan listesi (public)
app.get('/api/plans', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, slug, COALESCE(tier_rank, 1) AS tier_rank, COALESCE(currency, 'TRY') AS currency,
                   COALESCE(description, '') AS description, price_monthly, price_yearly,
                   features, COALESCE(feature_keys, '[]'::jsonb) AS feature_keys,
                   max_users, has_ai_insights, has_competitor_analysis, has_weather_data, has_export
            FROM subscription_plans WHERE is_active = true
            ORDER BY tier_rank, price_monthly
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('GET /api/plans error', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Aktif abonelik (kullanıcıya özel)
app.get('/api/subscription', authMiddleware, async (req, res) => {
    try {
        const sub = await getUserActiveSubscription(req.user.id);
        if (!sub) return res.json(null);
        let keys = [];
        try {
            keys = typeof sub.feature_keys === 'string' ? JSON.parse(sub.feature_keys) : (Array.isArray(sub.feature_keys) ? sub.feature_keys : []);
        } catch (e) { keys = []; }
        res.json({ ...sub, feature_keys: keys });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Kullanıcının özellik anahtarları (frontend gating için hızlı endpoint)
app.get('/api/me/features', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            // Superuser preview varsa onu uygula, yoksa tüm özellikler
            const preview = await getPreviewPlanSlug(req.user.id);
            if (preview) {
                const p = await getPreviewPlanFeatures(preview);
                if (p) {
                    return res.json({
                        role: 'admin', is_superuser: true, preview_plan_slug: preview,
                        tier_rank: p.tier_rank, plan_slug: p.plan_slug, plan_name: p.plan_name,
                        feature_keys: p.feature_keys, has_active_subscription: true
                    });
                }
            }
            const r = await pool.query(`SELECT feature_keys FROM subscription_plans WHERE is_active = true ORDER BY tier_rank DESC LIMIT 1`);
            let keys = [];
            try {
                const raw = r.rows[0]?.feature_keys;
                keys = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
            } catch (e) { keys = []; }
            return res.json({ role: 'admin', is_superuser: true, tier_rank: 99, plan_slug: 'admin', feature_keys: keys, has_active_subscription: true });
        }
        const sub = await getUserActiveSubscription(req.user.id);
        let keys = [];
        if (sub) {
            try {
                keys = typeof sub.feature_keys === 'string' ? JSON.parse(sub.feature_keys) : (Array.isArray(sub.feature_keys) ? sub.feature_keys : []);
            } catch (e) { keys = []; }
        }
        res.json({
            role: req.user.role,
            tier_rank: sub?.tier_rank || 0,
            plan_slug: sub?.plan_slug || null,
            plan_name: sub?.plan_name || null,
            status: sub?.status || 'none',
            current_period_end: sub?.current_period_end || null,
            feature_keys: keys,
            has_active_subscription: !!sub && (sub.status === 'active' || sub.status === 'trialing')
        });
    } catch (err) {
        console.error('GET /api/me/features error', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// (Eski /api/auth/signup endpoint'i auth bloğuna taşındı — burası kullanılmıyor)
app.post('/api/auth/_signup_legacy_disabled', async (req, res) => {
    res.status(410).json({ error: 'Bu endpoint kullanım dışı. /api/auth/signup kullanın.' });
});

// ============================================
// BILLING — Checkout / Webhook / Yönetim
// ============================================
app.get('/api/billing/payment-providers', (req, res) => {
    try {
        res.json(billingProviders.listProviders());
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/billing/checkout', authMiddleware, async (req, res) => {
    try {
        const { plan_slug, provider, period } = req.body || {};
        if (!plan_slug || !provider) return res.status(400).json({ error: 'plan_slug ve provider zorunlu' });
        const periodNorm = period === 'yearly' ? 'yearly' : 'monthly';

        const planRes = await pool.query('SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true', [String(plan_slug).toLowerCase()]);
        if (planRes.rows.length === 0) return res.status(404).json({ error: 'Plan bulunamadı' });
        const plan = planRes.rows[0];

        const providerImpl = billingProviders.getProvider(provider);
        if (!providerImpl) return res.status(400).json({ error: 'Geçersiz ödeme sağlayıcısı' });

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const returnUrl = `${baseUrl}/billing/success?provider=${providerImpl.code}&plan=${plan.slug}&period=${periodNorm}`;
        const cancelUrl = `${baseUrl}/billing/cancel`;

        const session = await providerImpl.createCheckout({
            user: req.user, plan, period: periodNorm, returnUrl, cancelUrl, baseUrl
        });

        // Pending subscription oluştur veya güncelle
        const existing = await pool.query(
            `SELECT id FROM subscriptions WHERE user_id = $1 AND status IN ('pending', 'active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
            [req.user.id]
        );
        let subscriptionId;
        if (existing.rows.length > 0) {
            subscriptionId = existing.rows[0].id;
            await pool.query(
                `UPDATE subscriptions SET plan_id = $1, status = 'pending', provider = $2, updated_at = NOW() WHERE id = $3`,
                [plan.id, providerImpl.code, subscriptionId]
            );
        } else {
            const ins = await pool.query(
                `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start)
                 VALUES ($1, $2, 'pending', $3, NOW()) RETURNING id`,
                [req.user.id, plan.id, providerImpl.code]
            );
            subscriptionId = ins.rows[0].id;
        }

        // Pending payment kaydı
        await pool.query(
            `INSERT INTO payments (user_id, subscription_id, provider, provider_payment_id, amount, currency, status, payment_method, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
            [
                req.user.id, subscriptionId, providerImpl.code, session.provider_session_id,
                session.amount, session.currency || 'TRY',
                providerImpl.code === 'bank_transfer' ? 'bank_transfer' : 'card',
                JSON.stringify({ ...(session.metadata || {}), bank_reference: session.bank_reference || null, period: periodNorm })
            ]
        );

        res.json({
            success: true,
            subscription_id: subscriptionId,
            provider: providerImpl.code,
            redirect_url: session.redirect_url,
            amount: session.amount,
            currency: session.currency || 'TRY',
            is_mock: !!session.is_mock,
            bank_reference: session.bank_reference || null,
            bank_details: session.bank_details || null
        });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message || 'Sunucu hatası' });
    }
});

// MOCK akış için success endpoint: kullanıcı tarayıcıdan dönerken aboneliği aktive eder.
// Provider kullanıcıyı redirect ettikten sonra session_id ile pending payment'ı bulup aktive ederiz.
app.get('/billing/success', async (req, res) => {
    try {
        const { provider, plan, period, session_id } = req.query;
        let userId = null;

        // 1) Yöntem: session_id'den pending payment kaydını bul
        if (session_id) {
            const r = await pool.query(`SELECT user_id FROM payments WHERE provider_payment_id = $1 ORDER BY created_at DESC LIMIT 1`, [session_id]);
            userId = r.rows[0]?.user_id || null;
        }
        // 2) Yöntem: Authorization header
        if (!userId && req.headers.authorization) {
            try {
                const token = req.headers.authorization.replace('Bearer ', '');
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded?.id || null;
            } catch (e) {}
        }
        if (!userId) return res.redirect('/?page=subscription&billing=error');

        await activateUserSubscription(userId, plan, provider || 'mock', period || 'monthly');
        res.redirect('/?page=subscription&billing=success');
    } catch (err) {
        console.error('Billing success error:', err);
        res.redirect('/?page=subscription&billing=error');
    }
});

app.get('/billing/cancel', (req, res) => res.redirect('/?page=subscription&billing=cancelled'));

app.get('/billing/bank-info', async (req, res) => {
    const { ref, plan, period } = req.query;
    const bank = billingProviders.BANK_DETAILS;
    res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Banka Havalesi Bilgileri</title>
<style>body{font-family:'Manrope',sans-serif;background:#0f172a;color:#f8fafc;padding:40px;max-width:720px;margin:0 auto;}
h1{font-size:24px;margin:0 0 20px;}.row{display:flex;justify-content:space-between;padding:12px 16px;background:rgba(30,41,59,0.7);border-radius:10px;margin:8px 0;}
.row strong{color:#38bdf8;}a{color:#38bdf8;}</style></head><body>
<h1>Banka Havalesi ile Abonelik</h1>
<p>Lütfen aşağıdaki bilgilere göre transfer yapın. <strong>Açıklama alanına referans kodu yazmayı unutmayın</strong>; ödeme onaylandığında aboneliğiniz aktive edilir.</p>
<div class="row"><span>Plan</span><strong>${plan} (${period === 'yearly' ? 'Yıllık' : 'Aylık'})</strong></div>
<div class="row"><span>Banka</span><strong>${bank.bank_name}</strong></div>
<div class="row"><span>Hesap Sahibi</span><strong>${bank.account_holder}</strong></div>
<div class="row"><span>IBAN</span><strong>${bank.iban}</strong></div>
<div class="row"><span>SWIFT</span><strong>${bank.swift}</strong></div>
<div class="row"><span>Referans Kodu</span><strong>${ref}</strong></div>
<p style="margin-top:24px;"><a href="/?page=subscription">← Abonelik sayfasına dön</a></p>
</body></html>`);
});

async function activateUserSubscription(userId, planSlug, provider, period) {
    const planRes = await pool.query('SELECT id FROM subscription_plans WHERE slug = $1', [String(planSlug).toLowerCase()]);
    if (planRes.rows.length === 0) throw new Error('Plan bulunamadı');
    const planId = planRes.rows[0].id;
    const periodEnd = new Date();
    if (period === 'yearly') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await pool.query(
        `SELECT id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    if (existing.rows.length > 0) {
        await pool.query(
            `UPDATE subscriptions SET plan_id = $1, status = 'active', provider = $2,
             current_period_start = NOW(), current_period_end = $3, updated_at = NOW()
             WHERE id = $4`,
            [planId, provider, periodEnd, existing.rows[0].id]
        );
        await pool.query(`UPDATE payments SET status = 'completed' WHERE subscription_id = $1 AND status = 'pending'`, [existing.rows[0].id]);
        return existing.rows[0].id;
    }
    const ins = await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
         VALUES ($1, $2, 'active', $3, NOW(), $4) RETURNING id`,
        [userId, planId, provider, periodEnd]
    );
    return ins.rows[0].id;
}

// Stripe webhook (raw body için ayrı parse)
app.post('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const provider = billingProviders.StripeProvider;
        const { event } = provider.verifyWebhook(req.body.toString('utf8'), req.headers);
        const parsed = provider.parseWebhookEvent(event);

        if (parsed.status === 'completed' && parsed.user_id && parsed.plan_slug) {
            await activateUserSubscription(parsed.user_id, parsed.plan_slug, 'stripe', parsed.period);
        }
        if (parsed.status === 'cancelled' && parsed.user_id) {
            await pool.query(`UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = true, updated_at = NOW() WHERE user_id = $1 AND status = 'active'`, [parsed.user_id]);
        }
        // Audit
        await pool.query(
            `INSERT INTO payments (user_id, provider, provider_payment_id, amount, currency, status, metadata)
             VALUES ($1, 'stripe', $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [parsed.user_id || null, parsed.provider_payment_id, parsed.amount || 0, parsed.currency || 'TRY', parsed.status, JSON.stringify(parsed.metadata)]
        );
        res.json({ received: true });
    } catch (err) {
        console.error('Stripe webhook error:', err);
        res.status(400).json({ error: err.message });
    }
});

// iyzico webhook
app.post('/api/billing/webhook/iyzico', express.json(), async (req, res) => {
    try {
        const provider = billingProviders.IyzicoProvider;
        const { event } = provider.verifyWebhook(JSON.stringify(req.body), req.headers);
        const parsed = provider.parseWebhookEvent(event);
        if (parsed.status === 'completed' && parsed.user_id && parsed.plan_slug) {
            await activateUserSubscription(parsed.user_id, parsed.plan_slug, 'iyzico', parsed.period);
        }
        await pool.query(
            `INSERT INTO payments (user_id, provider, provider_payment_id, amount, currency, status, metadata)
             VALUES ($1, 'iyzico', $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [parsed.user_id || null, parsed.provider_payment_id, parsed.amount || 0, parsed.currency || 'TRY', parsed.status, JSON.stringify(parsed.metadata)]
        );
        res.json({ received: true });
    } catch (err) {
        console.error('iyzico webhook error:', err);
        res.status(400).json({ error: err.message });
    }
});

// Banka havalesi onay (admin)
app.post('/api/billing/bank-confirm', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { reference, user_id, plan_slug, period } = req.body || {};
        if (!user_id || !plan_slug) return res.status(400).json({ error: 'user_id ve plan_slug zorunlu' });
        const subId = await activateUserSubscription(Number(user_id), plan_slug, 'bank_transfer', period || 'monthly');
        await pool.query(`UPDATE payments SET status = 'completed' WHERE subscription_id = $1 AND status = 'pending'`, [subId]);
        if (reference) {
            await pool.query(`UPDATE payments SET bank_reference = $1 WHERE subscription_id = $2 AND provider = 'bank_transfer' AND status = 'completed'`, [reference, subId]);
        }
        res.json({ success: true, subscription_id: subId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bekleyen banka havalelerini listele (admin)
app.get('/api/billing/bank-pending', authMiddleware, adminOnly, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT p.id, p.user_id, p.amount, p.currency, p.bank_reference, p.metadata, p.created_at,
                   u.email, u.full_name, sp.slug AS plan_slug, sp.name AS plan_name
            FROM payments p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN subscriptions s ON p.subscription_id = s.id
            LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
            WHERE p.provider = 'bank_transfer' AND p.status = 'pending'
            ORDER BY p.created_at DESC LIMIT 200
        `);
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Aboneliği iptal et
app.post('/api/billing/cancel', authMiddleware, async (req, res) => {
    try {
        const sub = await getUserActiveSubscription(req.user.id);
        if (!sub) return res.status(404).json({ error: 'Aktif abonelik yok' });
        await pool.query(
            `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`,
            [sub.id]
        );
        res.json({ success: true, message: 'Mevcut dönem sonunda iptal edilecek' });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Plan yükselt / düşür (provider üzerinden değil, doğrudan değiştirme — yeni dönem aktive olur)
app.post('/api/billing/change-plan', authMiddleware, async (req, res) => {
    try {
        const { plan_slug, provider, period } = req.body || {};
        if (!plan_slug || !provider) return res.status(400).json({ error: 'plan_slug ve provider zorunlu' });
        // Yeni checkout başlat (mevcut abonelik checkout sırasında pending'e düşer, ödeme onaylanırken active olur)
        req.body = { plan_slug, provider, period };
        return app._router.handle(req, res, () => {});
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Fatura geçmişi
app.get('/api/billing/invoices', authMiddleware, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT p.id, p.amount, p.currency, p.status, p.payment_method, p.provider, p.invoice_url,
                   p.bank_reference, p.created_at, sp.name AS plan_name, sp.slug AS plan_slug,
                   inv.invoice_number, inv.invoice_type, inv.is_legal_invoice, inv.legal_invoice_pending,
                   inv.einvoice_pdf_url
            FROM payments p
            LEFT JOIN subscriptions s ON p.subscription_id = s.id
            LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
            LEFT JOIN invoices inv ON inv.payment_id = p.id
            WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 50
        `, [req.user.id]);
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// USAGE METERS — kullanım sayaçları
// ============================================
async function getCurrentMonthMeter(userId) {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const r = await pool.query(
        `INSERT INTO usage_meters (user_id, period_start) VALUES ($1, $2)
         ON CONFLICT (user_id, period_start) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [userId, periodStart]
    );
    return r.rows[0];
}

async function getPlanLimits(userId, userRole) {
    if (userRole === 'admin') {
        const preview = await getPreviewPlanSlug(userId);
        if (preview) {
            const p = await getPreviewPlanFeatures(preview);
            if (p) return p.plan_limits;
        }
        return { max_rivals: -1, history_months: -1, ai_queries_monthly: -1, export_rows_monthly: -1, api_requests_monthly: -1, whatsapp_phones: -1 };
    }
    const sub = await getUserActiveSubscription(userId);
    if (!sub) return { max_rivals: 0, history_months: 0, ai_queries_monthly: 0, export_rows_monthly: 0, api_requests_monthly: 0, whatsapp_phones: 0 };
    const r = await pool.query(`SELECT plan_limits FROM subscription_plans WHERE id = $1`, [sub.plan_id]);
    try {
        const raw = r.rows[0]?.plan_limits;
        return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    } catch (e) { return {}; }
}

app.get('/api/billing/usage', authMiddleware, async (req, res) => {
    try {
        const meter = await getCurrentMonthMeter(req.user.id);
        const limits = await getPlanLimits(req.user.id, req.user.role);
        res.json({
            period_start: meter.period_start,
            usage: {
                ai_queries: meter.ai_queries_count,
                ai_tokens: Number(meter.ai_tokens_used || 0),
                exports: meter.export_rows_count,
                api_requests: meter.api_request_count,
                whatsapp_queries: meter.whatsapp_query_count
            },
            limits,
            warnings: buildUsageWarnings(meter, limits)
        });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

function buildUsageWarnings(meter, limits) {
    const w = [];
    const ai_limit = limits.ai_queries_monthly;
    if (ai_limit > 0) {
        const pct = (meter.ai_queries_count / ai_limit) * 100;
        if (pct >= 100) w.push({ level: 'critical', key: 'ai_queries', message: 'AI sorgu kotanız tükendi. Yenilenme: bir sonraki ay başı.' });
        else if (pct >= 80) w.push({ level: 'warn', key: 'ai_queries', message: `AI kotanızın %${Math.round(pct)}'i kullanıldı.` });
    }
    return w;
}

// requireAiQuota middleware — AI çağrılarında kota kontrolü
function requireAiQuota() {
    return async (req, res, next) => {
        try {
            if (req.user.role === 'admin') return next();
            const limits = await getPlanLimits(req.user.id, req.user.role);
            const limit = limits.ai_queries_monthly;
            if (limit === 0) {
                return res.status(402).json({
                    code: 'AI_NOT_INCLUDED',
                    error: 'Mevcut paketinizde AI sorgu yok',
                    upgrade_url: '/?page=subscription'
                });
            }
            if (limit > 0) {
                const meter = await getCurrentMonthMeter(req.user.id);
                if (meter.ai_queries_count >= limit) {
                    return res.status(402).json({
                        code: 'AI_QUOTA_EXHAUSTED',
                        error: 'Aylık AI sorgu kotanız doldu',
                        used: meter.ai_queries_count,
                        limit,
                        upgrade_url: '/?page=subscription'
                    });
                }
            } else if (limit === -1) {
                // Sınırsız ama fair-use: 24 saat içinde 200 sorgu üstü ise yavaşlat
                const fr = await pool.query(
                    `SELECT COUNT(*)::int AS c FROM ai_usage_log WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
                    [req.user.id]
                );
                if ((fr.rows[0]?.c || 0) > 200) {
                    return res.status(429).json({
                        code: 'AI_FAIR_USE_THROTTLE',
                        error: 'Fair-use limiti: son 24 saatte 200 sorgu aşıldı. Lütfen biraz bekleyin.'
                    });
                }
            }
            next();
        } catch (err) {
            console.error('requireAiQuota error:', err);
            next();
        }
    };
}

async function recordAiUsage(userId, feature, model, inputTokens, outputTokens) {
    const cost = ((Number(inputTokens) || 0) * 0.0000028) + ((Number(outputTokens) || 0) * 0.0000037);
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    await pool.query(
        `INSERT INTO ai_usage_log (user_id, feature, model, input_tokens, output_tokens, cost_tl) VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, feature, model, inputTokens || 0, outputTokens || 0, cost.toFixed(4)]
    );
    await pool.query(
        `INSERT INTO usage_meters (user_id, period_start, ai_queries_count, ai_tokens_used)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, period_start) DO UPDATE SET
            ai_queries_count = usage_meters.ai_queries_count + 1,
            ai_tokens_used = usage_meters.ai_tokens_used + $3,
            updated_at = NOW()`,
        [userId, periodStart, (Number(inputTokens) || 0) + (Number(outputTokens) || 0)]
    );
}

// ============================================
// RAKİP SEÇİMİ — Growth = 5 rakip, Enterprise = sınırsız
// ============================================
app.get('/api/billing/rivals', authMiddleware, async (req, res) => {
    try {
        const sub = await getUserActiveSubscription(req.user.id);
        const limits = await getPlanLimits(req.user.id, req.user.role);
        let rivals = [];
        try {
            rivals = typeof sub?.rivals_selection === 'string' ? JSON.parse(sub.rivals_selection) : (sub?.rivals_selection || []);
        } catch (e) { rivals = []; }
        res.json({
            selected: rivals,
            max_rivals: limits.max_rivals,
            available_brands: req.user.role === 'admin' ? null : (await pool.query('SELECT id, name, slug FROM brands ORDER BY name')).rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.put('/api/billing/rivals', authMiddleware, async (req, res) => {
    try {
        const { rival_brand_ids } = req.body || {};
        if (!Array.isArray(rival_brand_ids)) return res.status(400).json({ error: 'rival_brand_ids array olmalı' });
        const limits = await getPlanLimits(req.user.id, req.user.role);
        if (limits.max_rivals !== -1 && rival_brand_ids.length > limits.max_rivals) {
            return res.status(400).json({ error: `Paketiniz en fazla ${limits.max_rivals} rakip seçimine izin veriyor`, max_rivals: limits.max_rivals });
        }
        const sub = await getUserActiveSubscription(req.user.id);
        if (!sub) return res.status(404).json({ error: 'Aktif abonelik yok' });
        await pool.query(
            `UPDATE subscriptions SET rivals_selection = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(rival_brand_ids.map(Number)), sub.id]
        );
        res.json({ success: true, selected: rival_brand_ids });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// WHATSAPP TELEFON YÖNETİMİ — sadece Enterprise
// ============================================
app.get('/api/billing/whatsapp', authMiddleware, async (req, res) => {
    try {
        const limits = await getPlanLimits(req.user.id, req.user.role);
        if (limits.whatsapp_phones === 0 && req.user.role !== 'admin') {
            return res.status(402).json({ code: 'WHATSAPP_NOT_INCLUDED', error: 'WhatsApp kanalı sadece Enterprise pakette' });
        }
        const r = await pool.query(
            `SELECT id, phone_e164, display_name, role_label, is_active, is_primary, admin_approved, last_query_at, monthly_query_count
             FROM whatsapp_phones WHERE user_id = $1 ORDER BY is_primary DESC, activated_at`,
            [req.user.id]
        );
        res.json({ phones: r.rows, max_phones: limits.whatsapp_phones, used: r.rows.length });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/billing/whatsapp', authMiddleware, async (req, res) => {
    try {
        const { phone_e164, display_name, role_label, is_primary } = req.body || {};
        if (!phone_e164 || !/^\+?\d{10,15}$/.test(String(phone_e164).replace(/\s/g, ''))) {
            return res.status(400).json({ error: 'Geçerli bir telefon numarası girin (+905xxxxxxxxx)' });
        }
        const normalized = String(phone_e164).replace(/\s/g, '').startsWith('+') ? String(phone_e164).replace(/\s/g, '') : '+' + String(phone_e164).replace(/\s/g, '');

        const limits = await getPlanLimits(req.user.id, req.user.role);
        if (limits.whatsapp_phones === 0 && req.user.role !== 'admin') {
            return res.status(402).json({ code: 'WHATSAPP_NOT_INCLUDED', error: 'WhatsApp kanalı paketinizde yok' });
        }
        const existing = await pool.query(`SELECT COUNT(*)::int AS c FROM whatsapp_phones WHERE user_id = $1`, [req.user.id]);
        if (limits.whatsapp_phones !== -1 && existing.rows[0].c >= limits.whatsapp_phones) {
            return res.status(400).json({ error: `En fazla ${limits.whatsapp_phones} telefon hattı tanımlanabilir` });
        }
        const dup = await pool.query(`SELECT id FROM whatsapp_phones WHERE phone_e164 = $1`, [normalized]);
        if (dup.rows.length > 0) return res.status(409).json({ error: 'Bu numara başka bir hesaba kayıtlı' });

        const sub = await getUserActiveSubscription(req.user.id);
        const ins = await pool.query(
            `INSERT INTO whatsapp_phones (user_id, subscription_id, phone_e164, display_name, role_label, is_primary, admin_approved)
             VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
            [req.user.id, sub?.id || null, normalized, display_name || null, role_label || null, !!is_primary]
        );
        res.status(201).json({ success: true, phone: ins.rows[0], note: 'Numaranız admin onayından sonra aktif olacaktır.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/billing/whatsapp/:id', authMiddleware, async (req, res) => {
    try {
        const r = await pool.query(`DELETE FROM whatsapp_phones WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.user.id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Telefon bulunamadı' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/billing/whatsapp/:id/approve', authMiddleware, adminOnly, async (req, res) => {
    try {
        await pool.query(
            `UPDATE whatsapp_phones SET admin_approved = true, admin_approved_at = NOW(), admin_approved_by = $1 WHERE id = $2`,
            [req.user.id, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

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
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.put('/api/notifications/:id/read', authMiddleware, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
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
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { email, password_hash, full_name, role, brand_id, company_name, city } = req.body;
        const hash = await bcrypt.hash(password_hash, 10);
        const result = await pool.query(`
            INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name, city)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, full_name, role, brand_id
        `, [email, hash, full_name, role || 'brand_user', brand_id, company_name, city]);
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

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

// ============================================
// MINIMAX AI ANALYSIS (OpenAI-compatible API)
// ============================================
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || process.env.GROQ_API_KEY;
const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const MINIMAX_MODEL = 'MiniMax-M2.7';

// ============================================
// WHATSAPP KONUŞMA HAFIZASI (Session Memory)
// Her kullanıcının son 10 mesajını tutar
// ============================================
const conversationMemory = new Map(); // phone → [{role, content, timestamp}]
const MEMORY_MAX_MESSAGES = 10;
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 dakika sonra oturum sıfırlanır

function getConversationHistory(phoneNumber) {
    const history = conversationMemory.get(phoneNumber);
    if (!history || history.length === 0) return [];
    // TTL kontrolü - son mesaj 30dk'dan eskiyse temizle
    const lastMsg = history[history.length - 1];
    if (Date.now() - lastMsg.timestamp > MEMORY_TTL_MS) {
        conversationMemory.delete(phoneNumber);
        return [];
    }
    return history;
}

function addToConversation(phoneNumber, role, content) {
    if (!conversationMemory.has(phoneNumber)) {
        conversationMemory.set(phoneNumber, []);
    }
    const history = conversationMemory.get(phoneNumber);
    history.push({ role, content, timestamp: Date.now() });
    // Son N mesajı tut
    while (history.length > MEMORY_MAX_MESSAGES) {
        history.shift();
    }
}

function buildConversationContext(history) {
    if (!history || history.length === 0) return '';
    const lines = history.map(h => `${h.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${h.content.substring(0, 300)}`);
    return `\n\nÖNCEKİ KONUŞMA BAĞLAMI (son ${history.length} mesaj):\n${lines.join('\n')}\n`;
}

app.post('/api/ai/analyze', authMiddleware, async (req, res) => {
    try {
        if (!MINIMAX_API_KEY) return res.status(500).json({ error: 'MINIMAX_API_KEY tanımlı değil' });

        const { type, context } = req.body;
        if (!type) return res.status(400).json({ error: 'Analiz tipi gerekli' });

        // Build prompt based on analysis type
        let systemPrompt = `Sen Türkiye traktör sektörü konusunda uzman bir analistsin. Verilen verileri analiz edip Türkçe olarak profesyonel, derinlikli, stratejik öneriler içeren raporlar hazırlıyorsun. Yanıtlarında markdown formatı kullan. Kısa ve öz ol ama derinlikli analiz yap. Sayısal verilerle destekle.`;

        let userPrompt = '';

        if (type === 'model-region') {
            const {
                brandName,
                modelName,
                overview = {},
                regionLadder = [],
                whitespaceProvinces = [],
                provinceArena = [],
                siblingStack = [],
                rivalStack = []
            } = context || {};

            const regionStr = regionLadder.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.region}: ${item.total_sales} adet, pay ${item.share_pct}%, uyum ${item.avg_fit_score}, YoY ${item.yoy_growth_pct ?? 'yeni'}, ana urun ${item.dominant_crop || '-'}, rol ${item.mission_label || '-'}`
            ).join('\n');

            const whitespaceStr = whitespaceProvinces.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.province_name} (${item.region}): firsat ${item.opportunity_score}, uyum ${item.fit_score}, il pazari ${item.province_market_units}, model payi ${item.province_share_pct}%, urun ${item.dominant_crop || '-'}, destek ${item.support_programs || 'yok'}`
            ).join('\n');

            const arenaStr = provinceArena.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.province_name} (${item.region}): toplam ${item.total_sales} adet, il payi ${item.province_share_pct}%, uyum ${item.fit_score}, YoY ${item.yoy_growth_pct ?? 'yeni'}, urun ${item.dominant_crop || '-'}`
            ).join('\n');

            const siblingStr = siblingStack.slice(0, 6).map((item, index) =>
                `${index + 1}. ${item.model_name}: ${item.hp_range || '-'} HP, toplam ${item.total_sales} adet, rol ${item.role_note || '-'}`
            ).join('\n');

            const rivalStr = rivalStack.slice(0, 6).map((item, index) =>
                `${index + 1}. ${item.brand_name} / ${item.model_name}: ${item.total_sales} adet, baskin bolge ${item.dominant_region || '-'}`
            ).join('\n');

            userPrompt = `**${brandName || '-'} / ${modelName || '-'}** icin model-bolge saha plani hazirla.

MODEL OZETI:
- Toplam model satisi: ${overview.total_sales || 0} adet
- Son pencere satisi: ${overview.current_year_sales || 0} adet
- Yillik degisim: ${overview.yoy_growth_pct ?? 'yeni'}%
- Aktif il: ${overview.active_provinces || 0}
- Aktif bolge: ${overview.active_regions || 0}
- Ulusal model payi: ${overview.national_model_share_pct || 0}%
- Ortalama il payi: ${overview.avg_province_share_pct || 0}%
- Dogal habitat: ${overview.dominant_region || '-'}
- Agro eksen: ${overview.dominant_crop || '-'}
- Destek etkisi: ${overview.support_driven_share_pct || 0}%
- Tahmini toplam ciro: ${overview.estimated_revenue_usd ? Math.round(overview.estimated_revenue_usd / 1000) + 'K $' : 'fiyat verisi sinirli'}

BOLGE KOMUT CETVELI:
${regionStr || '-'}

BEYAZ ALAN ILLERI:
${whitespaceStr || '-'}

MEVCUT HABITAT ILLERI:
${arenaStr || '-'}

KARDES MODEL ROUTING:
${siblingStr || '-'}

RAKIP MODEL BASKISI:
${rivalStr || '-'}

Su basliklarda yonetim kuruluna sunulacak kadar net ve profesyonel bir analiz yap:
1. **Modelin Dogal Habitat Tezi**: Bu modelin hangi bolge ve urun deseninde dogal olarak kazandigini acikla.
2. **Savunulacak Kale / Buyutulecek Cephe**: Mevcut habitatta korunacak illerle buyume yatirimi yapilacak illeri ayir.
3. **Beyaz Alan Saldiri Plani**: Ilk 90 gunde gidilecek ilk 3 il ve nedenleri.
4. **Kardes Model Routing**: Portfoy icinde bu model hangi rolleri ustlenmeli, hangi kardes modelle saha cakisimi onlenmeli?
5. **Rakip Kirma Taktikleri**: Ayni koridordaki rakip modellere karsi fiyatlama, bayi, demo ve ekipman paketi bazli somut taktikler ver.
6. **Riskler ve Ongoruler**: Destek, iklim, urun deseni ve pazar yogunluguna gore gelecek donem risk/firsat analizi yap.
7. **CEO Ozet Notu**: En sonda 5 maddelik cok net aksiyon listesi ver.`;

        } else if (type === 'brand-region') {
            // Brand-specific regional analysis
            const { brandName, provinces, models, totalSales, totalRevenue } = context;
            const topProvStr = (provinces || []).slice(0, 10).map((p, i) =>
                `${i + 1}. ${p.name} (${p.region}): ${p.total} adet, Pazar payı: ${p.marketShareCurr}%, YoY: ${p.yoyGrowth}%, Bahçe: ${(p.bahce / (p.total || 1) * 100).toFixed(0)}%, Toprak: ${p.soil_type || '-'}, İklim: ${p.climate_zone || '-'}, Ürünler: ${Array.isArray(p.primary_crops) ? p.primary_crops.join(', ') : (p.primary_crops || '-')}, Tahmini Ciro: ${Math.round(p.estimatedRevenue / 1000000)}M $`
            ).join('\n');
            const modelStr = (models || []).map(m => `${m.name} (${m.hp}HP, ${m.category}, ${m.price ? Math.round(m.price / 1000) + 'B TL' : '-'})`).join(', ');

            userPrompt = `**${brandName}** markası için bölgesel strateji analizi yap.

TOPLAM VERİ:
- Toplam satış: ${totalSales} adet
- Tahmini toplam ciro: ${Math.round(totalRevenue / 1000000)}M $
- Model portföyü: ${modelStr}

İL BAZLI VERİLER (Top 10):
${topProvStr}

Şu başlıklarda analiz yap:
1. **Bölgesel Güç Analizi**: Hangi bölgelerde güçlü, hangilerde zayıf?
2. **Model-Bölge Uyumu**: Hangi modeller hangi bölgelere daha uygun? Tarımsal desen ve toprak yapısına göre değerlendir.
3. **Büyüme Fırsatları**: YoY verilere göre hangi illerde potansiyel var?
4. **Satış Stratejisi Önerileri**: Pazar payını artırmak için 3-5 somut öneri.
5. **Risk Değerlendirmesi**: Pazar kaybı riski olan bölgeler ve nedenleri.
6. **Gelecek Beklentileri**: Trendlere göre önümüzdeki dönem öngörüleri.`;

        } else if (type === 'regional-province') {
            const {
                provinceName,
                region,
                provinceMetrics = {},
                overview = {},
                focusBrand = {},
                topBrands = [],
                topModels = [],
                soilMachineRows = [],
                cropOperationRows = [],
                climateActions = [],
                narrative = []
            } = context || {};

            const brandStr = topBrands.slice(0, 6).map((item, index) =>
                `${index + 1}. ${item.brand_name || item.name || '-'}: ${item.total_sales || item.total || 0} adet, pay ${item.share_pct || item.share || 0}%, HP ${item.avg_hp || item.avgHp || '-'}, tahmini gelir ${item.revenue_band || '-'}`
            ).join('\n');

            const modelStr = topModels.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.model_name || '-'}: ${item.sales || item.total_sales || 0} adet, ${item.hp || item.hp_band || '-'}, ${item.drive || item.drive_type || '-'}, ${item.reason || item.fit_note || '-'}`
            ).join('\n');

            const soilStr = soilMachineRows.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.soil || '-'} / ${item.texture || '-'}: urun ${item.crop || '-'}, cekis ${item.drive || '-'}, HP ${item.hpBand || '-'}, ekipman ${item.implement || '-'}`
            ).join('\n');

            const cropStr = cropOperationRows.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.crop || '-'}: alan ${item.area || '-'}, uretim ${item.production || '-'}, HP ${item.hpBand || '-'}, arketip ${item.archetype || '-'}, ekipman ${item.implement || '-'}`
            ).join('\n');

            const climateStr = climateActions.slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.month || '-'}: sicaklik ${item.temp ?? '-'}, yagis ${item.rain ?? '-'}, kuraklik ${item.drought ?? '-'}, aksiyon ${item.action || '-'}`
            ).join('\n');

            const narrativeStr = Array.isArray(narrative) && narrative.length
                ? narrative.map((item, index) => `${index + 1}. ${item}`).join('\n')
                : '-';

            userPrompt = `**${provinceName || '-'} / ${region || '-'}** icin bolgesel mekanizasyon strateji raporu hazirla.

IL KOMUTA OZETI:
- Toplam satis: ${provinceMetrics.total || overview.total_sales || 0} adet
- Mekanizasyon endeksi: ${provinceMetrics.mechIndex || provinceMetrics.mech_index || 0}
- Ortalama HP: ${provinceMetrics.avgHp || provinceMetrics.avg_hp || overview.avg_hp || 0}
- 4WD orani: ${provinceMetrics.ratio4wd || provinceMetrics.drive_ratio_4wd || 0}%
- Kabin orani: ${provinceMetrics.cabinRatio || provinceMetrics.cabin_ratio || 0}%
- Yillik degisim: ${provinceMetrics.yoyGrowth || provinceMetrics.yoy_growth_pct || 0}%
- Fokus marka: ${focusBrand?.brand_name || focusBrand?.name || '-'}
- Fokus marka payi: ${focusBrand?.share_pct || focusBrand?.share || 0}%
- Dominant urun/desen: ${overview.dominant_crop || overview.primary_crop || '-'}
- Toprak tipi: ${overview.soil_type || provinceMetrics.soil_type || '-'}
- Iklim zonu: ${overview.climate_zone || provinceMetrics.climate_zone || '-'}

AKICI SAHA OKUMASI:
${narrativeStr}

MARKA LIDERLIK CETVELI:
${brandStr || '-'}

TERCIH EDILEN TRAKTOR STACKI:
${modelStr || '-'}

TOPRAK - MAKINA MATRISI:
${soilStr || '-'}

URUN - OPERASYON ORKESTRASI:
${cropStr || '-'}

IKLIM AKSIYON CETVELI:
${climateStr || '-'}

Yonetim kuruluna sunulacak profesyonel bir strateji raporu yaz. Sunum dili net, akici ve premium olsun.
Su basliklarda cikti ver:
1. **Ilin Mekanizasyon Kimligi**: Il hangi tarimsal ve mekanik DNA ile tanimlaniyor?
2. **Toprak-Urun-Makina Tezi**: Toprak yapisi, ekili urunler ve tercih edilen traktor mimarisi arasindaki iliskiyi derinlikli kur.
3. **Marka ve Portfoy Rekabeti**: Hangi markalar ve modeller kazaniyor, neden kazaniyor?
4. **Onerilen Traktor ve Ekipman Mimarisi**: Bu il icin satilmasi gereken ideal HP, cekis, kabin, ekipman paketini acikla.
5. **90 Gunluk Saha Plani**: Bayi, demo, ekipman paketi, kampanya ve stok tarafinda cok somut hamleler ver.
6. **Riskler ve Firsatlar**: Iklim, urun deseni, mekanizasyon seviyesi ve pazar yogunluguna gore firsat/risk matrisi kur.
7. **5 Yillik Ongoruler**: Bu ilde gelecek yillarda hangi tip traktorlere ve ekipmanlara kayis olacagini aciklanabilir sekilde tahmin et.
8. **CEO Aksiyon Notu**: En sonda 5 maddelik cok net yonetici ozet listesi ver.`;

        } else if (type === 'regional-index') {
            const { year, provinces: provs } = context;
            const top10 = (provs || []).slice(0, 15).map((p, i) =>
                `${i + 1}. ${p.name} (${p.region}): ${p.total} adet, Bahçe: ${p.bahceRatio?.toFixed(0)}%, Ort.HP: ${p.avgHp}, 4WD: ${p.ratio4wd?.toFixed(0)}%, Mek.İndeks: ${p.mechIndex}, YoY: ${p.yoyGrowth}%, Toprak: ${p.soil_type || '-'}`
            ).join('\n');

            userPrompt = `${year} yılı Türkiye traktör sektörü bölgesel mekanizasyon analizi yap.

İL BAZLI VERİLER (Top 15):
${top10}

Şu başlıklarda analiz yap:
1. **Mekanizasyon Düzeyi**: Hangi iller/bölgeler mekanizasyonda öncü?
2. **Bahçe vs Tarla Analizi**: Coğrafi dağılım ve nedenleri. Bahçe traktörü yoğun bölgelerdeki tarımsal desen.
3. **HP Trend Analizi**: Ortalama HP'nin bölgelere göre farklılaşma nedenleri.
4. **Teknoloji Adaptasyonu**: 4WD ve kabinli traktör oranlarının bölgesel dağılımı ne söylüyor?
5. **Büyüme Haritası**: En hızlı büyüyen ve gerileyen bölgeler. Nedenler.
6. **Stratejik Öneriler**: Sektör oyuncuları için bölgesel strateji önerileri.`;

        } else if (type === 'tarmakbir-command') {
            const {
                year,
                filteredTotal,
                fullTotal,
                carryoverTotal,
                carryoverShare,
                filteredYoy,
                topBrands,
                focusBrand,
                pressureMonths
            } = context;

            const topBrandStr = (topBrands || []).slice(0, 8).map((item, index) =>
                `${index + 1}. ${item.name}: ${item.total} adet, pay ${item.share}%, zirve ay ${item.peakMonth}, Q4 agirligi ${item.q4Share}%`
            ).join('\n');

            const pressureStr = (pressureMonths || []).slice(0, 6).map(item =>
                `${item.month}: butun madde ${item.fullTotal}, N+N1 ${item.filteredTotal}, fark ${item.gap}, fark orani ${item.gapShare}%`
            ).join('\n');

            const focusBrandStr = focusBrand
                ? `${focusBrand.name}: sira ${focusBrand.rank}, toplam ${focusBrand.total} adet, pay ${focusBrand.share}%, zirve ay ${focusBrand.peakMonth}, ritim ${focusBrand.rhythm}`
                : 'Odak marka secili degil; analizi toplam pazar bakisiyla yap.';

            userPrompt = `${year} yili icin TarmakBir komuta merkezi analizi yap.

ANA KPI:
- N+N1 filtreli toplam: ${filteredTotal} adet
- Butun madde toplam: ${fullTotal} adet
- Eski model / carryover etkisi: ${carryoverTotal} adet
- Carryover payi: ${carryoverShare}%
- N+N1 yillik degisim: ${filteredYoy}%

ODAK MARKA:
${focusBrandStr}

MARKA LIDERLIK TABLOSU:
${topBrandStr}

AYLIK BASKI NOKTALARI:
${pressureStr}

Su basliklarda yonetime sunulacak kadar aksiyon odakli analiz yap:
1. **Pazar Ritim Okumasi**: N+N1 ve butun madde arasindaki fark ne anlatiyor?
2. **Carryover / Eski Model Baskisi**: Hangi aylarda stok veya gecis baskisi yuksek?
3. **Marka Yogunlugu**: Lider markalar pazari nasil kilitliyor, nerede acik alan olabilir?
4. **Odak Marka Hamlesi**: Secili marka varsa hangi 3 hamleyle saha pozisyonu guclenir?
5. **Ticari Alarm Listesi**: Hemen izlenmesi gereken riskler ve nedenleri.
6. **90 Gunluk Plan**: Kisa vadede uygulanabilir 5 somut aksiyon oner.`;

        } else if (type === 'brand-compare') {
            const { brand1, brand2, data1, data2, maxYear } = context;
            userPrompt = `**${brand1}** vs **${brand2}** marka karşılaştırma analizi yap.

${brand1}: ${maxYear} satış: ${data1.currPartial} adet, YoY: ${data1.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data1.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data1.avgPrice / 1000)}B TL, Model sayısı: ${data1.models?.length}
${brand2}: ${maxYear} satış: ${data2.currPartial} adet, YoY: ${data2.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data2.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data2.avgPrice / 1000)}B TL, Model sayısı: ${data2.models?.length}

Şu başlıklarda karşılaştırmalı analiz yap:
1. **Pazar Konumları**: Her iki markanın güçlü ve zayıf yönleri.
2. **Fiyat-Performans**: Fiyat stratejileri ve değer önerileri.
3. **Büyüme Dinamikleri**: YoY trendler neyi işaret ediyor?
4. **Rekabet Avantajları**: Her markanın temel rekabet üstünlüğü.
5. **Gelecek Öngörüleri**: Pazar payı değişim beklentileri.`;

        } else {
            return res.status(400).json({ error: 'Bilinmeyen analiz tipi' });
        }

        // Call Groq API
        const groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MINIMAX_API_KEY}`
            },
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: 2048
            })
        });

        if (!groqRes.ok) {
            const errBody = await groqRes.text();
            console.error('Groq API error:', groqRes.status, errBody);
            return res.status(500).json({ error: `Groq API hatası: ${groqRes.status}` });
        }

        const groqData = await groqRes.json();
        const aiResponse = groqData.choices?.[0]?.message?.content || 'AI yanıtı alınamadı';

        res.json({
            analysis: aiResponse,
            model: groqData.model,
            usage: groqData.usage
        });

    } catch (err) {
        console.error('AI analyze error:', err);
        res.status(500).json({ error: 'AI analiz hatası: ' + err.message });
    }
});

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
        res.status(500).json({ error: 'Model görseli seed başarısız: ' + err.message });
    }
});

// ============================================
// SEED TRACTOR MODELS (admin)
// ============================================
app.post('/api/admin/seed-models', async (req, res) => {
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
        res.status(500).json({ error: err.message });
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
app.post('/api/admin/reseed-sales', async (req, res) => {
    try {
        await pool.query('DELETE FROM sales_data');
        console.log('🗑️ Eski satış verisi silindi, yeniden seed ediliyor...');
        // Forward to seed-sales
        res.redirect(307, '/api/admin/seed-sales');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/trigger-import', authMiddleware, async (req, res) => {
    // Only allow system admins
    if (req.user.role !== 'system_admin') return res.status(403).json({ error: 'Yetkisiz erişim' });

    // Don't await synchronously for 2 minutes and risk HTTP timeout, run asynchronously
    const { importExcel } = require('./import-tuik.js');

    importExcel().then(result => {
        console.log('Online import finished:', result);
    }).catch(err => {
        console.error('Online import failed:', err);
    });

    res.json({ message: 'Veri yükleme/aktarma işlemi arka planda başlatıldı. Yaklaşık 2-3 dakika sürebilir.' });
});

app.post('/api/admin/seed-sales', async (req, res) => {
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

        // Demo kullanıcılar
        const bcryptLib = require('bcryptjs');
        const demoHash = await bcryptLib.hash('demo2024', 10);
        for (const brand of brandRows.rows) {
            await pool.query(`INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name) VALUES ($1,$2,$3,'brand_user',$4,$5) ON CONFLICT DO NOTHING`,
                [`demo@${brand.slug}.com`, demoHash, `${brand.slug.toUpperCase()} Demo`, brand.id, `${brand.slug.toUpperCase()} Bayii`]);
        }

        res.json({ message: `✅ ${salesCount} satış kaydı ve ${brandRows.rows.length} demo kullanıcı oluşturuldu` });
    } catch (err) {
        console.error('Seed error:', err);
        res.status(500).json({ error: err.message });
    }
});

async function ensureBrandPortalSeeded() {
    const curatedPortalSeed = require('./database/brand-portal-seed');
    const { brands: seedBrands } = require('./database/seed-data');
    const brandsRes = await pool.query(`
        SELECT id, name, slug, website, description
        FROM brands
        WHERE is_active = true
        ORDER BY name
    `);

    const brandMap = new Map(brandsRes.rows.map(row => [getCanonicalBrandPortalSlug(row.name), row]));
    const seedBrandMap = new Map(seedBrands.map(brand => [getCanonicalBrandPortalSlug(brand.name), brand]));

    for (const brand of brandsRes.rows) {
        const canonicalSlug = getCanonicalBrandPortalSlug(brand.name);
        const seedBrand = seedBrandMap.get(canonicalSlug);
        const defaultSourceNotes = JSON.stringify(
            brand.website
                ? [{ label: 'Resmi site', url: brand.website }]
                : []
        );

        if (seedBrand) {
            await pool.query(`
                UPDATE brands
                SET
                    primary_color = $1,
                    secondary_color = $2,
                    accent_color = $3,
                    text_color = $4,
                    country_of_origin = COALESCE(country_of_origin, $5),
                    parent_company = COALESCE(parent_company, $6)
                WHERE id = $7
            `, [
                seedBrand.primary_color,
                seedBrand.secondary_color,
                seedBrand.accent_color,
                seedBrand.text_color,
                seedBrand.country_of_origin,
                seedBrand.parent_company,
                brand.id
            ]);
        }

        await pool.query(`
            INSERT INTO brand_portal_profiles (
                brand_id, tagline, hero_title, hero_subtitle, overview,
                website_url, source_notes_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            ON CONFLICT (brand_id) DO NOTHING
        `, [
            brand.id,
            `${brand.name} icin ozel marka deneyimi`,
            `${brand.name} Marka Merkezi`,
            `${brand.name} markasi icin login, urun, saha ve haber akislarini bir araya getiren ozel deneyim.`,
            brand.description || `${brand.name} icin marka deneyimini zenginlestiren portal profili.`,
            brand.website || null,
            defaultSourceNotes
        ]);
    }

    for (const [slug, seedPayload] of Object.entries(curatedPortalSeed || {})) {
        const brand = brandMap.get(slug);
        if (!brand) continue;

        const profile = seedPayload.profile || {};
        await pool.query(`
            INSERT INTO brand_portal_profiles (
                brand_id, tagline, hero_title, hero_subtitle, overview,
                website_url, dealer_locator_url, price_list_url, portal_url,
                contact_phone, contact_email, whatsapp_url, headquarters,
                hero_stats_json, social_links_json, product_lines_json,
                focus_regions_json, source_notes_json, updated_at
            )
            VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9,
                $10, $11, $12, $13,
                $14::jsonb, $15::jsonb, $16::jsonb,
                $17::jsonb, $18::jsonb, NOW()
            )
            ON CONFLICT (brand_id) DO UPDATE SET
                tagline = EXCLUDED.tagline,
                hero_title = EXCLUDED.hero_title,
                hero_subtitle = EXCLUDED.hero_subtitle,
                overview = EXCLUDED.overview,
                website_url = EXCLUDED.website_url,
                dealer_locator_url = EXCLUDED.dealer_locator_url,
                price_list_url = EXCLUDED.price_list_url,
                portal_url = EXCLUDED.portal_url,
                contact_phone = EXCLUDED.contact_phone,
                contact_email = EXCLUDED.contact_email,
                whatsapp_url = EXCLUDED.whatsapp_url,
                headquarters = EXCLUDED.headquarters,
                hero_stats_json = EXCLUDED.hero_stats_json,
                social_links_json = EXCLUDED.social_links_json,
                product_lines_json = EXCLUDED.product_lines_json,
                focus_regions_json = EXCLUDED.focus_regions_json,
                source_notes_json = EXCLUDED.source_notes_json,
                updated_at = NOW()
        `, [
            brand.id,
            profile.tagline || null,
            profile.hero_title || null,
            profile.hero_subtitle || null,
            profile.overview || null,
            profile.website_url || brand.website || null,
            profile.dealer_locator_url || null,
            profile.price_list_url || null,
            profile.portal_url || null,
            profile.contact_phone || null,
            profile.contact_email || null,
            profile.whatsapp_url || null,
            profile.headquarters || null,
            JSON.stringify(profile.hero_stats_json || []),
            JSON.stringify(profile.social_links_json || []),
            JSON.stringify(profile.product_lines_json || []),
            JSON.stringify(profile.focus_regions_json || []),
            JSON.stringify(profile.source_notes_json || [])
        ]);

        for (const item of seedPayload.items || []) {
            await pool.query(`
                INSERT INTO brand_portal_items (
                    brand_id, item_type, title, summary, cta_label, cta_url,
                    image_url, meta_json, published_at, priority, is_featured, is_active, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8::jsonb, $9, $10, $11, true, NOW()
                )
                ON CONFLICT (brand_id, item_type, title) DO UPDATE SET
                    summary = EXCLUDED.summary,
                    cta_label = EXCLUDED.cta_label,
                    cta_url = EXCLUDED.cta_url,
                    image_url = EXCLUDED.image_url,
                    meta_json = EXCLUDED.meta_json,
                    published_at = EXCLUDED.published_at,
                    priority = EXCLUDED.priority,
                    is_featured = EXCLUDED.is_featured,
                    is_active = true,
                    updated_at = NOW()
            `, [
                brand.id,
                item.item_type,
                item.title,
                item.summary || null,
                item.cta_label || null,
                item.cta_url || null,
                item.image_url || null,
                JSON.stringify(item.meta_json || {}),
                item.published_at || null,
                item.priority || 100,
                item.is_featured === true
            ]);
        }

        for (const contact of seedPayload.contacts || []) {
            await pool.query(`
                INSERT INTO brand_portal_contacts (
                    brand_id, contact_type, label, region_name, city,
                    contact_name, title, phone, email, url, sort_order, is_active, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11, true, NOW()
                )
                ON CONFLICT (brand_id, contact_type, label, city) DO UPDATE SET
                    region_name = EXCLUDED.region_name,
                    contact_name = EXCLUDED.contact_name,
                    title = EXCLUDED.title,
                    phone = EXCLUDED.phone,
                    email = EXCLUDED.email,
                    url = EXCLUDED.url,
                    sort_order = EXCLUDED.sort_order,
                    is_active = true,
                    updated_at = NOW()
            `, [
                brand.id,
                contact.contact_type,
                contact.label,
                contact.region_name || null,
                contact.city || null,
                contact.contact_name || null,
                contact.title || null,
                contact.phone || null,
                contact.email || null,
                contact.url || null,
                contact.sort_order || 100
            ]);
        }
    }
}

async function ensureFutureIntelligenceSeeded() {
    const {
        intelligenceSources = [],
        supportPrograms = [],
        supportApplicationWindows = []
    } = require('./database/future-intelligence-seed');

    const sourceIdMap = new Map();

    for (const source of intelligenceSources) {
        const result = await pool.query(`
            INSERT INTO intelligence_sources (
                source_code, title, publisher, source_type, geography_scope,
                official_url, publication_date, notes, is_active, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW())
            ON CONFLICT (source_code) DO UPDATE SET
                title = EXCLUDED.title,
                publisher = EXCLUDED.publisher,
                source_type = EXCLUDED.source_type,
                geography_scope = EXCLUDED.geography_scope,
                official_url = EXCLUDED.official_url,
                publication_date = EXCLUDED.publication_date,
                notes = EXCLUDED.notes,
                is_active = true,
                updated_at = NOW()
            RETURNING id, source_code
        `, [
            source.source_code,
            source.title,
            source.publisher || null,
            source.source_type,
            source.geography_scope || 'turkiye',
            source.official_url || null,
            source.publication_date || null,
            source.notes || null
        ]);
        sourceIdMap.set(result.rows[0].source_code, result.rows[0].id);
    }

    const programIdMap = new Map();

    for (const program of supportPrograms) {
        const sourceId = sourceIdMap.get(program.source_code) || null;
        const result = await pool.query(`
            INSERT INTO support_programs (
                program_code, authority_name, program_name, program_type, status,
                support_scope, support_mode, currency, min_grant_rate_pct,
                max_grant_rate_pct, source_id, official_url, notes, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
            ON CONFLICT (program_code) DO UPDATE SET
                authority_name = EXCLUDED.authority_name,
                program_name = EXCLUDED.program_name,
                program_type = EXCLUDED.program_type,
                status = EXCLUDED.status,
                support_scope = EXCLUDED.support_scope,
                support_mode = EXCLUDED.support_mode,
                currency = EXCLUDED.currency,
                min_grant_rate_pct = EXCLUDED.min_grant_rate_pct,
                max_grant_rate_pct = EXCLUDED.max_grant_rate_pct,
                source_id = EXCLUDED.source_id,
                official_url = EXCLUDED.official_url,
                notes = EXCLUDED.notes,
                updated_at = NOW()
            RETURNING id, program_code
        `, [
            program.program_code,
            program.authority_name,
            program.program_name,
            program.program_type || null,
            program.status || 'announced',
            program.support_scope || null,
            program.support_mode || null,
            program.currency || 'TRY',
            program.min_grant_rate_pct ?? null,
            program.max_grant_rate_pct ?? null,
            sourceId,
            program.official_url || null,
            program.notes || null
        ]);
        programIdMap.set(result.rows[0].program_code, result.rows[0].id);
    }

    for (const windowItem of supportApplicationWindows) {
        const programId = programIdMap.get(windowItem.program_code);
        if (!programId) continue;

        await pool.query(`
            INSERT INTO support_application_windows (
                program_id, application_year, call_no, open_date, close_date,
                budget_amount, budget_currency, status, notes
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (program_id, application_year, call_no) DO UPDATE SET
                open_date = EXCLUDED.open_date,
                close_date = EXCLUDED.close_date,
                budget_amount = EXCLUDED.budget_amount,
                budget_currency = EXCLUDED.budget_currency,
                status = EXCLUDED.status,
                notes = EXCLUDED.notes
        `, [
            programId,
            windowItem.application_year,
            windowItem.call_no || null,
            windowItem.open_date || null,
            windowItem.close_date || null,
            windowItem.budget_amount ?? null,
            windowItem.budget_currency || 'EUR',
            windowItem.status || 'announced',
            windowItem.notes || null
        ]);
    }

    const ipardProgramId = programIdMap.get('IPARD_III_2025');
    if (ipardProgramId) {
        const provinceRows = await pool.query('SELECT id FROM provinces ORDER BY id');
        for (const province of provinceRows.rows) {
            await pool.query(`
                INSERT INTO support_program_coverage (
                    program_id, province_id, coverage_scope, eligible_investments,
                    target_segments, notes
                )
                SELECT $1, $2, 'province', $3::text[], $4::text[], $5
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM support_program_coverage
                    WHERE program_id = $1 AND province_id = $2 AND coverage_scope = 'province'
                )
            `, [
                ipardProgramId,
                province.id,
                ['mekanizasyon', 'tarimsal modernizasyon', 'altyapi', 'isletme yatirimi'],
                ['tarla', 'bahce', 'karma isletme'],
                'IPARD III programi kapsami il bazinda izlenmek uzere referans coverage kaydi.'
            ]);
        }
    }

    const irrigationProgramId = programIdMap.get('IPARD_III_OPEN_FIELD_IRRIGATION');
    if (irrigationProgramId) {
        await pool.query(`
            INSERT INTO support_program_coverage (
                program_id, province_id, region_name, coverage_scope, eligible_investments,
                target_segments, notes
            )
            SELECT $1, NULL, 'Turkiye', 'national', $2::text[], $3::text[], $4
            WHERE NOT EXISTS (
                SELECT 1
                FROM support_program_coverage
                WHERE program_id = $1 AND coverage_scope = 'national'
            )
        `, [
            irrigationProgramId,
            ['sulama', 'acik alan sulama', 'su verimliligi', 'altyapi'],
            ['sulu tarim', 'yuksek verim hedefi', 'su stresi bolgeleri'],
            'Sulama desteklerinin ulusal etkisini izlemek icin referans coverage kaydi.'
        ]);
    }
}

function clampMetric(value, min, max) {
    return Math.min(Math.max(Number(value || 0), min), max);
}

function addUtcMonths(dateValue, months) {
    const date = new Date(dateValue);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function toIsoDate(dateValue) {
    const date = new Date(dateValue);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function regionKey(value = '') {
    return normalizeSearchText(value);
}

async function bulkInsertRows(tableName, columns, rows, chunkSize = 400) {
    if (!rows.length) return;
    for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const values = [];
        const placeholders = chunk.map((row, rowIndex) => {
            const baseOffset = rowIndex * columns.length;
            columns.forEach(column => values.push(row[column] ?? null));
            return `(${columns.map((_, colIndex) => `$${baseOffset + colIndex + 1}`).join(',')})`;
        }).join(',');
        await pool.query(`INSERT INTO ${tableName} (${columns.join(',')}) VALUES ${placeholders}`, values);
    }
}

async function ensureReferenceMarketSignalsSeeded(options = {}) {
    const { replaceExisting = false } = options;
    const { commodityCatalog = [] } = require('./database/future-intelligence-seed');
    const { commodityYearBase, monthlySeasonality, regionClimateScenarioReference } = require('./database/future-market-reference');

    const sourceRes = await pool.query(`
        SELECT source_code, id
        FROM intelligence_sources
        WHERE source_code IN ('tuik_data_portal', 'mgm_climate_projections')
    `);
    const sourceMap = new Map(sourceRes.rows.map(row => [row.source_code, row.id]));
    const tuikSourceId = sourceMap.get('tuik_data_portal') || null;
    const mgmSourceId = sourceMap.get('mgm_climate_projections') || null;

    const commodityCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM commodity_prices WHERE market_scope = 'reference-index'`);
    const climateCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`);
    const commodityCount = parseInt(commodityCountRes.rows[0]?.count || 0, 10);
    const climateCount = parseInt(climateCountRes.rows[0]?.count || 0, 10);

    if (replaceExisting) {
        await pool.query(`DELETE FROM commodity_prices WHERE market_scope = 'reference-index'`);
        await pool.query(`DELETE FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`);
    }

    if (replaceExisting || commodityCount === 0) {
        const commodityNameMap = new Map(commodityCatalog.map(item => [item.commodity_code, item.commodity_name]));
        const rows = [];

        for (const [commodityCode, years] of Object.entries(commodityYearBase || {})) {
            const commodityName = commodityNameMap.get(commodityCode) || commodityCode;
            for (const [yearText, baseIndex] of Object.entries(years || {})) {
                const year = parseInt(yearText, 10);
                monthlySeasonality.forEach((multiplier, monthIndex) => {
                    const month = monthIndex + 1;
                    rows.push({
                        commodity_code: commodityCode,
                        commodity_name: commodityName,
                        market_scope: 'reference-index',
                        province_id: null,
                        price_date: `${year}-${String(month).padStart(2, '0')}-01`,
                        year,
                        month,
                        unit: 'index_2022_100',
                        currency: 'INDEX',
                        nominal_price: Number((Number(baseIndex) * Number(multiplier)).toFixed(2)),
                        source_id: tuikSourceId,
                        metadata_json: JSON.stringify({
                            mode: 'reference_seed',
                            note: 'Official import gelene kadar forecast motoru icin referans endeks serisi.',
                            year_base: Number(baseIndex),
                            seasonality_multiplier: Number(multiplier)
                        })
                    });
                });
            }
        }

        await bulkInsertRows('commodity_prices', [
            'commodity_code', 'commodity_name', 'market_scope', 'province_id', 'price_date', 'year', 'month',
            'unit', 'currency', 'nominal_price', 'source_id', 'metadata_json'
        ], rows, 500);
    }

    if (replaceExisting || climateCount === 0) {
        const rows = [];
        const metricLabels = {
            temp_change_c: 'Sicaklik degisimi',
            rainfall_change_pct: 'Yagis degisimi',
            drought_risk_pct: 'Kuraklik riski kaymasi'
        };

        for (const [regionName, scenarios] of Object.entries(regionClimateScenarioReference || {})) {
            for (const [scenarioCode, horizons] of Object.entries(scenarios || {})) {
                for (const [horizonText, metrics] of Object.entries(horizons || {})) {
                    const horizonYear = parseInt(horizonText, 10);
                    for (const [metricCode, changeValue] of Object.entries(metrics || {})) {
                        rows.push({
                            province_id: null,
                            region_name: regionName,
                            scenario_code: scenarioCode,
                            horizon_year: horizonYear,
                            metric_code: metricCode,
                            metric_label: metricLabels[metricCode] || metricCode,
                            change_value: changeValue,
                            change_unit: metricCode.includes('pct') ? 'pct' : 'celsius',
                            baseline_period: '2020-2024',
                            source_id: mgmSourceId,
                            notes: 'Reference scenario scaffold. Resmi MGM importu geldiginde degistirilecek.'
                        });
                    }
                }
            }
        }

        await bulkInsertRows('climate_projection_scenarios', [
            'province_id', 'region_name', 'scenario_code', 'horizon_year', 'metric_code', 'metric_label',
            'change_value', 'change_unit', 'baseline_period', 'source_id', 'notes'
        ], rows, 500);
    }
}

function adjustFeatureShareRows(featureType, rows, context = {}) {
    const baseRows = rows.map(item => ({ ...item }));
    if (!baseRows.length) return baseRows;

    const adjustments = new Map();
    if (featureType === 'drive_type') {
        if (context.supportBoost > 0 || context.climatePenalty < -0.005) {
            adjustments.set('4WD', 0.03);
            adjustments.set('2WD', -0.03);
        }
    } else if (featureType === 'cabin_type') {
        adjustments.set('kabinli', 0.04);
        adjustments.set('rollbar', -0.04);
    } else if (featureType === 'hp_range') {
        adjustments.set('90-99', 0.02);
        adjustments.set('100-109', 0.02);
        adjustments.set('110-119', 0.01);
        adjustments.set('1-39', -0.02);
        adjustments.set('40-49', -0.015);
        adjustments.set('50-54', -0.01);
    }

    if (adjustments.size === 0) return baseRows;

    baseRows.forEach(item => {
        item.demand_share_pct = clampMetric(Number(item.demand_share_pct || 0) + (adjustments.get(item.feature_value) || 0), 0.001, 0.999);
    });

    const shareTotal = baseRows.reduce((sum, item) => sum + Number(item.demand_share_pct || 0), 0) || 1;
    baseRows.forEach(item => {
        item.demand_share_pct = Number((Number(item.demand_share_pct || 0) / shareTotal).toFixed(6));
        item.demand_units = Number((Number(item.demand_units || 0)).toFixed(4));
    });
    return baseRows;
}

async function runBaselineForecast(options = {}) {
    const horizonMonths = Math.max(12, Math.min(parseInt(options.horizonMonths || 24, 10), 120));
    const scenarioCode = String(options.scenarioCode || 'base');
    const createdByUserId = Number(options.createdByUserId || 0) || null;
    const normalizedTuikBrandExpr = `
        CASE
            WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
            WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
            WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
            ELSE UPPER(tv.marka)
        END
    `;
    const normalizedTeknikBrandExpr = `
        CASE
            WHEN UPPER(tk.marka) = 'CASE IH' THEN 'CASE'
            WHEN UPPER(tk.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
            WHEN UPPER(tk.marka) = 'KIOTI' THEN 'KİOTİ'
            ELSE UPPER(tk.marka)
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
    const latestRes = await pool.query(`SELECT MAX(MAKE_DATE(tescil_yil, tescil_ay, 1)) AS latest_period FROM tuik_veri`);
    const latestPeriod = latestRes.rows[0]?.latest_period;
    if (!latestPeriod) {
        return { created: false, reason: 'sales_view bos oldugu icin forecast uretilemedi' };
    }

    await ensureReferenceMarketSignalsSeeded();

    const latestDate = new Date(latestPeriod);
    const latestYear = latestDate.getUTCFullYear();
    const forecastKey = `baseline_${scenarioCode}_${Date.now()}`;

    const seasonalityRes = await pool.query(`
        SELECT tv.tescil_ay AS month, SUM(tv.satis_adet)::decimal AS total_units
        FROM tuik_veri tv
        WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
        GROUP BY tv.tescil_ay
        ORDER BY month
    `, [toIsoDate(latestDate)]);
    const seasonalityMap = new Map();
    const seasonalityValues = seasonalityRes.rows.map(row => Number(row.total_units || 0));
    const seasonalityAvg = seasonalityValues.reduce((sum, item) => sum + item, 0) / Math.max(seasonalityValues.length, 1);
    seasonalityRes.rows.forEach(row => {
        seasonalityMap.set(Number(row.month), seasonalityAvg > 0 ? Number(row.total_units || 0) / seasonalityAvg : 1);
    });

    const comboRes = await pool.query(`
        WITH monthly AS (
            SELECT
                p.id AS province_id,
                b.id AS brand_id,
                MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) AS period_date,
                SUM(tv.satis_adet)::decimal AS total_units
            FROM tuik_veri tv
            JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
            JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            WHERE tv.tescil_yil IS NOT NULL
              AND tv.tescil_ay IS NOT NULL
              AND MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
            GROUP BY p.id, b.id, MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1)
        )
        SELECT
            province_id,
            brand_id,
            SUM(CASE WHEN period_date >= (DATE_TRUNC('month', $1::date) - INTERVAL '11 months') THEN total_units ELSE 0 END) AS last12_units,
            SUM(CASE WHEN period_date BETWEEN (DATE_TRUNC('month', $1::date) - INTERVAL '23 months') AND (DATE_TRUNC('month', $1::date) - INTERVAL '12 months') THEN total_units ELSE 0 END) AS prev12_units,
            AVG(CASE WHEN period_date >= (DATE_TRUNC('month', $1::date) - INTERVAL '5 months') THEN total_units END) AS last6_avg_units,
            COUNT(*)::int AS observed_months
        FROM monthly
        GROUP BY province_id, brand_id
        HAVING SUM(total_units) >= 12
    `, [toIsoDate(latestDate)]);

    const provinceMetaRes = await pool.query(`
        SELECT
            p.id,
            p.name,
            p.region,
            EXISTS (
                SELECT 1
                FROM support_program_coverage spc
                JOIN support_programs sp ON sp.id = spc.program_id
                WHERE spc.province_id = p.id
                  AND sp.status IN ('announced', 'active')
            ) AS has_support
        FROM provinces p
    `);
    const provinceMetaMap = new Map(provinceMetaRes.rows.map(row => [Number(row.id), row]));

    const climateRes = await pool.query(`
        SELECT
            region_name,
            scenario_code,
            horizon_year,
            MAX(CASE WHEN metric_code = 'temp_change_c' THEN change_value END) AS temp_change_c,
            MAX(CASE WHEN metric_code = 'rainfall_change_pct' THEN change_value END) AS rainfall_change_pct,
            MAX(CASE WHEN metric_code = 'drought_risk_pct' THEN change_value END) AS drought_risk_pct
        FROM climate_projection_scenarios
        WHERE scenario_code IN ('reference_base', 'reference_stress')
          AND horizon_year = 2030
        GROUP BY region_name, scenario_code, horizon_year
    `);
    const climateMap = new Map(climateRes.rows.map(row => [`${regionKey(row.region_name)}:${row.scenario_code}`, row]));

    const commoditySignalRes = await pool.query(`
        SELECT AVG(growth_ratio)::decimal AS avg_growth_ratio
        FROM (
            SELECT
                curr.commodity_code,
                AVG((curr.nominal_price - prev.nominal_price) / NULLIF(prev.nominal_price, 0)) AS growth_ratio
            FROM commodity_prices curr
            JOIN commodity_prices prev
              ON prev.commodity_code = curr.commodity_code
             AND prev.market_scope = curr.market_scope
             AND COALESCE(prev.province_id, 0) = COALESCE(curr.province_id, 0)
             AND prev.month = curr.month
             AND prev.year = curr.year - 1
            WHERE curr.market_scope = 'reference-index'
              AND curr.year = $1
            GROUP BY curr.commodity_code
        ) s
    `, [latestYear]);
    const commoditySignal = Number(commoditySignalRes.rows[0]?.avg_growth_ratio || 0);

    const runInsertRes = await pool.query(`
        INSERT INTO forecast_runs (
            forecast_key, model_family, scope_level, target_entity_type, target_entity_id,
            scenario_code, forecast_horizon_months, training_start_year, training_end_year,
            run_status, metrics_json, feature_snapshot_json, notes, created_by_user_id
        )
        VALUES ($1, 'baseline_momentum_v1', 'province_brand', 'market', NULL, $2, $3, $4, $5, 'running', '{}'::jsonb, '{}'::jsonb, $6, $7)
        RETURNING id
    `, [
        forecastKey,
        scenarioCode,
        horizonMonths,
        Math.max(2022, latestYear - 2),
        latestYear,
        'Sales momentum + support + climate + commodity reference signal ile uretilen ilk baz forecast kosusu.',
        createdByUserId
    ]);
    const forecastRunId = runInsertRes.rows[0].id;

    const featureStoreRows = [];
    const forecastOutputRows = [];
    const baselineAnnualUnitsMap = new Map();

    comboRes.rows.forEach(row => {
        const provinceId = Number(row.province_id);
        const brandId = Number(row.brand_id);
        const provinceMeta = provinceMetaMap.get(provinceId) || {};
        const normalizedRegion = regionKey(provinceMeta.region || '');
        const climateBase = climateMap.get(`${normalizedRegion}:reference_base`) || {};
        const climateStress = climateMap.get(`${normalizedRegion}:reference_stress`) || climateBase;
        const last12Units = Number(row.last12_units || 0);
        const prev12Units = Number(row.prev12_units || 0);
        const last6Avg = Number(row.last6_avg_units || 0);
        const yoyGrowth = prev12Units > 0 ? (last12Units - prev12Units) / prev12Units : 0.04;
        const supportBoost = provinceMeta.has_support ? 0.02 : 0;
        const climatePenaltyBase = (Number(climateBase.rainfall_change_pct || 0) < -4 ? -0.012 : -0.004) + (Number(climateBase.temp_change_c || 0) > 1.1 ? -0.008 : 0);
        const climatePenaltyStress = (Number(climateStress.rainfall_change_pct || 0) < -5 ? -0.018 : -0.006) + (Number(climateStress.temp_change_c || 0) > 1.25 ? -0.012 : 0);
        const climatePenalty = scenarioCode === 'stress' ? climatePenaltyStress : climatePenaltyBase;
        const commodityBoost = clampMetric(commoditySignal * 0.20, -0.02, 0.04);
        const yoyFactor = clampMetric(yoyGrowth * 0.35, -0.16, 0.22);
        const annualDrift = 1 + yoyFactor + supportBoost + commodityBoost + climatePenalty;
        const baselineMonthlyUnits = Math.max(last12Units / 12, last6Avg, 1);
        const uncertainty = clampMetric(0.18 + Math.abs(yoyGrowth) * 0.25, 0.12, 0.35);

        baselineAnnualUnitsMap.set(`${provinceId}:${brandId}`, Number((baselineMonthlyUnits * 12).toFixed(4)));

        featureStoreRows.push(
            {
                forecast_key: forecastKey,
                snapshot_date: toIsoDate(latestDate),
                province_id: provinceId,
                brand_id: brandId,
                commodity_code: null,
                feature_code: 'recent_12m_units',
                feature_value: last12Units,
                feature_unit: 'units',
                feature_source: 'sales_view',
                source_id: null,
                metadata_json: JSON.stringify({ mode: 'observed' })
            },
            {
                forecast_key: forecastKey,
                snapshot_date: toIsoDate(latestDate),
                province_id: provinceId,
                brand_id: brandId,
                commodity_code: null,
                feature_code: 'yoy_growth_ratio',
                feature_value: Number(yoyGrowth.toFixed(4)),
                feature_unit: 'ratio',
                feature_source: 'sales_view',
                source_id: null,
                metadata_json: JSON.stringify({ mode: 'observed' })
            },
            {
                forecast_key: forecastKey,
                snapshot_date: toIsoDate(latestDate),
                province_id: provinceId,
                brand_id: brandId,
                commodity_code: null,
                feature_code: 'support_boost',
                feature_value: Number(supportBoost.toFixed(4)),
                feature_unit: 'ratio',
                feature_source: 'support_program_coverage',
                source_id: null,
                metadata_json: JSON.stringify({ has_support: Boolean(provinceMeta.has_support) })
            },
            {
                forecast_key: forecastKey,
                snapshot_date: toIsoDate(latestDate),
                province_id: provinceId,
                brand_id: brandId,
                commodity_code: 'AGRI_BASKET',
                feature_code: 'commodity_signal_ratio',
                feature_value: Number(commodityBoost.toFixed(4)),
                feature_unit: 'ratio',
                feature_source: 'commodity_prices',
                source_id: null,
                metadata_json: JSON.stringify({ reference_mode: true })
            },
            {
                forecast_key: forecastKey,
                snapshot_date: toIsoDate(latestDate),
                province_id: provinceId,
                brand_id: brandId,
                commodity_code: null,
                feature_code: 'climate_penalty',
                feature_value: Number(climatePenalty.toFixed(4)),
                feature_unit: 'ratio',
                feature_source: 'climate_projection_scenarios',
                source_id: null,
                metadata_json: JSON.stringify({ region: provinceMeta.region || null, scenario_code: scenarioCode })
            }
        );

        for (let offset = 1; offset <= horizonMonths; offset++) {
            const targetDate = addUtcMonths(latestDate, offset);
            const month = targetDate.getUTCMonth() + 1;
            const seasonality = seasonalityMap.get(month) || 1;
            const growthCurve = Math.pow(Math.max(0.90, annualDrift), offset / 12);
            const predictedUnits = Math.max(0.5, baselineMonthlyUnits * seasonality * growthCurve);
            const summaryParts = [
                `yoy ${Number((yoyGrowth * 100).toFixed(1))}%`,
                provinceMeta.has_support ? 'destek etkisi +' : 'destek etkisi 0',
                `iklim ${Number((climatePenalty * 100).toFixed(1))}%`,
                `emtia ${Number((commodityBoost * 100).toFixed(1))}%`
            ];

            forecastOutputRows.push({
                forecast_run_id: forecastRunId,
                period_year: targetDate.getUTCFullYear(),
                period_month: month,
                province_id: provinceId,
                brand_id: brandId,
                hp_range: null,
                drive_type: null,
                cabin_type: null,
                category: null,
                predicted_units: Number(predictedUnits.toFixed(4)),
                confidence_low: Number((predictedUnits * (1 - uncertainty)).toFixed(4)),
                confidence_high: Number((predictedUnits * (1 + uncertainty)).toFixed(4)),
                baseline_units: Number(baselineMonthlyUnits.toFixed(4)),
                signal_summary: summaryParts.join(' | ')
            });
        }
    });

    const featureMixRes = await pool.query(`
        WITH base AS (
            SELECT
                p.id AS province_id,
                b.id AS brand_id,
                ${hpRangeExpr}::text AS feature_value,
                'hp_range'::text AS feature_type,
                SUM(tv.satis_adet)::decimal AS units
            FROM tuik_veri tv
            JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
            JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            LEFT JOIN teknik_veri tk
              ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
             AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
            WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
              AND ${hpRangeExpr} IS NOT NULL
            GROUP BY p.id, b.id, ${hpRangeExpr}
            UNION ALL
            SELECT
                p.id,
                b.id,
                COALESCE(NULLIF(tk.cekis_tipi, ''), '4WD')::text,
                'drive_type'::text,
                SUM(tv.satis_adet)::decimal
            FROM tuik_veri tv
            JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
            JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            LEFT JOIN teknik_veri tk
              ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
             AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
            WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
            GROUP BY p.id, b.id, COALESCE(NULLIF(tk.cekis_tipi, ''), '4WD')
            UNION ALL
            SELECT
                p.id,
                b.id,
                CASE WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli' ELSE 'rollbar' END::text,
                'cabin_type'::text,
                SUM(tv.satis_adet)::decimal
            FROM tuik_veri tv
            JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
            JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            LEFT JOIN teknik_veri tk
              ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
             AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
            WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
            GROUP BY p.id, b.id, CASE WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli' ELSE 'rollbar' END
            UNION ALL
            SELECT
                p.id,
                b.id,
                CASE WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah%' THEN 'bahce' ELSE 'tarla' END::text,
                'category'::text,
                SUM(tv.satis_adet)::decimal
            FROM tuik_veri tv
            JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
            JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
            LEFT JOIN teknik_veri tk
              ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
             AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
            WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
            GROUP BY p.id, b.id, CASE WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah%' THEN 'bahce' ELSE 'tarla' END
        )
        SELECT * FROM base
    `, [toIsoDate(latestDate)]);

    const groupedFeatureMix = new Map();
    featureMixRes.rows.forEach(row => {
        const key = `${row.province_id}:${row.brand_id}:${row.feature_type}`;
        if (!groupedFeatureMix.has(key)) groupedFeatureMix.set(key, []);
        groupedFeatureMix.get(key).push({
            province_id: Number(row.province_id),
            brand_id: Number(row.brand_id),
            feature_type: row.feature_type,
            feature_value: String(row.feature_value || 'bilinmiyor'),
            units: Number(row.units || 0)
        });
    });

    const modelFeatureDemandRows = [];
    for (const items of groupedFeatureMix.values()) {
        const provinceId = items[0].province_id;
        const brandId = items[0].brand_id;
        const provinceMeta = provinceMetaMap.get(provinceId) || {};
        const normalizedRegion = regionKey(provinceMeta.region || '');
        const climateBase = climateMap.get(`${normalizedRegion}:reference_base`) || {};
        const totalUnits = items.reduce((sum, item) => sum + Number(item.units || 0), 0) || 1;
        const baseRows = items.map(item => ({
            province_id: provinceId,
            brand_id: brandId,
            feature_type: item.feature_type,
            feature_value: item.feature_value,
            demand_share_pct: Number((Number(item.units || 0) / totalUnits).toFixed(6)),
            demand_units: Number(item.units || 0)
        }));

        const context = {
            supportBoost: provinceMeta.has_support ? 0.02 : 0,
            climatePenalty: (Number(climateBase.rainfall_change_pct || 0) < -4 ? -0.012 : -0.004) + (Number(climateBase.temp_change_c || 0) > 1.1 ? -0.008 : 0)
        };

        const nextYearRows = adjustFeatureShareRows(items[0].feature_type, baseRows, context);
        const longTermRows = adjustFeatureShareRows(items[0].feature_type, nextYearRows, context);

        nextYearRows.forEach(item => modelFeatureDemandRows.push({
            forecast_run_id: forecastRunId,
            province_id: item.province_id,
            brand_id: item.brand_id,
            horizon_year: latestYear + 1,
            feature_type: item.feature_type,
            feature_value: item.feature_value,
            demand_share_pct: item.demand_share_pct,
            demand_units: Number(((baselineAnnualUnitsMap.get(`${item.province_id}:${item.brand_id}`) || 0) * item.demand_share_pct).toFixed(4)),
            evidence_json: JSON.stringify({ mode: 'baseline_share', reference_shift: false })
        }));

        longTermRows.forEach(item => modelFeatureDemandRows.push({
            forecast_run_id: forecastRunId,
            province_id: item.province_id,
            brand_id: item.brand_id,
            horizon_year: latestYear + 10,
            feature_type: item.feature_type,
            feature_value: item.feature_value,
            demand_share_pct: item.demand_share_pct,
            demand_units: Number((((forecastOutputRows.find(output => output.province_id === item.province_id && output.brand_id === item.brand_id)?.baseline_units || 0) * 12) * item.demand_share_pct).toFixed(4)),
            evidence_json: JSON.stringify({ mode: 'baseline_share', reference_shift: true })
        }));
    }

    await bulkInsertRows('forecast_feature_store', [
        'forecast_key', 'snapshot_date', 'province_id', 'brand_id', 'commodity_code',
        'feature_code', 'feature_value', 'feature_unit', 'feature_source', 'source_id', 'metadata_json'
    ], featureStoreRows, 500);

    await bulkInsertRows('forecast_outputs', [
        'forecast_run_id', 'period_year', 'period_month', 'province_id', 'brand_id', 'hp_range',
        'drive_type', 'cabin_type', 'category', 'predicted_units', 'confidence_low', 'confidence_high',
        'baseline_units', 'signal_summary'
    ], forecastOutputRows, 500);

    await bulkInsertRows('model_feature_demand', [
        'forecast_run_id', 'province_id', 'brand_id', 'horizon_year', 'feature_type', 'feature_value',
        'demand_share_pct', 'demand_units', 'evidence_json'
    ], modelFeatureDemandRows, 500);

    const totalPredicted = forecastOutputRows.reduce((sum, row) => sum + Number(row.predicted_units || 0), 0);
    await pool.query(`
        UPDATE forecast_runs
        SET
            run_status = 'completed',
            metrics_json = $2::jsonb,
            feature_snapshot_json = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
    `, [
        forecastRunId,
        JSON.stringify({
            output_row_count: forecastOutputRows.length,
            feature_row_count: featureStoreRows.length,
            feature_demand_row_count: modelFeatureDemandRows.length,
            total_predicted_units: Number(totalPredicted.toFixed(2))
        }),
        JSON.stringify({
            latest_period: toIsoDate(latestDate),
            commodity_signal_ratio: Number(commoditySignal.toFixed(4)),
            scenario_code: scenarioCode,
            reference_mode: true
        })
    ]);

    return {
        created: true,
        forecast_run_id: forecastRunId,
        forecast_key: forecastKey,
        latest_period: toIsoDate(latestDate),
        output_row_count: forecastOutputRows.length,
        feature_row_count: featureStoreRows.length,
        feature_demand_row_count: modelFeatureDemandRows.length,
        total_predicted_units: Number(totalPredicted.toFixed(2))
    };
}

async function getForecastExecutiveView(options = {}) {
    const requestedRunId = options.forecastRunId ? parseInt(options.forecastRunId, 10) : null;
    const requestedProvinceId = options.provinceId ? parseInt(options.provinceId, 10) : null;
    const requestedBrandId = options.brandId ? parseInt(options.brandId, 10) : null;
    const featureTypeLabels = {
        hp_range: 'HP koridoru',
        drive_type: 'Cekis mimarisi',
        cabin_type: 'Kabin yapisi',
        category: 'Kullanim alanı'
    };

    const runRes = requestedRunId
        ? await pool.query(`
            SELECT *
            FROM forecast_runs
            WHERE id = $1
            LIMIT 1
        `, [requestedRunId])
        : await pool.query(`
            SELECT *
            FROM forecast_runs
            WHERE run_status = 'completed'
            ORDER BY created_at DESC
            LIMIT 1
        `);

    const run = runRes.rows[0];
    if (!run) {
        return {
            run: null,
            overview: null,
            monthly_curve: [],
            top_provinces: [],
            feature_outlook: [],
            feature_shift: []
        };
    }

    const snapshot = run.feature_snapshot_json || {};
    const latestPeriodIso = snapshot.latest_period || toIsoDate(run.created_at);
    const next12EndIso = toIsoDate(addUtcMonths(latestPeriodIso, 12));

    const summaryParams = [run.id, next12EndIso];
    let outputFilterSql = '';
    if (requestedProvinceId) {
        summaryParams.push(requestedProvinceId);
        outputFilterSql += ` AND fo.province_id = $${summaryParams.length}`;
    }
    if (requestedBrandId) {
        summaryParams.push(requestedBrandId);
        outputFilterSql += ` AND fo.brand_id = $${summaryParams.length}`;
    }

    const monthlyParams = [run.id];
    let monthlyFilterSql = '';
    if (requestedProvinceId) {
        monthlyParams.push(requestedProvinceId);
        monthlyFilterSql += ` AND fo.province_id = $${monthlyParams.length}`;
    }
    if (requestedBrandId) {
        monthlyParams.push(requestedBrandId);
        monthlyFilterSql += ` AND fo.brand_id = $${monthlyParams.length}`;
    }

    const provinceParams = [run.id, next12EndIso, run.forecast_key];
    let provinceOutputFilterSql = '';
    let provinceFeatureFilterSql = '';
    if (requestedProvinceId) {
        provinceParams.push(requestedProvinceId);
        provinceOutputFilterSql += ` AND fo.province_id = $${provinceParams.length}`;
        provinceFeatureFilterSql += ` AND fs.province_id = $${provinceParams.length}`;
    }
    if (requestedBrandId) {
        provinceParams.push(requestedBrandId);
        provinceOutputFilterSql += ` AND fo.brand_id = $${provinceParams.length}`;
        provinceFeatureFilterSql += ` AND fs.brand_id = $${provinceParams.length}`;
    }

    const featureParams = [run.id];
    let featureFilterSql = '';
    if (requestedProvinceId) {
        featureParams.push(requestedProvinceId);
        featureFilterSql += ` AND mfd.province_id = $${featureParams.length}`;
    }
    if (requestedBrandId) {
        featureParams.push(requestedBrandId);
        featureFilterSql += ` AND mfd.brand_id = $${featureParams.length}`;
    }

    const [summaryRes, monthlyCurveRes, provinceRes, featureDemandRes] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*)::int AS row_count,
                COUNT(DISTINCT fo.province_id)::int AS province_count,
                COUNT(DISTINCT fo.brand_id)::int AS brand_count,
                SUM(fo.predicted_units)::decimal AS total_horizon_units,
                SUM(CASE
                    WHEN MAKE_DATE(fo.period_year, fo.period_month, 1) <= $2::date THEN fo.predicted_units
                    ELSE 0
                END)::decimal AS next_12m_units,
                AVG(fo.predicted_units)::decimal AS avg_monthly_units
            FROM forecast_outputs fo
            WHERE fo.forecast_run_id = $1
            ${outputFilterSql}
        `, summaryParams),
        pool.query(`
            SELECT
                fo.period_year,
                fo.period_month,
                SUM(fo.predicted_units)::decimal AS predicted_units_total,
                SUM(fo.confidence_low)::decimal AS confidence_low_total,
                SUM(fo.confidence_high)::decimal AS confidence_high_total
            FROM forecast_outputs fo
            WHERE fo.forecast_run_id = $1
            ${monthlyFilterSql}
            GROUP BY fo.period_year, fo.period_month
            ORDER BY fo.period_year, fo.period_month
            LIMIT 24
        `, monthlyParams),
        pool.query(`
            WITH province_forecast AS (
                SELECT
                    fo.province_id,
                    p.name AS province_name,
                    p.region AS region_name,
                    EXISTS (
                        SELECT 1
                        FROM support_program_coverage spc
                        JOIN support_programs sp ON sp.id = spc.program_id
                        WHERE spc.province_id = fo.province_id
                          AND sp.status IN ('announced', 'active')
                    ) AS has_support,
                    SUM(CASE
                        WHEN MAKE_DATE(fo.period_year, fo.period_month, 1) <= $2::date THEN fo.predicted_units
                        ELSE 0
                    END)::decimal AS next_12m_units,
                    SUM(fo.predicted_units)::decimal AS total_horizon_units,
                    AVG(fo.predicted_units)::decimal AS avg_monthly_units
                FROM forecast_outputs fo
                LEFT JOIN provinces p ON p.id = fo.province_id
                WHERE fo.forecast_run_id = $1
                ${provinceOutputFilterSql}
                GROUP BY fo.province_id, p.name, p.region
            ),
            province_observed AS (
                SELECT
                    fs.province_id,
                    SUM(fs.feature_value)::decimal AS recent_12m_units
                FROM forecast_feature_store fs
                WHERE fs.forecast_key = $3
                  AND fs.feature_code = 'recent_12m_units'
                ${provinceFeatureFilterSql}
                GROUP BY fs.province_id
            )
            SELECT
                pf.province_id,
                pf.province_name,
                pf.region_name,
                pf.has_support,
                pf.next_12m_units,
                pf.total_horizon_units,
                pf.avg_monthly_units,
                po.recent_12m_units,
                CASE
                    WHEN COALESCE(po.recent_12m_units, 0) > 0
                        THEN ((pf.next_12m_units - po.recent_12m_units) / po.recent_12m_units) * 100
                    ELSE NULL
                END AS growth_pct
            FROM province_forecast pf
            LEFT JOIN province_observed po ON po.province_id = pf.province_id
            ORDER BY pf.next_12m_units DESC
        `, provinceParams),
        pool.query(`
            WITH raw AS (
                SELECT
                    mfd.horizon_year,
                    mfd.feature_type,
                    mfd.feature_value,
                    SUM(mfd.demand_units)::decimal AS demand_units_total
                FROM model_feature_demand mfd
                WHERE mfd.forecast_run_id = $1
                ${featureFilterSql}
                GROUP BY mfd.horizon_year, mfd.feature_type, mfd.feature_value
            ),
            totals AS (
                SELECT
                    horizon_year,
                    feature_type,
                    SUM(demand_units_total)::decimal AS type_total_units
                FROM raw
                GROUP BY horizon_year, feature_type
            )
            SELECT
                raw.horizon_year,
                raw.feature_type,
                raw.feature_value,
                raw.demand_units_total,
                CASE
                    WHEN COALESCE(totals.type_total_units, 0) > 0
                        THEN (raw.demand_units_total / totals.type_total_units) * 100
                    ELSE 0
                END AS demand_share_pct
            FROM raw
            JOIN totals
              ON totals.horizon_year = raw.horizon_year
             AND totals.feature_type = raw.feature_type
            ORDER BY raw.horizon_year, raw.feature_type, raw.demand_units_total DESC
        `, featureParams)
    ]);

    const monthlyCurve = monthlyCurveRes.rows.map(row => ({
        period_year: Number(row.period_year),
        period_month: Number(row.period_month),
        predicted_units_total: Number(row.predicted_units_total || 0),
        confidence_low_total: Number(row.confidence_low_total || 0),
        confidence_high_total: Number(row.confidence_high_total || 0)
    }));

    const topProvinceRows = provinceRes.rows.map(row => ({
        province_id: Number(row.province_id),
        province_name: row.province_name,
        region_name: row.region_name,
        has_support: Boolean(row.has_support),
        next_12m_units: Number(row.next_12m_units || 0),
        total_horizon_units: Number(row.total_horizon_units || 0),
        avg_monthly_units: Number(row.avg_monthly_units || 0),
        recent_12m_units: Number(row.recent_12m_units || 0),
        growth_pct: row.growth_pct == null ? null : Number(row.growth_pct)
    }));

    const featureOutlookRows = featureDemandRes.rows.map(row => ({
        horizon_year: Number(row.horizon_year),
        feature_type: row.feature_type,
        feature_label: featureTypeLabels[row.feature_type] || row.feature_type,
        feature_value: row.feature_value,
        demand_units_total: Number(row.demand_units_total || 0),
        demand_share_pct: Number(row.demand_share_pct || 0)
    }));

    const horizonYears = Array.from(new Set(featureOutlookRows.map(row => row.horizon_year))).sort((a, b) => a - b);
    const nextYear = horizonYears[0] || null;
    const longTermYear = horizonYears[horizonYears.length - 1] || null;

    const featureShift = Object.keys(featureTypeLabels).map(featureType => {
        const nextRows = featureOutlookRows.filter(row => row.feature_type === featureType && row.horizon_year === nextYear);
        const longRows = featureOutlookRows.filter(row => row.feature_type === featureType && row.horizon_year === longTermYear);
        const dominantNext = nextRows[0] || null;
        const dominantLong = longRows[0] || null;
        const valueUniverse = Array.from(new Set([
            ...nextRows.map(row => row.feature_value),
            ...longRows.map(row => row.feature_value)
        ]));

        const strongestGainer = valueUniverse.map(featureValue => {
            const nextItem = nextRows.find(row => row.feature_value === featureValue);
            const longItem = longRows.find(row => row.feature_value === featureValue);
            const nextShare = Number(nextItem?.demand_share_pct || 0);
            const longShare = Number(longItem?.demand_share_pct || 0);
            return {
                feature_value: featureValue,
                next_year_share_pct: nextShare,
                long_term_share_pct: longShare,
                delta_share_pct: Number((longShare - nextShare).toFixed(2))
            };
        }).sort((a, b) => b.delta_share_pct - a.delta_share_pct)[0] || null;

        return {
            feature_type: featureType,
            feature_label: featureTypeLabels[featureType],
            dominant_next_year: dominantNext,
            dominant_long_term: dominantLong,
            strongest_gainer: strongestGainer
        };
    }).filter(item => item.dominant_next_year || item.dominant_long_term);

    const overviewRow = summaryRes.rows[0] || {};
    const supportDrivenUnits = topProvinceRows
        .filter(row => row.has_support)
        .reduce((sum, row) => sum + Number(row.next_12m_units || 0), 0);

    return {
        run,
        overview: {
            row_count: Number(overviewRow.row_count || 0),
            province_count: Number(overviewRow.province_count || 0),
            brand_count: Number(overviewRow.brand_count || 0),
            next_12m_units: Number(overviewRow.next_12m_units || 0),
            total_horizon_units: Number(overviewRow.total_horizon_units || 0),
            avg_monthly_units: Number(overviewRow.avg_monthly_units || 0),
            latest_period: latestPeriodIso,
            next_12m_end: next12EndIso,
            scenario_code: run.scenario_code,
            forecast_horizon_months: Number(run.forecast_horizon_months || 0),
            model_family: run.model_family,
            reference_mode: Boolean(snapshot.reference_mode),
            commodity_signal_ratio: Number(snapshot.commodity_signal_ratio || 0),
            support_driven_units: Number(supportDrivenUnits.toFixed(2)),
            support_driven_share_pct: Number(overviewRow.next_12m_units || 0) > 0
                ? Number(((supportDrivenUnits / Number(overviewRow.next_12m_units || 0)) * 100).toFixed(2))
                : 0
        },
        monthly_curve: monthlyCurve,
        top_provinces: topProvinceRows.slice(0, 10),
        feature_outlook: featureOutlookRows,
        feature_shift: featureShift
    };
}

app.get('/api/meta/future-intelligence-readiness', authMiddleware, async (req, res) => {
    try {
        const layerDefinitions = [
            { key: 'intelligence_sources', label: 'Resmi kaynak katalogu', table: 'intelligence_sources', seeded: true },
            { key: 'support_programs', label: 'Destek programlari', table: 'support_programs', seeded: true },
            { key: 'support_application_windows', label: 'Cagri pencereleri', table: 'support_application_windows', seeded: true },
            { key: 'support_program_coverage', label: 'Destek kapsama katmani', table: 'support_program_coverage', seeded: true },
            { key: 'weather_data', label: 'Hava veri serisi', table: 'weather_data', seeded: false },
            { key: 'climate_analysis', label: 'Iklim gecmis serisi', table: 'climate_analysis', seeded: false },
            { key: 'soil_data', label: 'Toprak veri katmani', table: 'soil_data', seeded: false },
            { key: 'crop_data', label: 'Urun deseni katmani', table: 'crop_data', seeded: false },
            { key: 'commodity_prices', label: 'Emtia fiyat serisi', table: 'commodity_prices', seeded: false },
            { key: 'climate_projection_scenarios', label: 'Iklim projeksiyon senaryolari', table: 'climate_projection_scenarios', seeded: false },
            { key: 'province_risk_signals', label: 'Il risk sinyalleri', table: 'province_risk_signals', seeded: false },
            { key: 'forecast_runs', label: 'Forecast kosulari', table: 'forecast_runs', seeded: false },
            { key: 'forecast_feature_store', label: 'Forecast feature store', table: 'forecast_feature_store', seeded: false },
            { key: 'forecast_outputs', label: 'Forecast ciktilari', table: 'forecast_outputs', seeded: false },
            { key: 'model_feature_demand', label: 'Ozellik talep modeli ciktilari', table: 'model_feature_demand', seeded: false }
        ];

        const counts = await Promise.all(layerDefinitions.map(async layer => {
            const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${layer.table}`);
            return {
                ...layer,
                row_count: parseInt(result.rows[0]?.count || 0, 10)
            };
        }));

        const latestForecastRun = await pool.query(`
            SELECT forecast_key, model_family, scope_level, scenario_code, run_status, created_at
            FROM forecast_runs
            ORDER BY created_at DESC
            LIMIT 1
        `);

        const layers = counts.map(layer => ({
            key: layer.key,
            label: layer.label,
            row_count: layer.row_count,
            status: layer.row_count > 0 ? (layer.seeded ? 'seeded' : 'ready') : 'empty',
            note: layer.row_count > 0
                ? (layer.seeded ? 'Cekirdek metadata ya da coverage tabakasi hazir.' : 'Gercek veri ile tahmin motorunu beslemeye hazir.')
                : 'Bu katman henuz import veya model kosusu bekliyor.'
        }));

        res.json({
            generated_at: new Date().toISOString(),
            summary: {
                total_layers: layers.length,
                non_empty_layers: layers.filter(item => item.row_count > 0).length,
                empty_layers: layers.filter(item => item.row_count === 0).length,
                ready_layers: layers.filter(item => item.status === 'ready').length,
                seeded_layers: layers.filter(item => item.status === 'seeded').length
            },
            latest_forecast_run: latestForecastRun.rows[0] || null,
            layers
        });
    } catch (err) {
        res.status(500).json({ error: 'Future intelligence readiness okunamadi', detail: err.message });
    }
});

app.get('/api/meta/future-intelligence-catalog', authMiddleware, async (req, res) => {
    try {
        const { commodityCatalog = [] } = require('./database/future-intelligence-seed');

        const [sourcesRes, programsRes] = await Promise.all([
            pool.query(`
                SELECT
                    id, source_code, title, publisher, source_type, geography_scope,
                    official_url, publication_date, notes
                FROM intelligence_sources
                WHERE is_active = true
                ORDER BY
                    CASE source_type
                        WHEN 'support' THEN 1
                        WHEN 'statistics' THEN 2
                        WHEN 'census' THEN 3
                        WHEN 'climate' THEN 4
                        WHEN 'strategy' THEN 5
                        ELSE 6
                    END,
                    title
            `),
            pool.query(`
                SELECT
                    sp.id,
                    sp.program_code,
                    sp.authority_name,
                    sp.program_name,
                    sp.program_type,
                    sp.status,
                    sp.support_scope,
                    sp.support_mode,
                    sp.currency,
                    sp.min_grant_rate_pct,
                    sp.max_grant_rate_pct,
                    sp.official_url,
                    sp.notes,
                    src.title AS source_title,
                    COALESCE(cov.coverage_count, 0) AS coverage_count,
                    COALESCE(win.window_count, 0) AS window_count
                FROM support_programs sp
                LEFT JOIN intelligence_sources src ON sp.source_id = src.id
                LEFT JOIN (
                    SELECT program_id, COUNT(*)::int AS coverage_count
                    FROM support_program_coverage
                    GROUP BY program_id
                ) cov ON cov.program_id = sp.id
                LEFT JOIN (
                    SELECT program_id, COUNT(*)::int AS window_count
                    FROM support_application_windows
                    GROUP BY program_id
                ) win ON win.program_id = sp.id
                ORDER BY sp.program_name
            `)
        ]);

        res.json({
            generated_at: new Date().toISOString(),
            sources: sourcesRes.rows,
            support_programs: programsRes.rows,
            tracked_commodities: commodityCatalog
        });
    } catch (err) {
        res.status(500).json({ error: 'Future intelligence catalog okunamadi', detail: err.message });
    }
});

app.post('/api/admin/future-intelligence/seed-reference-data', authMiddleware, adminOnly, async (req, res) => {
    try {
        await ensureReferenceMarketSignalsSeeded({ replaceExisting: Boolean(req.body?.replace_existing) });
        const [commodityCount, climateCount] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS count FROM commodity_prices WHERE market_scope = 'reference-index'`),
            pool.query(`SELECT COUNT(*)::int AS count FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`)
        ]);

        res.json({
            ok: true,
            commodity_reference_rows: parseInt(commodityCount.rows[0]?.count || 0, 10),
            climate_reference_rows: parseInt(climateCount.rows[0]?.count || 0, 10)
        });
    } catch (err) {
        res.status(500).json({ error: 'Reference market data seed edilemedi', detail: err.message });
    }
});

app.post('/api/admin/forecast/run-baseline', authMiddleware, adminOnly, async (req, res) => {
    try {
        const result = await runBaselineForecast({
            horizonMonths: req.body?.horizon_months || 24,
            scenarioCode: req.body?.scenario_code || 'base',
            createdByUserId: req.user.id
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Baseline forecast kosulamadi', detail: err.message });
    }
});

app.get('/api/forecast/runs', authMiddleware, requireFeature('ai_forecast'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                forecast_key,
                model_family,
                scope_level,
                scenario_code,
                forecast_horizon_months,
                run_status,
                metrics_json,
                feature_snapshot_json,
                created_at
            FROM forecast_runs
            ORDER BY created_at DESC
            LIMIT 20
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Forecast run listesi okunamadi', detail: err.message });
    }
});

app.get('/api/forecast/latest', authMiddleware, requireFeature('ai_forecast'), async (req, res) => {
    try {
        const requestedRunId = req.query.forecast_run_id ? parseInt(req.query.forecast_run_id, 10) : null;
        const requestedProvinceId = req.query.province_id ? parseInt(req.query.province_id, 10) : null;
        const requestedBrandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;

        const runRes = requestedRunId
            ? await pool.query(`
                SELECT *
                FROM forecast_runs
                WHERE id = $1
                LIMIT 1
            `, [requestedRunId])
            : await pool.query(`
                SELECT *
                FROM forecast_runs
                WHERE run_status = 'completed'
                ORDER BY created_at DESC
                LIMIT 1
            `);

        const run = runRes.rows[0];
        if (!run) {
            return res.json({ run: null, summary: null, outputs: [], feature_demand: [] });
        }

        const params = [run.id];
        let filterSql = '';
        if (requestedProvinceId) {
            params.push(requestedProvinceId);
            filterSql += ` AND fo.province_id = $${params.length}`;
        }
        if (requestedBrandId) {
            params.push(requestedBrandId);
            filterSql += ` AND fo.brand_id = $${params.length}`;
        }

        const [summaryRes, outputsRes, featureDemandRes] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(*)::int AS row_count,
                    SUM(predicted_units)::decimal AS predicted_units_total,
                    AVG(predicted_units)::decimal AS avg_monthly_units
                FROM forecast_outputs fo
                WHERE fo.forecast_run_id = $1
                ${filterSql}
            `, params),
            pool.query(`
                SELECT
                    fo.province_id,
                    p.name AS province_name,
                    fo.brand_id,
                    b.name AS brand_name,
                    SUM(fo.predicted_units)::decimal AS predicted_units_total,
                    AVG(fo.predicted_units)::decimal AS avg_monthly_units
                FROM forecast_outputs fo
                LEFT JOIN provinces p ON p.id = fo.province_id
                LEFT JOIN brands b ON b.id = fo.brand_id
                WHERE fo.forecast_run_id = $1
                ${filterSql}
                GROUP BY fo.province_id, p.name, fo.brand_id, b.name
                ORDER BY predicted_units_total DESC
                LIMIT 25
            `, params),
            pool.query(`
                SELECT
                    mfd.province_id,
                    p.name AS province_name,
                    mfd.brand_id,
                    b.name AS brand_name,
                    mfd.horizon_year,
                    mfd.feature_type,
                    mfd.feature_value,
                    mfd.demand_share_pct,
                    mfd.demand_units
                FROM model_feature_demand mfd
                LEFT JOIN provinces p ON p.id = mfd.province_id
                LEFT JOIN brands b ON b.id = mfd.brand_id
                WHERE mfd.forecast_run_id = $1
                  AND COALESCE(mfd.demand_units, 0) > 0
                ${requestedProvinceId ? ` AND mfd.province_id = ${requestedProvinceId}` : ''}
                ${requestedBrandId ? ` AND mfd.brand_id = ${requestedBrandId}` : ''}
                ORDER BY mfd.horizon_year, mfd.feature_type, mfd.demand_units DESC, mfd.demand_share_pct DESC
                LIMIT 80
            `, [run.id])
        ]);

        res.json({
            run,
            summary: summaryRes.rows[0] || null,
            outputs: outputsRes.rows,
            feature_demand: featureDemandRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Latest forecast okunamadi', detail: err.message });
    }
});

app.get('/api/forecast/executive', authMiddleware, requireFeature('ai_forecast'), requireAiQuota(), async (req, res) => {
    try {
        const payload = await getForecastExecutiveView({
            forecastRunId: req.query.forecast_run_id,
            provinceId: req.query.province_id,
            brandId: req.query.brand_id
        });
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: 'Forecast executive ozeti okunamadi', detail: err.message });
    }
});

// ============================================
// DB INIT
// ============================================
async function initDB() {
    try {
        const schemaPath = path.join(__dirname, 'database', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await pool.query(schema);
            console.log('✅ Veritabanı şeması yüklendi');
        }

        // Model yılı filtreli view: her zaman oluştur/güncelle (schema bloğundan bağımsız)
        // model_year NULL ise (eski veri) kayıt dahil edilir, set ise son 2 model yılı kuralı uygulanır
        try {
            await pool.query('ALTER TABLE sales_data ADD COLUMN IF NOT EXISTS model_year INTEGER');
        } catch (e) { /* zaten var */ }
        try {
            await pool.query(`
                ALTER TABLE model_image_gallery
                    ADD COLUMN IF NOT EXISTS model_match_level VARCHAR(40) DEFAULT 'unknown',
                    ADD COLUMN IF NOT EXISTS verification_status VARCHAR(40) DEFAULT 'candidate',
                    ADD COLUMN IF NOT EXISTS review_status VARCHAR(40) DEFAULT 'candidate',
                    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP
            `);
        } catch (e) { /* galeri tablosu olmayan eski ortamlar schema ile oluşturulur */ }
        await pool.query(`
            CREATE OR REPLACE VIEW sales_view AS
            SELECT * FROM sales_data
            WHERE model_year IS NULL OR year = model_year OR year = model_year + 1
        `);
        console.log('✅ sales_view (model yılı filtreli) oluşturuldu');

        // Temel verileri seed et (markalar, iller, planlar, admin)
        const { brands, provinces, subscriptionPlans } = require('./database/seed-data');
        const bcryptSeedLib = require('bcryptjs');
        const [brandCheck, provinceCheck, planCheck] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS count FROM brands'),
            pool.query('SELECT COUNT(*)::int AS count FROM provinces'),
            pool.query('SELECT COUNT(*)::int AS count FROM subscription_plans')
        ]);

        const brandCount = parseInt(brandCheck.rows[0]?.count || 0, 10);
        const provinceCount = parseInt(provinceCheck.rows[0]?.count || 0, 10);
        const planCount = parseInt(planCheck.rows[0]?.count || 0, 10);

        if (brandCount === 0 || provinceCount < provinces.length || planCount === 0) {
            console.log('🌱 Temel referans verileri kontrol edilip tamamlanıyor...');

            if (brandCount === 0) {
                for (const brand of brands) {
                    await pool.query(`INSERT INTO brands (name, slug, primary_color, secondary_color, accent_color, text_color, country_of_origin, parent_company) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                        [brand.name, brand.slug, brand.primary_color, brand.secondary_color, brand.accent_color, brand.text_color, brand.country_of_origin, brand.parent_company]);
                }
            }

            if (provinceCount < provinces.length) {
                await ensureProvincesSeeded();
            }

            if (planCount === 0) {
                for (const plan of subscriptionPlans) {
                    await pool.query(`INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, features, max_users, has_ai_insights, has_competitor_analysis, has_weather_data, has_export) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
                        [plan.name, plan.slug, plan.price_monthly, plan.price_yearly, plan.features, plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export]);
                }
            }

            // NOT: admin@traktorsektoranalizi.com / admin2024 demo hesabı kaldırıldı.
            // Tek yönetici (superuser) yukselozdek@gmail.com — Google OAuth veya kayıt akışı üzerinden giriş yapar.
            console.log('✅ Temel referans verileri tamamlandı (demo admin hesabı oluşturulmadı)');
        }

        // ============================================
        // BILLING SCHEMA MIGRATION + PLAN UPSERT (her boot'ta idempotent)
        // 3 plan: Starter / Growth / Enterprise + kapsam limit, AI sorgu sayacı,
        // WhatsApp telefon yönetimi, makbuz/e-fatura tablosu
        // ============================================
        try {
            // subscription_plans yeni sütunlar
            await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tier_rank INT DEFAULT 1`);
            await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT`);
            await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS feature_keys JSONB DEFAULT '[]'::jsonb`);
            await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_limits JSONB DEFAULT '{}'::jsonb`);
            await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'TRY'`);

            // subscriptions yeni sütunlar
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider VARCHAR(50)`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id VARCHAR(255)`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(255)`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT true`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMP`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS first_month_promo_price DECIMAL(10,2)`);
            await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rivals_selection JSONB DEFAULT '[]'::jsonb`);

            // payments yeni sütunlar
            await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(50)`);
            await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(255)`);
            await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(100)`);
            await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);

            // Aylık kullanım sayaçları (AI sorgu, export, API, WA)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS usage_meters (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    period_start DATE NOT NULL,
                    ai_queries_count INTEGER DEFAULT 0,
                    ai_tokens_used BIGINT DEFAULT 0,
                    export_rows_count INTEGER DEFAULT 0,
                    api_request_count INTEGER DEFAULT 0,
                    whatsapp_query_count INTEGER DEFAULT 0,
                    anomaly_flags INTEGER DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(user_id, period_start)
                )
            `);

            // AI çağrı log'u (audit + maliyet hesaplama)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ai_usage_log (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id),
                    feature VARCHAR(100),
                    model VARCHAR(50),
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    cost_tl DECIMAL(8,4) DEFAULT 0,
                    request_id VARCHAR(100),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage_log(user_id, created_at DESC)`);

            // WhatsApp telefon yönetimi (Enterprise: 3 hat)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS whatsapp_phones (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    subscription_id INTEGER REFERENCES subscriptions(id),
                    phone_e164 VARCHAR(20) UNIQUE NOT NULL,
                    display_name VARCHAR(100),
                    role_label VARCHAR(50),
                    is_active BOOLEAN DEFAULT true,
                    is_primary BOOLEAN DEFAULT false,
                    activated_at TIMESTAMP DEFAULT NOW(),
                    last_query_at TIMESTAMP,
                    monthly_query_count INTEGER DEFAULT 0,
                    admin_approved BOOLEAN DEFAULT false,
                    admin_approved_at TIMESTAMP,
                    admin_approved_by INTEGER REFERENCES users(id)
                )
            `);

            // Makbuz/e-fatura tablosu (şirketsiz başlangıç için makbuz modu)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS invoices (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    payment_id INTEGER REFERENCES payments(id),
                    invoice_number VARCHAR(50) UNIQUE,
                    invoice_type VARCHAR(20) DEFAULT 'receipt',
                    is_legal_invoice BOOLEAN DEFAULT false,
                    legal_invoice_pending BOOLEAN DEFAULT true,
                    billing_company_name VARCHAR(200),
                    billing_tax_office VARCHAR(100),
                    billing_tax_number VARCHAR(20),
                    billing_address TEXT,
                    billing_city VARCHAR(100),
                    billing_country VARCHAR(50) DEFAULT 'TR',
                    subtotal DECIMAL(12,2),
                    vat_rate DECIMAL(4,2) DEFAULT 20.00,
                    vat_amount DECIMAL(12,2),
                    total DECIMAL(12,2),
                    einvoice_status VARCHAR(20),
                    einvoice_uuid VARCHAR(100),
                    einvoice_pdf_url VARCHAR(500),
                    issued_at TIMESTAMP DEFAULT NOW(),
                    paid_at TIMESTAMP
                )
            `);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, issued_at DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_pending ON invoices(legal_invoice_pending) WHERE legal_invoice_pending = true`);

            // Kullanım anomali izleme (kopyalama riskine karşı)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS usage_anomalies (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id),
                    anomaly_type VARCHAR(50),
                    score DECIMAL(4,2),
                    details JSONB DEFAULT '{}',
                    flagged_at TIMESTAMP DEFAULT NOW(),
                    reviewed BOOLEAN DEFAULT false,
                    reviewed_by INTEGER REFERENCES users(id)
                )
            `);

            // ============================================
            // AUTH GENİŞLETME: Google OAuth, email verify, lock, superuser, firma alanları
            // ============================================
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(100) UNIQUE`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'password'`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(100)`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMP`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tax_office VARCHAR(100)`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tax_number VARCHAR(20)`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(100)`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS dealer_or_distributor VARCHAR(50)`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT DEFAULT 0`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superuser BOOLEAN DEFAULT false`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preview_plan_slug VARCHAR(50)`);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS auth_audit (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id),
                    event VARCHAR(50),
                    ip_address VARCHAR(45),
                    user_agent TEXT,
                    metadata JSONB DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit(user_id, created_at DESC)`);

            // Superuser: yukselozdek@gmail.com — her zaman admin + is_superuser
            await pool.query(`
                UPDATE users SET role = 'admin', is_superuser = true, email_verified = true
                WHERE LOWER(email) = 'yukselozdek@gmail.com'
            `);

            // Media Watch genişletme: dil + ülke + çeviri kolonları
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'tr'`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS country_code VARCHAR(5) DEFAULT 'TR'`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS original_title TEXT`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_title TEXT`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_summary TEXT`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translation_model VARCHAR(50)`);
            await pool.query(`ALTER TABLE media_watch_items ADD COLUMN IF NOT EXISTS translated_at TIMESTAMP`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_media_watch_items_language ON media_watch_items(language)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_media_watch_items_country ON media_watch_items(country_code)`);

            // Eski plan slug'larını gizle (basic/pro/elite + temel/profesyonel/kurumsal)
            await pool.query(`UPDATE subscription_plans SET is_active = false WHERE slug IN ('temel', 'profesyonel', 'kurumsal', 'basic', 'pro', 'elite')`);

            // 3 yeni plan (Starter/Growth/Enterprise) upsert
            for (const plan of subscriptionPlans) {
                await pool.query(`
                    INSERT INTO subscription_plans
                        (name, slug, tier_rank, description, currency, price_monthly, price_yearly,
                         features, feature_keys, plan_limits, max_users,
                         has_ai_insights, has_competitor_analysis, has_weather_data, has_export, is_active)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,true)
                    ON CONFLICT (slug) DO UPDATE SET
                        name = EXCLUDED.name,
                        tier_rank = EXCLUDED.tier_rank,
                        description = EXCLUDED.description,
                        currency = EXCLUDED.currency,
                        price_monthly = EXCLUDED.price_monthly,
                        price_yearly = EXCLUDED.price_yearly,
                        features = EXCLUDED.features,
                        feature_keys = EXCLUDED.feature_keys,
                        plan_limits = EXCLUDED.plan_limits,
                        max_users = EXCLUDED.max_users,
                        has_ai_insights = EXCLUDED.has_ai_insights,
                        has_competitor_analysis = EXCLUDED.has_competitor_analysis,
                        has_weather_data = EXCLUDED.has_weather_data,
                        has_export = EXCLUDED.has_export,
                        is_active = true
                `, [
                    plan.name, plan.slug, plan.tier_rank, plan.description, plan.currency,
                    plan.price_monthly, plan.price_yearly, plan.features, plan.feature_keys, plan.plan_limits,
                    plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export
                ]);
            }
            console.log('✅ Billing şeması ve 3 plan (Starter/Growth/Enterprise) güncellendi');
        } catch (billingMigErr) {
            console.warn('⚠️ Billing migration uyarısı:', billingMigErr.message);
        }

        // ============================================
        // ESKİ DEMO ADMİN HESABI TEMİZLİĞİ
        // admin@traktorsektoranalizi.com / admin2024 kaldırıldı.
        // Sistem yetkisi yalnızca yukselozdek@gmail.com (superuser) üzerinden verilir;
        // diğer üyeler login.html üzerinden Google OAuth veya 4-adımlı kayıt akışıyla katılır.
        // FK kısıtları nedeniyle silmek yerine deaktif et + şifreyi rastgele yap → giriş yapamaz.
        // ============================================
        try {
            const oldAdmin = await pool.query(`SELECT id FROM users WHERE email = 'admin@traktorsektoranalizi.com'`);
            if (oldAdmin.rows.length > 0) {
                const oldId = oldAdmin.rows[0].id;
                const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
                await pool.query(
                    `UPDATE users
                       SET email = $1,
                           password_hash = $2,
                           is_active = false,
                           role = 'inactive',
                           is_superuser = false,
                           full_name = 'Devre Dışı Demo Hesap',
                           email_verified = false,
                           failed_login_count = 999,
                           locked_until = NOW() + INTERVAL '100 years'
                     WHERE id = $3`,
                    [`disabled_${oldId}@invalid.local`, randomHash, oldId]
                );
                console.log(`🧹 Eski demo admin hesabı (id=${oldId}) deaktif edildi ve giriş kilitlendi`);
            }
        } catch (cleanupErr) {
            console.warn('⚠️ Demo admin temizliği uyarısı:', cleanupErr.message);
        }

        // ============================================
        // MARKA İSİMLERİ NORMALİZASYONU
        // ============================================
        const brandNameMap = {
            'CASE IH': 'CASE',
            'DEUTZ-FAHR': 'DEUTZ',
            'KIOTI': 'KİOTİ'
        };
        for (const [oldName, newName] of Object.entries(brandNameMap)) {
            const oldBrand = (await pool.query('SELECT id FROM brands WHERE name = $1', [oldName])).rows[0];
            const newBrand = (await pool.query('SELECT id FROM brands WHERE name = $1', [newName])).rows[0];
            if (oldBrand && newBrand && oldBrand.id !== newBrand.id) {
                // Her iki isim de var: tüm FK referanslarını yeni markaya taşı, eski kaydı sil
                await pool.query('UPDATE sales_data SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                await pool.query('UPDATE tractor_models SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                await pool.query('UPDATE users SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                // Diğer olası FK referansları
                try { await pool.query('UPDATE user_favorites SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]); } catch(e) {}
                try { await pool.query('UPDATE brand_settings SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]); } catch(e) {}
                await pool.query('DELETE FROM brands WHERE id = $1', [oldBrand.id]);
                console.log(`🔄 Marka birleştirildi: ${oldName} (id:${oldBrand.id}) → ${newName} (id:${newBrand.id})`);
            } else if (oldBrand && !newBrand) {
                // Sadece eski isim var: yeniden adlandır
                await pool.query('UPDATE brands SET name = $1 WHERE id = $2', [newName, oldBrand.id]);
                console.log(`🔄 Marka ismi güncellendi: ${oldName} → ${newName}`);
            }
        }

        await ensureBrandPortalSeeded();
        console.log('Brand portal profilleri hazirlandi');
        await ensureFutureIntelligenceSeeded();
        console.log('Future intelligence kaynak ve destek cekirdegi hazirlandi');
        await ensureReferenceMarketSignalsSeeded();
        console.log('Reference market ve iklim sinyal katmani hazirlandi');

        // ============================================
        // TEKNİK VERİ → TRACTOR_MODELS OTOMATİK SYNC
        // Anayasa Kuralı: marka + tuik_model_adi eşleştirmesi
        // ============================================
        try {
            await pool.query('ALTER TABLE tractor_models ADD COLUMN IF NOT EXISTS price_usd DECIMAL(12,2)');

            // Marka eşleştirme haritası (teknik_veri marka adı → brands tablosu adı)
            const brandAliasMap = {
                'CASE IH': 'CASE', 'DEUTZ-FAHR': 'DEUTZ', 'KIOTI': 'KİOTİ'
            };

            // teknik_veri'den tüm modelleri al
            const teknikRows = await pool.query(`
                SELECT tv.marka, tv.tuik_model_adi, tv.model, tv.fiyat_usd,
                       tv.motor_gucu_hp, tv.cekis_tipi, tv.koruma, tv.vites_sayisi, tv.kullanim_alani
                FROM teknik_veri tv
                WHERE tv.tuik_model_adi IS NOT NULL AND tv.tuik_model_adi != ''
            `);

            let syncCount = 0;
            let insertCount = 0;

            for (const tv of teknikRows.rows) {
                const teknikMarka = tv.marka.trim().toUpperCase();
                const resolvedBrand = brandAliasMap[teknikMarka] || teknikMarka;

                // Brand ID bul
                const brandRes = await pool.query('SELECT id FROM brands WHERE UPPER(name) = $1', [resolvedBrand]);
                if (brandRes.rows.length === 0) continue;
                const brandId = brandRes.rows[0].id;

                const tuikModelAdi = tv.tuik_model_adi.trim();
                const hp = parseFloat(tv.motor_gucu_hp) || null;
                const hpRange = hp ? (hp <= 39 ? '1-39' : hp <= 49 ? '40-49' : hp <= 54 ? '50-54' : hp <= 59 ? '55-59' : hp <= 69 ? '60-69' : hp <= 79 ? '70-79' : hp <= 89 ? '80-89' : hp <= 99 ? '90-99' : hp <= 109 ? '100-109' : hp <= 119 ? '110-119' : '120+') : null;
                const cabinType = String(tv.koruma || '').toLowerCase().includes('kabin') ? 'kabinli' : 'rollbar';
                const driveType = String(tv.cekis_tipi || '') || '4WD';
                const gearConfig = String(tv.vites_sayisi || '') || '12+12';
                const category = String(tv.kullanim_alani || '').toLowerCase().includes('bahçe') ? 'bahce' : 'tarla';
                const priceUsd = parseFloat(tv.fiyat_usd) || null;

                // tractor_models'da tuik_model_adi ile eşleşen kayıt var mı?
                const existing = await pool.query(
                    'SELECT id FROM tractor_models WHERE brand_id = $1 AND UPPER(model_name) = UPPER($2)',
                    [brandId, tuikModelAdi]
                );

                if (existing.rows.length > 0) {
                    // Varsa: price_usd ve teknik bilgileri güncelle
                    if (priceUsd && priceUsd > 0) {
                        await pool.query(
                            `UPDATE tractor_models SET price_usd = $1, horsepower = COALESCE($2, horsepower),
                             hp_range = COALESCE($3, hp_range), cabin_type = $4, drive_type = $5,
                             gear_config = $6, category = $7
                             WHERE id = $8`,
                            [priceUsd, hp, hpRange, cabinType, driveType, gearConfig, category, existing.rows[0].id]
                        );
                        syncCount++;
                    }
                } else {
                    if (!hp) continue;

                    // Yoksa: teknik_veri'den yeni model oluştur
                    await pool.query(
                        `INSERT INTO tractor_models (brand_id, model_name, horsepower, hp_range, category,
                         cabin_type, drive_type, gear_config, price_usd, is_current_model)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
                         ON CONFLICT DO NOTHING`,
                        [brandId, tuikModelAdi, hp, hpRange, category, cabinType, driveType, gearConfig, priceUsd]
                    );
                    insertCount++;
                }
            }

            console.log(`💰 teknik_veri sync: ${syncCount} model güncellendi, ${insertCount} yeni model eklendi`);

            // Eski hardcoded modellere de numara bazlı fiyat eşleştirmeyi dene
            // (teknik_veri'den gelmeyen ama seed'den gelen modeller için)
            const numericSync = await pool.query(`
                UPDATE tractor_models tm
                SET price_usd = subq.fiyat_usd
                FROM (
                    SELECT DISTINCT ON (tm2.id)
                           tm2.id as tm_id, tv2.fiyat_usd
                    FROM tractor_models tm2
                    JOIN brands b2 ON tm2.brand_id = b2.id
                    JOIN teknik_veri tv2 ON (UPPER(tv2.marka) = UPPER(b2.name)
                        OR (UPPER(tv2.marka) = 'CASE IH' AND UPPER(b2.name) = 'CASE')
                        OR (UPPER(tv2.marka) = 'DEUTZ-FAHR' AND UPPER(b2.name) = 'DEUTZ')
                        OR (UPPER(tv2.marka) = 'KIOTI' AND UPPER(b2.name) = 'KİOTİ'))
                    WHERE (tm2.price_usd IS NULL OR tm2.price_usd = 0)
                      AND tm2.is_current_model = true
                      AND tv2.fiyat_usd IS NOT NULL AND tv2.fiyat_usd > 0
                      AND LENGTH(regexp_replace(tm2.model_name, '[^0-9]', '', 'g')) >= 3
                      AND tv2.tuik_model_adi ILIKE '%' || regexp_replace(tm2.model_name, '[^0-9]', '', 'g') || '%'
                    ORDER BY tm2.id, tv2.fiyat_usd
                ) subq
                WHERE tm.id = subq.tm_id
            `);
            if (numericSync.rowCount > 0) console.log(`💰 ${numericSync.rowCount} eski model numarayla eşleştirildi`);

            // Hala price_usd boş olan modelleri logla
            const unsyncedModels = await pool.query(`
                SELECT b.name as brand_name, tm.model_name
                FROM tractor_models tm
                JOIN brands b ON tm.brand_id = b.id
                WHERE tm.is_current_model = true AND (tm.price_usd IS NULL OR tm.price_usd = 0)
                ORDER BY b.name, tm.model_name
                LIMIT 30
            `);
            if (unsyncedModels.rows.length > 0) {
                console.log(`⚠️ price_usd boş olan modeller (${unsyncedModels.rows.length}):`);
                unsyncedModels.rows.forEach(r => console.log(`   ${r.brand_name} / ${r.model_name}`));
            }

            console.log('✅ USD fiyat senkronizasyonu tamamlandı');
        } catch (priceErr) {
            console.error('USD fiyat senkronizasyon hatası:', priceErr.message);
        }

        // Satış verisi yoksa bilgi ver
        const salesCheck = await pool.query('SELECT COUNT(*) FROM sales_data');
        console.log(`📊 Satış verisi: ${salesCheck.rows[0].count} kayıt`);
        if (parseInt(salesCheck.rows[0].count) === 0) {
            console.log('⚠️ Satış verisi yok! POST /api/admin/seed-sales endpoint\'ini çağırın');
        }
    } catch (err) {
        console.error('DB init hatası:', err.message);
    }
}

// ============================================
// SPA FALLBACK
// ============================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ============================================
// MEDIA WATCH BRIDGE — opsiyonel child_process otomatik başlat
// ============================================
let mediaWatchBridgeProcess = null;
function startMediaWatchBridge() {
    const autoStart = String(process.env.MEDIA_WATCH_BRIDGE_AUTOSTART || 'false').toLowerCase() === 'true';
    if (!autoStart) return;
    try {
        const { spawn } = require('child_process');
        const bridgePath = path.join(__dirname, 'media-watch-bridge.js');
        if (!require('fs').existsSync(bridgePath)) {
            console.warn('⚠️  Media-watch-bridge.js bulunamadı, atlanıyor');
            return;
        }
        const childEnv = {
            ...process.env,
            MEDIA_WATCH_BRIDGE_DIRECT: process.env.MEDIA_WATCH_BRIDGE_DIRECT || 'true',
            MEDIA_WATCH_BRIDGE_AUTORUN: process.env.MEDIA_WATCH_BRIDGE_AUTORUN || 'true',
            MEDIA_WATCH_APP_BASE_URL: process.env.MEDIA_WATCH_APP_BASE_URL || `http://127.0.0.1:${PORT}`
        };
        mediaWatchBridgeProcess = spawn('node', [bridgePath], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        mediaWatchBridgeProcess.stdout.on('data', d => process.stdout.write(`[mwb] ${d}`));
        mediaWatchBridgeProcess.stderr.on('data', d => process.stderr.write(`[mwb] ${d}`));
        mediaWatchBridgeProcess.on('exit', code => {
            console.log(`📡 Media-watch-bridge çıktı (code=${code})`);
            mediaWatchBridgeProcess = null;
        });
        console.log('📡 Media-watch-bridge child process başlatıldı (PID: ' + mediaWatchBridgeProcess.pid + ')');
    } catch (err) {
        console.warn('⚠️  Media-watch-bridge başlatılamadı:', err.message);
    }
}

// ============================================
// START SERVER
// ============================================
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚜 Traktör Sektör Analizi sunucusu ${PORT} portunda çalışıyor`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        setTimeout(startMediaWatchBridge, 2000);
    });
}).catch(err => {
    console.error('❌ initDB hatası:', err);
    // Yine de sunucuyu başlat
    app.listen(PORT, () => {
        console.log(`🚜 Sunucu başlatıldı (initDB hatalı) - port ${PORT}`);
        setTimeout(startMediaWatchBridge, 2000);
    });
});

process.on('SIGTERM', async () => {
    console.log('Sunucu kapatılıyor...');
    if (mediaWatchBridgeProcess && !mediaWatchBridgeProcess.killed) {
        try { mediaWatchBridgeProcess.kill('SIGTERM'); } catch { /* noop */ }
    }
    await pool.end();
    process.exit(0);
});
