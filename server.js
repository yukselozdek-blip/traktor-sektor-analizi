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
        const currentYear = new Date().getFullYear();

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

        // Check if data exists, seed if not
        const brandCheck = await pool.query('SELECT COUNT(*) FROM brands');
        const salesCheck = await pool.query('SELECT COUNT(*) FROM sales_data');
        const needsFullSeed = parseInt(brandCheck.rows[0].count) === 0;
        const needsSalesData = parseInt(salesCheck.rows[0].count) === 0;

        if (needsFullSeed || needsSalesData) {
            console.log('🌱 İlk kurulum - seed çalıştırılıyor...');
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
            // Admin kullanıcı
            const hash = await bcryptLib.hash('admin2024', 10);
            await pool.query(`INSERT INTO users (email, password_hash, full_name, role) VALUES ('admin@traktorsektoranalizi.com', $1, 'Sistem Yöneticisi', 'admin') ON CONFLICT DO NOTHING`, [hash]);

            // Demo kullanıcılar (her marka için)
            console.log('🌱 Demo kullanıcılar oluşturuluyor...');
            const demoHash = await bcryptLib.hash('demo2024', 10);
            const brandRows = await pool.query('SELECT id, name, slug FROM brands ORDER BY id');
            for (const brand of brandRows.rows) {
                await pool.query(`INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name) VALUES ($1, $2, $3, 'brand_user', $4, $5) ON CONFLICT DO NOTHING`,
                    [`demo@${brand.slug}.com`, demoHash, `${brand.name} Demo Kullanıcı`, brand.id, `${brand.name} Yetkili Bayii`]);
            }

            // Satış verileri oluştur (2020-2025)
            console.log('🌱 Satış verileri oluşturuluyor...');
            const provRows = await pool.query('SELECT id FROM provinces ORDER BY id');
            const categories = ['tarla', 'bahce'];
            const cabinTypes = ['kabinli', 'rollbar'];
            const driveTypes = ['2WD', '4WD'];
            const hpRanges = ['0-50', '51-75', '76-100', '101-150', '150+'];
            const gearConfigs = ['8+2', '8+8', '12+12', '16+16', '32+32', 'CVT'];

            // Marka ağırlıkları (gerçekçi pazar payı simülasyonu)
            const brandWeights = {
                'new-holland': 2.5, 'massey-ferguson': 2.0, 'john-deere': 1.8, 'case-ih': 1.5,
                'tumosan': 1.4, 'hattat': 1.3, 'erkunt': 1.2, 'basak': 1.1,
                'deutz-fahr': 1.0, 'kubota': 0.9, 'landini': 0.8, 'same': 0.7,
                'fendt': 0.6, 'claas': 0.5, 'valtra': 0.4, 'solis': 0.5,
                'antonio-carraro': 0.3, 'mccormick': 0.3, 'fiat': 0.2, 'yanmar': 0.2,
                'ferrari-tractors': 0.15, 'karatas': 0.15, 'kioti': 0.2, 'tafe': 0.15
            };

            let salesCount = 0;
            const batchSize = 500;
            let values = [];
            let placeholders = [];
            let paramIdx = 1;

            for (const brand of brandRows.rows) {
                const weight = brandWeights[brand.slug] || 0.5;
                const numProvinces = Math.min(81, Math.floor(20 + weight * 25));
                const shuffled = [...provRows.rows].sort(() => Math.random() - 0.5);
                const selectedProvs = shuffled.slice(0, numProvinces);

                for (const prov of selectedProvs) {
                    for (let year = 2020; year <= 2025; year++) {
                        for (let month = 1; month <= 12; month++) {
                            if (year === 2025 && month > 3) continue;
                            const cat = categories[Math.floor(Math.random() * categories.length)];
                            const cabin = cabinTypes[Math.floor(Math.random() * cabinTypes.length)];
                            const drive = driveTypes[Math.floor(Math.random() * driveTypes.length)];
                            const hp = hpRanges[Math.floor(Math.random() * hpRanges.length)];
                            const gear = gearConfigs[Math.floor(Math.random() * gearConfigs.length)];
                            const seasonFactor = [0.6, 0.7, 1.0, 1.2, 1.1, 0.9, 0.8, 0.7, 0.9, 1.0, 0.8, 0.5][month - 1];
                            const qty = Math.max(1, Math.floor((Math.random() * 10 + 2) * weight * seasonFactor));

                            placeholders.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9})`);
                            values.push(brand.id, prov.id, year, month, qty, cat, cabin, drive, hp, gear);
                            paramIdx += 10;
                            salesCount++;

                            if (placeholders.length >= batchSize) {
                                await pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
                                placeholders = []; values = []; paramIdx = 1;
                            }
                        }
                    }
                }
            }
            // Flush remaining
            if (placeholders.length > 0) {
                await pool.query(`INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range, gear_config) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`, values);
            }
            console.log(`✅ ${salesCount} satış kaydı oluşturuldu`);
            console.log('✅ Seed tamamlandı');
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
