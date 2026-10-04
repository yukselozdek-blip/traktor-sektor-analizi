require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const {
    PORT, JWT_SECRET, SUPERUSER_EMAILS_LIST, IS_PRODUCTION, safeEqualStr, errMsg, APP_BASE_URL,
    WHATSAPP_QUERY_API_KEY, WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
    MEDIA_WATCH_WEBHOOK_KEY, N8N_WHATSAPP_PROCESSOR_URL, N8N_MODEL_INTEL_WEBHOOK_URL, MODEL_IMAGE_BRIDGE_URL
} = require('./src/config');
const { pool } = require('./src/db');
const { isSafeSql } = require('./src/lib/sql-guard');
process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err && err.stack ? err.stack : err);
});

// Middleware
// Proxy zinciri: Railway = 1 atlama; Cloudflare turuncu bulut açılınca TRUST_PROXY_HOPS=2
// (X-Forwarded-For: istemci, Cloudflare). Böylece req.ip / hız sınırları gerçek istemci IP'sini görür.
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 0);
app.set('trust proxy', TRUST_PROXY_HOPS);
const CORS_ALLOWED_ORIGINS = new Set(
    [...(process.env.CORS_ORIGINS || '').split(','), APP_BASE_URL]
        .map(o => (o || '').trim().replace(/\/$/, ''))
        .filter(Boolean)
);
// Ana alan adı → uygulama alan adı (301). REDIRECT_HOSTS örn: "tarimtraktor.com,www.tarimtraktor.com"
const REDIRECT_HOSTS = new Set((process.env.REDIRECT_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
if (REDIRECT_HOSTS.size && APP_BASE_URL) {
    app.use((req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
        if (!REDIRECT_HOSTS.has(host) || req.path === '/health') return next();
        res.redirect(301, APP_BASE_URL + req.originalUrl);
    });
}
const compression = require('compression');
app.use(compression({
    filter: (req, res) => {
        if (/no-transform/i.test(res.getHeader('Cache-Control') || '')) return false;
        return compression.filter(req, res);
    }
}));
app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        return cb(null, CORS_ALLOWED_ORIGINS.has(origin.replace(/\/$/, '')));
    }
}));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use('/api/billing/webhook/stripe', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        if (req.originalUrl && req.originalUrl.startsWith('/api/public/whatsapp/webhook')) req.rawBody = buf;
    }
}));
// Production: serve minified builds (public/dist, produced by `npm run build`)
// under the original URLs so HTML and ?v= cache-busting keep working.
const MINIFIED_ASSETS = new Map();
if (process.env.NODE_ENV === 'production' || process.env.SERVE_MINIFIED === '1') {
    for (const f of ['app_v3.js', 'api_v3.js', 'brand_experience.js', 'report_registry.js', 'style.css', 'billing.css', 'media-watch.css']) {
        const min = f.replace(/\.(js|css)$/, '.min.$1');
        if (fs.existsSync(path.join(__dirname, 'public', 'dist', min))) MINIFIED_ASSETS.set('/' + f, '/dist/' + min);
    }
    if (MINIFIED_ASSETS.size) {
        app.use((req, res, next) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
                const target = MINIFIED_ASSETS.get(req.path);
                if (target) req.url = target + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
            }
            next();
        });
    }
}
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (/\.html?$/i.test(filePath)) {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
            return;
        }

        if (/\.(js|css|json|png|svg|woff2)$/i.test(filePath)) {
            const v = res.req && res.req.query && res.req.query.v;
            res.set('Cache-Control', v
                ? 'public, max-age=86400'
                : 'public, max-age=3600');
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
const { authMiddleware, adminOnly } = require('./src/middleware/auth');
const { LOGIN_LIMITER, SIGNUP_LIMITER, FORGOT_LIMITER, RESET_LIMITER } = require('./src/middleware/limiters');

app.get('/api/auth/diagnostic', authMiddleware, adminOnly, async (req, res) => {
    try {
        const users = await pool.query('SELECT id, email, role, full_name, (password_hash IS NOT NULL) as has_password_hash FROM users');
        const schema = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
        res.json({
            status: '✅ Sunucu Aktif',
            database_users: users.rows,
            database_schema: schema.rows.map(r => r.column_name)
        });
    } catch (err) {
        res.status(500).json({ status: '❌ Hata', message: errMsg(err) });
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

async function executeSafeSql(sql) {
    if (!isSafeSql(sql)) {
        return { error: 'Güvenlik: Sadece SELECT sorguları çalıştırılabilir.' };
    }
    sql = sql.trim().replace(/;\s*$/, '');

    // Division by zero koruması: NULLIF ile sıfıra bölmeyi önle
    sql = sql.replace(/\/\s*SUM\(([^)]+)\)/g, '/ NULLIF(SUM($1), 0)');
    sql = sql.replace(/\/\s*COUNT\(([^)]+)\)/g, '/ NULLIF(COUNT($1), 0)');

    // Salt-okunur transaction + 8 sn statement timeout, ayrı client
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('SET TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 8000');
        const result = await client.query(sql);
        return { rows: result.rows, rowCount: result.rowCount, fields: result.fields?.map(f => f.name) };
    } catch (err) {
        return { error: `SQL hatası: ${err.message}` };
    } finally {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
            client.release();
        }
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

require('./src/routes/public')(app, {
    pool, authMiddleware, adminOnly, getLatestSalesPeriod, getBrandCatalog, normalizeSearchText,
    buildBrandExecutiveData, renderBrandExecutiveHtml, buildBrandCompareExecutiveData, renderBrandCompareHtml,
    buildMarketOverviewData, renderMarketOverviewHtml, textToSql, buildSmartFallbackSql, executeSafeSql,
    interpretResults, buildCiroSql, resolveAssistantQuestion, addToConversation, getConversationHistory,
    sendWhatsAppTextMessage,
    get lastGroqError() { return lastGroqError; },
    get MINIMAX_API_KEY() { return MINIMAX_API_KEY; }
});






// ============================================
// ============================================
// AUTH ENDPOINTS — Hardened (rate limit, lock, Google OAuth, email verify)
// ============================================
const SUPERUSER_EMAILS = new Set(SUPERUSER_EMAILS_LIST);
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

function escapeMailHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function issueAuthToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, sup: !!user.is_superuser },
        JWT_SECRET, { expiresIn: '7d' }
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
        if (SUPERUSER_EMAILS.has(email) && user.email_verified === true && !user.is_superuser) {
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

require('./src/routes/signup-google')(app, {
    pool, SIGNUP_LIMITER, LOGIN_LIMITER, SUPERUSER_EMAILS, logAuthAudit, issueAuthToken,
    buildUserPayload, escapeMailHtml
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

require('./src/routes/password-reset')(app, { pool, logAuthAudit, FORGOT_LIMITER, RESET_LIMITER });

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

require('./src/routes/sales')(app, { pool, authMiddleware, roundMetric, calculateYoY, ensureProvincesSeeded });
require('./src/routes/models')(app, { pool, authMiddleware, adminOnly, normalizeSearchText, roundMetric, calculateYoY, errMsg, APP_BASE_URL, MEDIA_WATCH_WEBHOOK_KEY, N8N_MODEL_INTEL_WEBHOOK_URL, MODEL_IMAGE_BRIDGE_URL });
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
function insightsWriteAuth(req, res, next) {
    const key = process.env.INSIGHTS_API_KEY || '';
    const provided = req.headers['x-api-key'];
    if (key && provided) {
        if (safeEqualStr(provided, key)) return next();
        return res.status(401).json({ error: 'Geçersiz API anahtarı' });
    }
    return authMiddleware(req, res, (err) => {
        if (err) return next(err);
        return adminOnly(req, res, next);
    });
}

app.post('/api/insights', insightsWriteAuth, async (req, res) => {
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

require('./src/routes/media-watch')(app, {
    pool, authMiddleware, requireFeature, requireAiQuota, recordAiUsage, errMsg,
    resolveMediaWatchScopedBrandId, resolveMediaWatchBrandId, buildMediaWatchOverview,
    isMediaWatchWebhookAuthorized, upsertMediaWatchRun, upsertMediaWatchItems,
    syncMediaWatchAlerts, generateMediaWatchBriefRecord
});

// ============================================
// SUBSCRIPTION & PAYMENT
// ============================================

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

require('./src/routes/billing')(app, {
    pool, authMiddleware, adminOnly, errMsg, JWT_SECRET,
    getUserActiveSubscription, getPreviewPlanSlug, getPreviewPlanFeatures
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
        res.status(500).json({ error: errMsg(err) });
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

require('./src/routes/dashboard-admin')(app, { bcrypt, pool, authMiddleware, adminOnly });
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
const MEMORY_MAX_SESSIONS = 5000;
setInterval(() => {
    const now = Date.now();
    for (const [phone, hist] of conversationMemory) {
        const last = hist[hist.length - 1];
        if (!last || now - last.timestamp > MEMORY_TTL_MS) conversationMemory.delete(phone);
    }
}, 5 * 60 * 1000).unref();

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
        if (conversationMemory.size >= MEMORY_MAX_SESSIONS) {
            // En eski oturumu (Map ekleme sırası) at
            const oldest = conversationMemory.keys().next().value;
            conversationMemory.delete(oldest);
        }
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

app.post('/api/ai/analyze', authMiddleware, requireFeature('ai_insights', 'ai_insights_limited', 'model_region_analysis'), requireAiQuota(), async (req, res) => {
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
        res.status(500).json({ error: 'AI analiz hatası: ' + errMsg(err) });
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
        res.status(500).json({ error: 'Future intelligence readiness okunamadi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Future intelligence catalog okunamadi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Reference market data seed edilemedi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Baseline forecast kosulamadi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Forecast run listesi okunamadi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Latest forecast okunamadi', detail: errMsg(err) });
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
        res.status(500).json({ error: 'Forecast executive ozeti okunamadi', detail: errMsg(err) });
    }
});

// ============================================
// DB INIT
// ============================================
async function initDB() {
    try {
        // Yapısal şema: database/migrations/*.sql (idempotent, schema_migrations ile izlenir).
        // Hata olursa yüksek sesle loglanır, sonraki migration'lar uygulanmaz; sunucu yine de başlar.
        try {
            await require('./database/migrate').runMigrations(pool, { logger: console });
        } catch (migErr) {
            console.error('❌ DB MIGRATION HATASI (sunucu yine de başlatılıyor):', migErr.message);
        }

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
            // Superuser: yukselozdek@gmail.com — her zaman admin + is_superuser
            await pool.query(`
                UPDATE users SET role = 'admin', is_superuser = true
                WHERE LOWER(email) = ANY($1::text[]) AND email_verified = true
            `, [SUPERUSER_EMAILS_LIST]);

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
    } else {
        res.status(404).json({ error: 'Bulunamadı' });
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
