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

// HP Segment Top 10 Marka
app.get('/api/sales/hp-top-brands', authMiddleware, async (req, res) => {
    try {
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

        // Son yılın ilk N ayı verisi: hp_range + marka bazlı
        const result = await pool.query(`
            SELECT s.hp_range, b.name as brand_name, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

        const result = await pool.query(`
            SELECT s.hp_range, p.name as province_name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
        const categories = ['bahce', 'tarla'];

        const result = await pool.query(`
            SELECT s.hp_range, s.category, b.name as brand_name, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
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
        const { year } = req.query;

        // Hedef yıl ve ay aralığı
        let targetYear, maxMonth;
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const dbMaxYear = parseInt(latestRes.rows[0].max_year);

        if (year && parseInt(year) < dbMaxYear) {
            // Geçmiş yıl: 12 ay tam veri
            targetYear = parseInt(year);
            maxMonth = 12;
        } else {
            // Son yıl veya belirtilmemiş: partial data
            targetYear = year ? parseInt(year) : dbMaxYear;
            const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [targetYear]);
            maxMonth = parseInt(latestMonthRes.rows[0]?.max_month || 12);
        }

        // İl bazlı toplam satış (sıralama için)
        const provTotals = await pool.query(`
            SELECT p.name as province_name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY p.name ORDER BY total DESC
        `, [targetYear, maxMonth]);

        // İl + marka bazlı detay
        const result = await pool.query(`
            SELECT p.name as province_name, b.name as brand_name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY p.name, b.name ORDER BY p.name, total DESC
        `, [targetYear, maxMonth]);

        const brandData = {};
        result.rows.forEach(r => {
            if (!brandData[r.province_name]) brandData[r.province_name] = [];
            brandData[r.province_name].push({ brand: r.brand_name, sales: parseInt(r.total) });
        });

        const provinces = provTotals.rows.map(p => {
            const all = brandData[p.province_name] || [];
            const provTotal = parseInt(p.total);
            const top10 = all.slice(0, 10).map(b => ({
                brand: b.brand,
                sales: b.sales,
                share: provTotal > 0 ? parseFloat((b.sales * 100 / provTotal).toFixed(1)) : 0
            }));
            return { province: p.province_name, total: provTotal, brands: top10 };
        });

        res.json({ year: targetYear, max_month: maxMonth, provinces });
    } catch (err) {
        console.error('Province top brands error:', err);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// HP Brand Matrix - HP segment bazlı tüm markalar (adet + %)
app.get('/api/sales/hp-brand-matrix', authMiddleware, async (req, res) => {
    try {
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);
        const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

        const allData = await pool.query(`
            SELECT s.hp_range, b.name as brand_name, s.year, s.month, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.hp_range IS NOT NULL
            GROUP BY s.hp_range, b.name, s.year, s.month
        `);

        const totalMarketData = await pool.query(`
            SELECT year, month, SUM(quantity) as total
            FROM sales_data WHERE hp_range IS NOT NULL
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
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
            FROM sales_data WHERE hp_range IS NOT NULL
            GROUP BY hp_range, year, month
        `);

        // Brand data
        let brandData = { rows: [] };
        if (brandId) {
            brandData = await pool.query(`
                SELECT hp_range, year, month, SUM(quantity) as total
                FROM sales_data WHERE hp_range IS NOT NULL AND brand_id = $1
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);
        const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
        const categories = ['bahce', 'tarla'];

        const allData = await pool.query(`
            SELECT category, hp_range, year, month, SUM(quantity) as total
            FROM sales_data WHERE hp_range IS NOT NULL
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        const hpOrder = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];

        const result = await pool.query(`
            SELECT s.hp_range, s.category, p.name as province_name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
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
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);
        const years = Array.from({ length: prevYear - minYear + 1 }, (_, i) => minYear + i);

        // Tüm veriler hp_range bazlı
        const allData = await pool.query(`
            SELECT hp_range, year, month, SUM(quantity) as total
            FROM sales_data
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

// İl bazlı satış verileri (filtreleme destekli)
app.get('/api/sales/by-province', authMiddleware, async (req, res) => {
    try {
        const { year, brand_id, cabin_type, drive_type, hp_range, gear_config } = req.query;
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
        if (userBrandId) { params.push(userBrandId); query += ` AND s.brand_id = $${params.length}`; }
        if (cabin_type) { params.push(cabin_type); query += ` AND s.cabin_type = $${params.length}`; }
        if (drive_type) { params.push(drive_type); query += ` AND s.drive_type = $${params.length}`; }
        if (hp_range) { params.push(hp_range); query += ` AND s.hp_range = $${params.length}`; }
        if (gear_config) { params.push(gear_config); query += ` AND s.gear_config = $${params.length}`; }
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
// REGIONAL MECHANIZATION INDEX
// ============================================
app.get('/api/sales/regional-index', authMiddleware, async (req, res) => {
    try {
        const { year, metric } = req.query;
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const targetYear = year ? parseInt(year) : maxYear;
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [targetYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);

        // Province info
        const provRes = await pool.query(`SELECT id, name, plate_code, region, latitude, longitude, population, agricultural_area_hectare, primary_crops, soil_type, climate_zone, annual_rainfall_mm, avg_temperature, elevation_m FROM provinces ORDER BY name`);

        // Sales by province with category, hp, drive, cabin breakdown
        const salesRes = await pool.query(`
            SELECT s.province_id, s.category, s.hp_range, s.drive_type, s.cabin_type, s.gear_config,
                   SUM(s.quantity) as total
            FROM sales_data s
            WHERE s.year = $1
            GROUP BY s.province_id, s.category, s.hp_range, s.drive_type, s.cabin_type, s.gear_config
        `, [targetYear]);

        // Yearly trend by province (last 3 years)
        const trendYears = [targetYear - 2, targetYear - 1, targetYear];
        const trendRes = await pool.query(`
            SELECT province_id, year, SUM(quantity) as total
            FROM sales_data WHERE year = ANY($1)
            GROUP BY province_id, year
        `, [trendYears]);
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
        const hpMidpoints = {'1-39':25,'40-49':45,'50-54':52,'55-59':57,'60-69':65,'70-79':75,'80-89':85,'90-99':95,'100-109':105,'110-119':115,'120+':130};

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
app.get('/api/sales/model-region', authMiddleware, async (req, res) => {
    try {
        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
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
        const modelRes = await pool.query(`SELECT m.id, m.brand_id, m.model_name, m.horsepower, m.hp_range, m.category, m.cabin_type, m.drive_type, m.gear_config, m.price_list_tl, b.name as brand_name, b.primary_color FROM tractor_models m JOIN brands b ON m.brand_id = b.id WHERE m.is_current_model = true ORDER BY b.name, m.horsepower`);

        // Sales by province, brand, year with details
        const salesRes = await pool.query(`
            SELECT s.province_id, s.brand_id, s.year, s.category, s.hp_range, s.cabin_type, s.drive_type, s.gear_config,
                   SUM(s.quantity) as total
            FROM sales_data s
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
                const brandModels = modelRes.rows.filter(m => m.brand_id == b.id && m.price_list_tl);
                const avgPrice = brandModels.length > 0 ? brandModels.reduce((s, m) => s + parseFloat(m.price_list_tl), 0) / brandModels.length : 0;
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
                    name: m.model_name, hp: parseFloat(m.horsepower), price: m.price_list_tl ? parseFloat(m.price_list_tl) : null,
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
// DYNAMIC BRAND COMPARISON
// ============================================
app.get('/api/sales/brand-compare', authMiddleware, async (req, res) => {
    try {
        const { brand1_id, brand2_id } = req.query;
        if (!brand1_id || !brand2_id) return res.status(400).json({ error: 'brand1_id ve brand2_id gerekli' });

        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [maxYear]);
        const maxMonth = parseInt(latestMonthRes.rows[0].max_month);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);
        const years = [];
        for (let y = minYear; y <= maxYear; y++) years.push(y);

        // Get brand info
        const brand1Res = await pool.query('SELECT id, name, primary_color, secondary_color FROM brands WHERE id = $1', [brand1_id]);
        const brand2Res = await pool.query('SELECT id, name, primary_color, secondary_color FROM brands WHERE id = $1', [brand2_id]);
        if (!brand1Res.rows[0] || !brand2Res.rows[0]) return res.status(404).json({ error: 'Marka bulunamadı' });

        const hpOrder = ['1-39','40-49','50-54','55-59','60-69','70-79','80-89','90-99','100-109','110-119','120+'];

        // Total market by year+month
        const marketRows = await pool.query(`SELECT year, month, SUM(quantity) as total FROM sales_data GROUP BY year, month`);
        const marketMap = {};
        marketRows.rows.forEach(r => { marketMap[`${r.year}_${r.month}`] = parseInt(r.total); });

        async function buildBrandData(brandId) {
            // Yearly+monthly sales
            const salesRows = await pool.query(`SELECT year, month, SUM(quantity) as total FROM sales_data WHERE brand_id = $1 GROUP BY year, month ORDER BY year, month`, [brandId]);
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
            const hpRows = await pool.query(`SELECT hp_range, SUM(quantity) as total FROM sales_data WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY hp_range ORDER BY total DESC`, [brandId, maxYear, maxMonth]);
            const hpDist = hpRows.rows.map(r => ({ hp: r.hp_range, qty: parseInt(r.total) }));
            const hpTotal = hpDist.reduce((s, h) => s + h.qty, 0);
            hpDist.forEach(h => h.pct = hpTotal > 0 ? (h.qty / hpTotal * 100) : 0);

            // Category split
            const catRows = await pool.query(`SELECT category, SUM(quantity) as total FROM sales_data WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY category`, [brandId, maxYear, maxMonth]);
            const categories = {};
            catRows.rows.forEach(r => { categories[r.category] = parseInt(r.total); });

            // Top 5 provinces
            const provRows = await pool.query(`SELECT p.name, SUM(s.quantity) as total FROM sales_data s JOIN provinces p ON s.province_id = p.id WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3 GROUP BY p.name ORDER BY total DESC LIMIT 5`, [brandId, maxYear, maxMonth]);
            const topProvinces = provRows.rows.map(r => ({ name: r.name, qty: parseInt(r.total) }));

            // Drive type split
            const driveRows = await pool.query(`SELECT drive_type, SUM(quantity) as total FROM sales_data WHERE brand_id = $1 AND year = $2 AND month <= $3 GROUP BY drive_type`, [brandId, maxYear, maxMonth]);
            const driveTypes = {};
            driveRows.rows.forEach(r => { driveTypes[r.drive_type] = parseInt(r.total); });

            // Models with prices from tractor_models
            const modelRows = await pool.query(`SELECT model_name, horsepower, price_list_tl, category, cabin_type, drive_type FROM tractor_models WHERE brand_id = $1 AND is_current_model = true ORDER BY horsepower`, [brandId]);
            const models = modelRows.rows.map(r => ({
                name: r.model_name,
                hp: parseFloat(r.horsepower),
                price: r.price_list_tl ? parseFloat(r.price_list_tl) : null,
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
// GROQ AI ANALYSIS
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.post('/api/ai/analyze', authMiddleware, async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY tanımlı değil' });

        const { type, context } = req.body;
        if (!type) return res.status(400).json({ error: 'Analiz tipi gerekli' });

        // Build prompt based on analysis type
        let systemPrompt = `Sen Türkiye traktör sektörü konusunda uzman bir analistsin. Verilen verileri analiz edip Türkçe olarak profesyonel, derinlikli, stratejik öneriler içeren raporlar hazırlıyorsun. Yanıtlarında markdown formatı kullan. Kısa ve öz ol ama derinlikli analiz yap. Sayısal verilerle destekle.`;

        let userPrompt = '';

        if (type === 'brand-region') {
            // Brand-specific regional analysis
            const { brandName, provinces, models, totalSales, totalRevenue } = context;
            const topProvStr = (provinces || []).slice(0, 10).map((p, i) =>
                `${i+1}. ${p.name} (${p.region}): ${p.total} adet, Pazar payı: ${p.marketShareCurr}%, YoY: ${p.yoyGrowth}%, Bahçe: ${(p.bahce/(p.total||1)*100).toFixed(0)}%, Toprak: ${p.soil_type || '-'}, İklim: ${p.climate_zone || '-'}, Ürünler: ${Array.isArray(p.primary_crops) ? p.primary_crops.join(', ') : (p.primary_crops || '-')}, Tahmini Ciro: ${Math.round(p.estimatedRevenue/1000000)}M TL`
            ).join('\n');
            const modelStr = (models || []).map(m => `${m.name} (${m.hp}HP, ${m.category}, ${m.price ? Math.round(m.price/1000)+'B TL' : '-'})`).join(', ');

            userPrompt = `**${brandName}** markası için bölgesel strateji analizi yap.

TOPLAM VERİ:
- Toplam satış: ${totalSales} adet
- Tahmini toplam ciro: ${Math.round(totalRevenue/1000000)}M TL
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

        } else if (type === 'regional-index') {
            const { year, provinces: provs } = context;
            const top10 = (provs || []).slice(0, 15).map((p, i) =>
                `${i+1}. ${p.name} (${p.region}): ${p.total} adet, Bahçe: ${p.bahceRatio?.toFixed(0)}%, Ort.HP: ${p.avgHp}, 4WD: ${p.ratio4wd?.toFixed(0)}%, Mek.İndeks: ${p.mechIndex}, YoY: ${p.yoyGrowth}%, Toprak: ${p.soil_type || '-'}`
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

        } else if (type === 'brand-compare') {
            const { brand1, brand2, data1, data2, maxYear } = context;
            userPrompt = `**${brand1}** vs **${brand2}** marka karşılaştırma analizi yap.

${brand1}: ${maxYear} satış: ${data1.currPartial} adet, YoY: ${data1.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data1.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data1.avgPrice/1000)}B TL, Model sayısı: ${data1.models?.length}
${brand2}: ${maxYear} satış: ${data2.currPartial} adet, YoY: ${data2.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data2.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data2.avgPrice/1000)}B TL, Model sayısı: ${data2.models?.length}

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
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
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
