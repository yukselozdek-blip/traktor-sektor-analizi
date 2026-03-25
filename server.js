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

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'traktor-sektor-super-secret-key-2024';

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL?.includes('.railway.internal')
        ? { rejectUnauthorized: false } : false
});

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ============================================
// AUTH ENDPOINTS
// ============================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email ve şifre gerekli' });

        const result = await pool.query(`
            SELECT u.*, b.name as brand_name, b.slug as brand_slug, b.primary_color, b.secondary_color, b.accent_color, b.text_color, b.logo_url
            FROM users u LEFT JOIN brands b ON u.brand_id = b.id
            WHERE u.email = $1 AND u.is_active = true
        `, [email]);

        if (result.rows.length === 0) return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });

        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id },
            JWT_SECRET, { expiresIn: '30d' }
        );

        res.json({
            token,
            user: {
                id: user.id, email: user.email, full_name: user.full_name,
                role: user.role, brand_id: user.brand_id,
                brand: user.brand_name ? {
                    name: user.brand_name, slug: user.brand_slug,
                    primary_color: user.primary_color, secondary_color: user.secondary_color,
                    accent_color: user.accent_color, text_color: user.text_color,
                    logo_url: user.logo_url
                } : null
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.email, u.full_name, u.role, u.brand_id, u.company_name, u.city,
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
// BRANDS
// ============================================
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
        const { region } = req.query;
        let query = 'SELECT * FROM provinces';
        const params = [];
        if (region) { query += ' WHERE region = $1'; params.push(region); }
        query += ' ORDER BY name';
        const result = await pool.query(query, params);
        res.json(result.rows);
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
            FROM sales_data s
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        // 2. Son 12 yılın tam yıllık verileri (son 2 yıl hariç)
        const yearlyRes = await pool.query(`
            SELECT s.year,
                   SUM(s.quantity) as total_market,
                   SUM(CASE WHEN s.brand_id = $1 THEN s.quantity ELSE 0 END) as brand_sales
            FROM sales_data s
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
            FROM sales_data s
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
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
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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

// Marka Özet Tablosu - Tüm markalar yıllık + aylık + karşılaştırma
app.get('/api/sales/brand-summary', authMiddleware, async (req, res) => {
    try {
        // Son veri noktası
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);

        // 1. Yıllık toplamlar (tüm yıllar, marka bazlı) - son yıl hariç (partial)
        const yearlyRes = await pool.query(`
            SELECT b.id as brand_id, b.name as brand_name, s.year, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.year >= $1 AND s.year <= $2
            GROUP BY b.id, b.name, s.year ORDER BY b.name, s.year
        `, [minYear, prevYear]);

        // 2. Son yılın aylık verileri (marka bazlı)
        const monthlyRes = await pool.query(`
            SELECT b.id as brand_id, b.name as brand_name, s.month, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1
            GROUP BY b.id, b.name, s.month ORDER BY b.name, s.month
        `, [maxYear]);

        // 3. Önceki yılın ilk N ayı (marka bazlı)
        const prevPartialRes = await pool.query(`
            SELECT b.id as brand_id, b.name as brand_name, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY b.id, b.name ORDER BY b.name
        `, [prevYear, maxMonth]);

        // 4. Son yılın ilk N ayı (marka bazlı) = aylık toplamların toplamı
        const currPartialRes = await pool.query(`
            SELECT b.id as brand_id, b.name as brand_name, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY b.id, b.name ORDER BY b.name
        `, [maxYear, maxMonth]);

        // 5. Yıllık toplam pazar
        const yearlyTotalRes = await pool.query(`
            SELECT year, SUM(quantity) as total FROM sales_data
            WHERE year >= $1 AND year <= $2
            GROUP BY year ORDER BY year
        `, [minYear, prevYear]);

        // 6. Son yıl aylık toplam pazar
        const monthlyTotalRes = await pool.query(`
            SELECT month, SUM(quantity) as total FROM sales_data
            WHERE year = $1 GROUP BY month ORDER BY month
        `, [maxYear]);

        // 7. Önceki yıl partial toplam
        const prevPartialTotalRes = await pool.query(`
            SELECT SUM(quantity) as total FROM sales_data WHERE year = $1 AND month <= $2
        `, [prevYear, maxMonth]);

        // 8. Son yıl partial toplam
        const currPartialTotalRes = await pool.query(`
            SELECT SUM(quantity) as total FROM sales_data WHERE year = $1 AND month <= $2
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
app.get('/api/sales/total-market', authMiddleware, async (req, res) => {
    try {
        const { brand_id } = req.query;
        const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;

        // Son veri noktasını bul
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;

        // Toplam pazar (tüm markalar) - aylık
        const totalRes = await pool.query(`
            SELECT year, month, SUM(quantity) as total
            FROM sales_data
            WHERE year IN ($1, $2)
            GROUP BY year, month ORDER BY year, month
        `, [prevYear, maxYear]);

        // Seçili marka - aylık
        let brandRes = { rows: [] };
        let brandName = null;
        if (userBrandId) {
            brandRes = await pool.query(`
                SELECT year, month, SUM(quantity) as total
                FROM sales_data
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

// İl bazlı satış verileri
app.get('/api/sales/by-province', authMiddleware, async (req, res) => {
    try {
        const { year, brand_id } = req.query;
        const userBrandId = req.user.role === 'admin' ? (brand_id || null) : req.user.brand_id;
        const targetYear = year || new Date().getFullYear();

        let query = `
            SELECT p.name as province_name, p.plate_code, p.latitude, p.longitude, p.region,
                   b.name as brand_name, b.slug as brand_slug, b.primary_color,
                   SUM(s.quantity) as total_sales
            FROM sales_data s
            JOIN provinces p ON s.province_id = p.id
            JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1
        `;
        const params = [targetYear];
        if (userBrandId) {
            params.push(userBrandId);
            query += ` AND s.brand_id = $${params.length}`;
        }
        query += ' GROUP BY p.id, p.name, p.plate_code, p.latitude, p.longitude, p.region, b.id, b.name, b.slug, b.primary_color ORDER BY total_sales DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
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
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
                   ROUND(SUM(s.quantity) * 100.0 / NULLIF((SELECT SUM(quantity) FROM sales_data WHERE year = $1), 0), 2) as market_share_pct
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
app.get('/api/models', authMiddleware, async (req, res) => {
    try {
        const { brand_id, category, drive_type, cabin_type, hp_min, hp_max } = req.query;
        let query = `SELECT m.*, b.name as brand_name, b.slug as brand_slug FROM tractor_models m JOIN brands b ON m.brand_id = b.id WHERE m.is_current_model = true`;
        const params = [];
        if (brand_id) { params.push(brand_id); query += ` AND m.brand_id = $${params.length}`; }
        if (category) { params.push(category); query += ` AND m.category = $${params.length}`; }
        if (drive_type) { params.push(drive_type); query += ` AND m.drive_type = $${params.length}`; }
        if (cabin_type) { params.push(cabin_type); query += ` AND m.cabin_type = $${params.length}`; }
        if (hp_min) { params.push(hp_min); query += ` AND m.horsepower >= $${params.length}`; }
        if (hp_max) { params.push(hp_max); query += ` AND m.horsepower <= $${params.length}`; }
        query += ' ORDER BY b.name, m.horsepower';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
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
        res.json(result.rows);
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
        res.json(result.rows);
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
        res.json(result.rows);
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
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// ============================================
// AI INSIGHTS
// ============================================
app.get('/api/insights', authMiddleware, async (req, res) => {
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
// SUBSCRIPTION & PAYMENT
// ============================================
app.get('/api/plans', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subscription_plans WHERE is_active = true ORDER BY price_monthly');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.get('/api/subscription', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, sp.name as plan_name, sp.features, sp.has_ai_insights, sp.has_competitor_analysis, sp.has_weather_data, sp.has_export
            FROM subscriptions s JOIN subscription_plans sp ON s.plan_id = sp.id
            WHERE s.user_id = $1 AND s.status = 'active'
            ORDER BY s.created_at DESC LIMIT 1
        `, [req.user.id]);
        res.json(result.rows[0] || null);
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
// DASHBOARD SUMMARY
// ============================================
app.get('/api/dashboard', authMiddleware, async (req, res) => {
    try {
        const userBrandId = req.user.brand_id;
        const { year } = req.query;
        const currentYear = year ? parseInt(year) : new Date().getFullYear();

        const [totalSales, brandSales, provinceCount, marketShare, topProvinces, monthlyTrend] = await Promise.all([
            pool.query('SELECT SUM(quantity) as total FROM sales_data WHERE year = $1', [currentYear]),
            userBrandId
                ? pool.query('SELECT SUM(quantity) as total FROM sales_data WHERE year = $1 AND brand_id = $2', [currentYear, userBrandId])
                : pool.query('SELECT SUM(quantity) as total FROM sales_data WHERE year = $1', [currentYear]),
            userBrandId
                ? pool.query('SELECT COUNT(DISTINCT province_id) as count FROM sales_data WHERE year = $1 AND brand_id = $2', [currentYear, userBrandId])
                : pool.query('SELECT COUNT(DISTINCT province_id) as count FROM sales_data WHERE year = $1', [currentYear]),
            userBrandId
                ? pool.query(`SELECT ROUND(SUM(CASE WHEN brand_id = $2 THEN quantity ELSE 0 END) * 100.0 / NULLIF(SUM(quantity), 0), 2) as share FROM sales_data WHERE year = $1`, [currentYear, userBrandId])
                : null,
            userBrandId
                ? pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_data s JOIN provinces p ON s.province_id = p.id WHERE s.year = $1 AND s.brand_id = $2 GROUP BY p.name ORDER BY total DESC LIMIT 10`, [currentYear, userBrandId])
                : pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_data s JOIN provinces p ON s.province_id = p.id WHERE s.year = $1 GROUP BY p.name ORDER BY total DESC LIMIT 10`, [currentYear]),
            userBrandId
                ? pool.query(`SELECT month, SUM(quantity) as total FROM sales_data WHERE year = $1 AND brand_id = $2 GROUP BY month ORDER BY month`, [currentYear, userBrandId])
                : pool.query(`SELECT month, SUM(quantity) as total FROM sales_data WHERE year = $1 GROUP BY month ORDER BY month`, [currentYear])
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
        const { email, password, full_name, role, brand_id, company_name, city } = req.body;
        const hash = await bcrypt.hash(password, 10);
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
        const hpRanges = ['0-50', '51-75', '76-100', '101-150', '150+'];
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
                        const seasonFactor = [0.6,0.7,1.0,1.2,1.1,0.9,0.8,0.7,0.9,1.0,0.8,0.5][month-1];
                        const qty = Math.max(1, Math.floor((Math.random()*10+2)*weight*seasonFactor));
                        placeholders.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9})`);
                        values.push(brand.id, prov.id, year, month, qty, cat, cabin, drive, hp, gear);
                        paramIdx += 10; salesCount++;

                        if (placeholders.length >= 200) {
                            await pool.query(`INSERT INTO sales_data (brand_id,province_id,year,month,quantity,category,cabin_type,drive_type,hp_range,gear_config) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
                            placeholders = []; values = []; paramIdx = 1;
                        }
                    }
                }
            }
            if (placeholders.length > 0) {
                await pool.query(`INSERT INTO sales_data (brand_id,province_id,year,month,quantity,category,cabin_type,drive_type,hp_range,gear_config) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
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

        // Temel verileri seed et (markalar, iller, planlar, admin)
        const brandCheck = await pool.query('SELECT COUNT(*) FROM brands');
        if (parseInt(brandCheck.rows[0].count) === 0) {
            console.log('🌱 Temel veriler seed ediliyor...');
            const { brands, provinces, subscriptionPlans } = require('./database/seed-data');
            const bcryptLib = require('bcryptjs');

            for (const brand of brands) {
                await pool.query(`INSERT INTO brands (name, slug, primary_color, secondary_color, accent_color, text_color, country_of_origin, parent_company) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                    [brand.name, brand.slug, brand.primary_color, brand.secondary_color, brand.accent_color, brand.text_color, brand.country_of_origin, brand.parent_company]);
            }
            for (const p of provinces) {
                await pool.query(`INSERT INTO provinces (name, plate_code, region, latitude, longitude, population) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                    [p.name, p.plate_code, p.region, p.lat, p.lng, p.pop]);
            }
            for (const plan of subscriptionPlans) {
                await pool.query(`INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, features, max_users, has_ai_insights, has_competitor_analysis, has_weather_data, has_export) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
                    [plan.name, plan.slug, plan.price_monthly, plan.price_yearly, plan.features, plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export]);
            }
            const hash = await bcryptLib.hash('admin2024', 10);
            await pool.query(`INSERT INTO users (email, password_hash, full_name, role) VALUES ('admin@traktorsektoranalizi.com', $1, 'Sistem Yöneticisi', 'admin') ON CONFLICT DO NOTHING`, [hash]);
            console.log('✅ Temel veriler seed edildi');
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
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ============================================
// START SERVER
// ============================================
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚜 Traktör Sektör Analizi sunucusu ${PORT} portunda çalışıyor`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        console.log(`🔗 n8n: http://localhost:5678`);
    });
});

process.on('SIGTERM', async () => {
    console.log('Sunucu kapatılıyor...');
    await pool.end();
    process.exit(0);
});
