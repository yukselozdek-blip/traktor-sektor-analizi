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
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const WHATSAPP_QUERY_API_KEY = process.env.WHATSAPP_QUERY_API_KEY || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const N8N_WHATSAPP_PROCESSOR_URL = (
    process.env.N8N_WHATSAPP_PROCESSOR_URL
    || (process.env.RAILWAY_SERVICE_N8N_URL ? `https://${process.env.RAILWAY_SERVICE_N8N_URL}/webhook/whatsapp-sales-assistant-process-v4` : '')
).replace(/\/$/, '');

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
        return `${year} (${MONTH_NAMES_TR[0]}-${MONTH_NAMES_TR[latestMonth - 1]} donemi)`;
    }
    if (monthCount > 0 && monthCount < 12) {
        return `${year} (${monthCount} ay kayitli)`;
    }
    return `${year}`;
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
    return 'Soruyu anlayamadim. Ornekler: "2024 yilinda Tumosan kac traktor satti?" veya "2023 yili Tumosan ile Basak karsilastir".';
}

async function callGroqJson(systemPrompt, userPrompt) {
    if (!GROQ_API_KEY) return null;

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
            temperature: 0.1,
            max_tokens: 500,
            response_format: { type: 'json_object' }
        })
    });

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
    if (!GROQ_API_KEY) return null;

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
    const latestYearRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
    const latestYear = parseInt(latestYearRes.rows[0]?.max_year, 10);
    if (!latestYear) return null;

    const latestMonthRes = await pool.query('SELECT MAX(month) as max_month FROM sales_data WHERE year = $1', [latestYear]);
    return {
        year: latestYear,
        month: parseInt(latestMonthRes.rows[0]?.max_month, 10) || 0
    };
}

async function buildBrandYearTotalAnswer(brand, year, latestPeriod) {
    const [brandSalesRes, totalSalesRes, rankRes] = await Promise.all([
        pool.query(`
            SELECT COALESCE(SUM(quantity), 0) as total_sales, COUNT(DISTINCT month) as month_count
            FROM sales_data
            WHERE brand_id = $1 AND year = $2
        `, [brand.id, year]),
        pool.query(`
            SELECT COALESCE(SUM(quantity), 0) as total_sales
            FROM sales_data
            WHERE year = $1
        `, [year]),
        pool.query(`
            WITH yearly_sales AS (
                SELECT brand_id, SUM(quantity) as total_sales
                FROM sales_data
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
            answer: `${year} icin ${brand.name} markasina ait satis kaydi bulunamadi.`,
            data: { brand: brand.name, year, total_sales: 0 }
        };
    }

    const share = totalMarketSales > 0 ? (brandSales * 100) / totalMarketSales : 0;
    const periodLabel = formatPeriodLabel(year, monthCount, latestPeriod?.year, latestPeriod?.month);
    const rankText = brandRank > 0 ? ` Yil siralamasinda ${brandRank}. sirada.` : '';

    return {
        ok: true,
        intent: 'brand_year_total',
        answer: `${periodLabel} icin ${brand.name} toplam ${formatNumberTR(brandSales)} traktor satti. Pazar payi %${formatShare(share)}.${rankText}`,
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
        pool.query('SELECT COALESCE(SUM(quantity), 0) as total_sales FROM sales_data WHERE year = $1', [year])
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

async function resolveAssistantQuestion(question) {
    const [brands, latestPeriod] = await Promise.all([
        getBrandCatalog(),
        getLatestSalesPeriod()
    ]);

    if (!latestPeriod) {
        return {
            ok: false,
            answer: 'Henuz satis verisi bulunmuyor. Once veritabanina satis kaydi aktarilmali.',
            intent: 'no_data'
        };
    }

    const years = extractYears(question);
    const heuristicBrands = findBrandsInQuestion(question, brands);
    const groqQuery = await inferSalesQueryWithGroq(question, brands, latestPeriod);
    const targetYear = groqQuery?.year || years[0] || latestPeriod.year;
    const matchedBrands = groqQuery?.brands?.length ? groqQuery.brands : heuristicBrands;
    const compareMode = groqQuery?.intent
        ? groqQuery.intent === 'brand_year_compare'
        : isComparisonQuestion(question, matchedBrands);

    if (groqQuery?.intent === 'market_overview' || (!matchedBrands.length && /pazar|market|lider mark|genel ozet|özet|ozet|top marka|hp/i.test(question))) {
        const report = await buildMarketOverviewData(targetYear, latestPeriod);
        return {
            ok: true,
            intent: 'market_overview',
            answer: buildMarketOverviewMessage(report),
            parser: groqQuery?.intent ? 'groq' : 'rules',
            report_url: getPublicUrl(`/public/reports/market?year=${targetYear}`),
            data: report
        };
    }

    if (compareMode) {
        if (matchedBrands.length < 2) {
            return {
                ok: false,
                answer: 'Karsilastirma icin iki marka belirtin. Ornek: "2023 yili Tumosan ile Basak karsilastir".',
                intent: 'brand_year_compare',
                parser: groqQuery?.intent ? 'groq' : 'rules'
            };
        }

        const report = await buildBrandCompareExecutiveData(matchedBrands.slice(0, 2), targetYear, latestPeriod);
        return {
            ok: true,
            intent: 'brand_year_compare',
            answer: buildBrandCompareMessage(report),
            question,
            report_url: getPublicUrl(`/public/reports/compare?brand1=${encodeURIComponent(report.first.brand.slug)}&brand2=${encodeURIComponent(report.second.brand.slug)}&year=${targetYear}`),
            parser: groqQuery?.intent ? 'groq' : 'rules',
            used_default_year: years.length === 0,
            available_latest_year: latestPeriod.year,
            available_latest_month: latestPeriod.month,
            data: report
        };
    }

    if (groqQuery?.intent === 'unsupported') {
        return {
            ok: false,
            answer: 'Bu soruyu anladim ancak su an sadece tek marka yillik satis ve iki marka yillik karsilastirma cevaplayabiliyorum.',
            intent: 'unsupported',
            parser: 'groq'
        };
    }

    if (matchedBrands.length === 0) {
        return {
            ok: false,
            answer: buildUsageAnswer(),
            intent: 'unknown'
        };
    }

    const report = await buildBrandExecutiveData(matchedBrands[0], targetYear, latestPeriod);
    return {
        ok: true,
        intent: 'brand_year_total',
        answer: buildBrandExecutiveMessage(report),
        question,
        report_url: getPublicUrl(`/public/reports/brand?brand=${encodeURIComponent(report.brand.slug)}&year=${targetYear}`),
        parser: groqQuery?.intent ? 'groq' : 'rules',
        used_default_year: years.length === 0,
        available_latest_year: latestPeriod.year,
        available_latest_month: latestPeriod.month,
        data: report
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
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE brand_id = $1 AND year = $2 AND month <= $3`, [brand.id, year, limitMonth]),
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE year = $1 AND month <= $2`, [year, limitMonth]),
        pool.query(`
            WITH yearly_sales AS (
                SELECT brand_id, SUM(quantity) as total_sales
                FROM sales_data
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
            FROM sales_data
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY month ORDER BY month
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT p.name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
            WHERE s.brand_id = $1 AND s.year = $2 AND s.month <= $3
            GROUP BY p.name ORDER BY total DESC LIMIT 5
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT hp_range, SUM(quantity) as total
            FROM sales_data
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY hp_range ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT category, SUM(quantity) as total
            FROM sales_data
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY category ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT drive_type, SUM(quantity) as total
            FROM sales_data
            WHERE brand_id = $1 AND year = $2 AND month <= $3
            GROUP BY drive_type ORDER BY total DESC
        `, [brand.id, year, limitMonth]),
        pool.query(`
            SELECT model_name, horsepower, price_list_tl
            FROM tractor_models
            WHERE brand_id = $1 AND is_current_model = true
            ORDER BY horsepower
        `, [brand.id]),
        pool.query(`
            SELECT year, SUM(quantity) as total
            FROM sales_data
            WHERE brand_id = $1 AND year IN ($2, $3, $4) AND month <= $5
            GROUP BY year ORDER BY year
        `, [brand.id, year - 2, year - 1, year, limitMonth]),
        pool.query(`
            SELECT COUNT(DISTINCT province_id) as active_provinces
            FROM sales_data
            WHERE brand_id = $1 AND year = $2 AND month <= $3
        `, [brand.id, year, limitMonth])
    ]);

    const currentSales = parseInt(salesRes.rows[0]?.total_sales || 0, 10);
    const marketSales = parseInt(marketRes.rows[0]?.total_sales || 0, 10);
    const marketShare = marketSales > 0 ? currentSales * 100 / marketSales : 0;
    const rank = parseInt(rankRes.rows[0]?.rank || 0, 10);

    const prevRes = await pool.query(
        `SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE brand_id = $1 AND year = $2 AND month <= $3`,
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
        price: row.price_list_tl ? parseFloat(row.price_list_tl) : null
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
        'Yalnizca JSON dondur. { "summary": "...", "recommendation": "..." } formatini kullan. Turkce, yonetici dili kullan. Sayisal veriyi yorumla, 2 kisa cumlelik ozet ve 1 kisa aksiyon onerisi ver. Aksiyon onerisi markanin kendi saha, segment, fiyat, il veya portfoy hamlelerine odaklansin; rakiple isbirligi onerme.',
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
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE year = $1 AND month <= $2`, [year, limitMonth]),
        pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE year = $1 AND month <= $2`, [prevYear, limitMonth]),
        pool.query(`
            SELECT b.name, SUM(s.quantity) as total
            FROM sales_data s JOIN brands b ON s.brand_id = b.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY b.name ORDER BY total DESC LIMIT 8
        `, [year, limitMonth]),
        pool.query(`
            SELECT p.name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
            WHERE s.year = $1 AND s.month <= $2
            GROUP BY p.name ORDER BY total DESC LIMIT 8
        `, [year, limitMonth]),
        pool.query(`
            SELECT hp_range, SUM(quantity) as total
            FROM sales_data
            WHERE year = $1 AND month <= $2
            GROUP BY hp_range ORDER BY total DESC LIMIT 6
        `, [year, limitMonth]),
        pool.query(`
            SELECT category, SUM(quantity) as total
            FROM sales_data
            WHERE year = $1 AND month <= $2
            GROUP BY category ORDER BY total DESC
        `, [year, limitMonth]),
        pool.query(`
            SELECT COUNT(DISTINCT province_id) as active_provinces
            FROM sales_data
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
        'Yalnizca JSON dondur. { "summary": "...", "recommendation": "..." } formatini kullan. Turkce, yonetici dili kullan. 2 kisa cumlelik pazar yorumu ve 1 kisa aksiyon onerisi ver. Oneri, pazar konsantrasyonu, bolgesel firsat veya segment kaymasi gibi icgoru odakli olsun; rakiplerle isbirligi onermesin.',
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
                FROM sales_data
                WHERE year IN ($1, $2) AND month <= $3
                GROUP BY year
            ),
            brand_sales AS (
                SELECT brand_id, year, SUM(quantity) as total
                FROM sales_data
                WHERE brand_id = ANY($4::int[]) AND year IN ($1, $2) AND month <= $3
                GROUP BY brand_id, year
            )
            SELECT * FROM brand_sales
        `, [year, year - 1, limitMonth, brands.map(item => item.id)])
    ]);

    const prevRows = benchmarkRes.rows.filter(row => Number(row.year) === year - 1);
    const currRows = benchmarkRes.rows.filter(row => Number(row.year) === year);

    const marketRes = await pool.query(`SELECT COALESCE(SUM(quantity),0) as total_sales FROM sales_data WHERE year = $1 AND month <= $2`, [year, limitMonth]);
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
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
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
        'Yalnizca JSON dondur. { "summary": "...", "recommendation": "..." } formatini kullan. Turkce, ust yonetime uygun dil kullan. 2 kisa cumlelik rekabet yorumu ve 1 aksiyon onerisi ver. Oneri, il/segment/fiyat farklari uzerinden somut bir takip veya savunma hamlesi icersin; genel gecis cumlesi veya rakiple isbirligi onermesin.',
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
        `*Yonetici Brifingi | ${report.brand.name} | ${report.periodLabel}*`,
        `*Pazar Konumu*`,
        `- Hacim: ${formatNumberTR(report.currentSales)} adet | Pay: %${formatShare(report.marketShare)} | Sira: ${report.rank || '-'}`,
        `- Yillik momentum: ${formatPctSigned(report.yoy)} | Aktif il: ${formatNumberTR(report.activeProvinceCount)}`,
        `*Momentum ve Saha*`,
        `- 3 yillik iz: ${trendSummary || '-'}`,
        `- Tepe ay: ${report.peakMonth ? `${MONTH_NAMES_TR[report.peakMonth.month - 1]} (${formatNumberTR(report.peakMonth.total)})` : '-'}`,
        `- En guclu iller: ${buildTopList(report.topProvinces, item => `${item.name} (${formatNumberTR(item.total)})`) || '-'}`,
        `*Segment ve Portfoy*`,
        `- Lider HP bandi: ${dominantHp ? `${dominantHp.name} (${formatNumberTR(dominantHp.total)})` : '-'}`,
        `- Tarla/Bahce dengesi: ${formatNumberTR(report.categories.tarla || 0)} / ${formatNumberTR(report.categories.bahce || 0)}`,
        `- 4WD penetrasyonu: %${formatShare(report.drive4wdRatio)}`,
        `- Portfoy: ${report.models.length} aktif model | Fiyat koridoru: ${formatCurrencyShort(report.minPrice)} - ${formatCurrencyShort(report.maxPrice)}`,
        `- Ortalama liste fiyatı: ${formatCurrencyShort(report.avgPrice)}`,
        report.commentary ? `*Yonetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli yonetici paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function buildBrandCompareMessage(report) {
    const reportUrl = getPublicUrl(`/public/reports/compare?brand1=${encodeURIComponent(report.first.brand.slug)}&brand2=${encodeURIComponent(report.second.brand.slug)}&year=${report.year}`);
    return [
        `*Rekabet Brifingi | ${report.first.brand.name} vs ${report.second.brand.name} | ${report.periodLabel}*`,
        `*Skor Karti*`,
        `- ${report.first.brand.name}: ${formatNumberTR(report.first.currentSales)} adet | Pay %${formatShare(report.first.marketShare)} | Degisim ${formatPctSigned(report.first.yoy)}`,
        `- ${report.second.brand.name}: ${formatNumberTR(report.second.currentSales)} adet | Pay %${formatShare(report.second.marketShare)} | Degisim ${formatPctSigned(report.second.yoy)}`,
        `- Lider: ${report.leader.brand.name} | Hacim farki: ${formatNumberTR(report.difference)} adet | Pay farki: ${formatShare(report.shareGap)} puan`,
        `*Saha ve Rekabet*`,
        `- Il ustunlugu: ${report.first.brand.name} ${report.provinceWins.first} il, ${report.second.brand.name} ${report.provinceWins.second} il`,
        `- Kritik savas alanlari: ${buildTopList(report.provinceLead, item => `${item.name} (${formatNumberTR(item.gap)})`) || 'Il bazli fark verisi yok'}`,
        `*Segment ve Fiyatlama*`,
        `- ${report.first.brand.name} lider HP: ${buildTopList(report.first.hpSegments, item => `${item.name}`, 2) || '-'}`,
        `- ${report.second.brand.name} lider HP: ${buildTopList(report.second.hpSegments, item => `${item.name}`, 2) || '-'}`,
        `- Ortalama liste fiyatlari: ${report.first.brand.name} ${formatCurrencyShort(report.first.avgPrice)} | ${report.second.brand.name} ${formatCurrencyShort(report.second.avgPrice)} | Fark ${formatCurrencyShort(report.priceGap)}`,
        report.commentary ? `*Yonetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli rekabet paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function buildMarketOverviewMessage(report) {
    const reportUrl = getPublicUrl(`/public/reports/market?year=${report.year}`);
    return [
        `*Pazar Bulteni | ${report.periodLabel}*`,
        `*Ust Duzey Gosterge Seti*`,
        `- Toplam pazar: ${formatNumberTR(report.currentSales)} adet | Yillik degisim: ${formatPctSigned(report.yoy)}`,
        `- Aktif il: ${formatNumberTR(report.activeProvinceCount)} | Top 3 marka konsantrasyonu: %${formatShare(report.top3Share)}`,
        `*Liderlik Tablosu*`,
        `- Markalar: ${buildTopList(report.topBrands, item => `${item.name} (${formatNumberTR(item.total)})`, 5) || '-'}`,
        `- Iller: ${buildTopList(report.topProvinces, item => `${item.name} (${formatNumberTR(item.total)})`, 5) || '-'}`,
        `*Talep Profili*`,
        `- HP segmentleri: ${buildTopList(report.hpSegments, item => `${item.name} (${formatNumberTR(item.total)})`, 4) || '-'}`,
        `- Kategori resmi: ${buildTopList(report.categories, item => `${item.name} (${formatNumberTR(item.total)})`, 3) || '-'}`,
        report.commentary ? `*Yonetici Notu*\n${report.commentary}` : '',
        reportUrl ? `*Grafikli pazar paneli:* ${reportUrl}` : ''
    ].filter(Boolean).join('\n');
}

function renderBrandExecutiveHtml(report) {
    const monthlySvg = buildLineTrendSvg(report.monthly.map(item => ({ label: item.label, value: item.total })), { color: '#2457C5' });
    const yearlySvg = buildMiniColumnSvg(report.yearlyTrend.map(item => ({ label: String(item.year), value: item.total })), { color: '#A72626' });
    const provinceSvg = buildBarChartSvg(report.topProvinces.map(item => ({ label: item.name, value: item.total })), { color: '#0F8F6E' });
    const hpDonut = buildDonutSvg(report.hpSegments.slice(0, 5).map(item => ({ label: item.name, value: item.total })), { size: 260 });
    return wrapReportHtml(
        `${report.brand.name} Yonetici Raporu`,
        `${report.periodLabel} | Satis, pazar payi, segment, il dagilimi ve portfoy gorunumu`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">Satis</div><div class="value">${formatNumberTR(report.currentSales)}</div></div>
                <div class="kpi"><div class="label">Pazar Payi</div><div class="value">%${formatShare(report.marketShare)}</div></div>
                <div class="kpi"><div class="label">Siralama</div><div class="value">${report.rank || '-'}</div></div>
                <div class="kpi"><div class="label">Yillik Degisim</div><div class="value">${formatPctSigned(report.yoy)}</div></div>
            </div>`,
            `<section class="section"><h2>Yonetici Ozeti</h2><p>${escapeHtml(report.commentary || `${report.brand.name}, ${report.periodLabel} doneminde ${formatNumberTR(report.currentSales)} adet satis ve %${formatShare(report.marketShare)} pazar payina ulasmistir.`)}</p></section>`,
            `<section class="section"><h2>Momentum Paneli</h2><div class="split"><div class="chart">${monthlySvg}</div><div class="chart">${yearlySvg}</div></div></section>`,
            `<section class="section"><h2>Bolgesel Guc</h2><div class="chart">${provinceSvg}</div></section>`,
            `<section class="section"><h2>Segment ve Portfoy Mimarisi</h2>
                <div class="split">
                    <div class="chart">${hpDonut}</div>
                    <div class="list-grid">
                        <div class="pill"><span class="mini">Lider HP</span><strong>${escapeHtml(report.hpSegments[0]?.name || '-')}</strong></div>
                        <div class="pill"><span class="mini">Tarla / Bahce</span><strong>${formatNumberTR(report.categories.tarla || 0)} / ${formatNumberTR(report.categories.bahce || 0)}</strong></div>
                        <div class="pill"><span class="mini">4WD Penetrasyonu</span><strong>%${formatShare(report.drive4wdRatio)}</strong></div>
                        <div class="pill"><span class="mini">Aktif Il</span><strong>${formatNumberTR(report.activeProvinceCount)}</strong></div>
                        <div class="pill"><span class="mini">Aktif Model</span><strong>${report.models.length}</strong></div>
                        <div class="pill"><span class="mini">Fiyat Koridoru</span><strong>${escapeHtml(formatCurrencyShort(report.minPrice))} - ${escapeHtml(formatCurrencyShort(report.maxPrice))}</strong></div>
                    </div>
                </div>
            </section>`,
            `<section class="section"><h2>Ticari Notlar</h2>
                <div class="split">
                    <div class="note"><strong>Tepe Ay</strong>${report.peakMonth ? `${MONTH_NAMES_TR[report.peakMonth.month - 1]} ayinda ${formatNumberTR(report.peakMonth.total)} adet ile zirve goruldu.` : 'Yeterli aylik veri bulunamadi.'}</div>
                    <div class="note"><strong>Urun Mimari</strong>${report.models.length ? `${report.models.length} aktif model icinde ortalama liste fiyati ${escapeHtml(formatCurrencyShort(report.avgPrice))} seviyesinde.` : 'Portfoy verisi sinirli.'}</div>
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
        { label: 'Digerleri', value: Math.max(report.marketSales - report.first.currentSales - report.second.currentSales, 0) }
    ], { size: 260 });
    return wrapReportHtml(
        `${report.first.brand.name} vs ${report.second.brand.name}`,
        `${report.periodLabel} | Rekabet, il dagilimi, segment ve portfoy karsilastirmasi`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">${escapeHtml(report.first.brand.name)}</div><div class="value">${formatNumberTR(report.first.currentSales)}</div></div>
                <div class="kpi"><div class="label">${escapeHtml(report.second.brand.name)}</div><div class="value">${formatNumberTR(report.second.currentSales)}</div></div>
                <div class="kpi"><div class="label">Lider</div><div class="value">${escapeHtml(report.leader.brand.name)}</div></div>
                <div class="kpi"><div class="label">Fark</div><div class="value">${formatNumberTR(report.difference)}</div></div>
            </div>`,
            `<section class="section"><h2>Yonetici Ozeti</h2><p>${escapeHtml(report.commentary || `${report.leader.brand.name}, ${report.periodLabel} doneminde rakibine gore daha guclu bir performans sergilemistir.`)}</p></section>`,
            `<section class="section"><h2>Rekabet Skor Karti</h2><div class="split"><div class="chart">${scoreSvg}</div><div class="chart">${shareDonut}</div></div></section>`,
            `<section class="section"><h2>Il Bazli Rekabet Boslugu</h2><div class="chart">${provinceSvg}</div></section>`,
            `<section class="section"><h2>Trend ve Portfoy</h2>
                <div class="split">
                    <div class="chart">${trendSvg}</div>
                    <div class="list-grid">
                        <div class="pill"><span class="mini">Il Ustunlugu</span><strong>${escapeHtml(report.first.brand.name)} ${report.provinceWins.first} | ${escapeHtml(report.second.brand.name)} ${report.provinceWins.second}</strong></div>
                        <div class="pill"><span class="mini">Pay Farki</span><strong>${formatShare(report.shareGap)} puan</strong></div>
                        <div class="pill"><span class="mini">Momentum Farki</span><strong>${formatShare(report.yoyGap)} puan</strong></div>
                        <div class="pill"><span class="mini">Fiyat Farki</span><strong>${escapeHtml(formatCurrencyShort(report.priceGap))}</strong></div>
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
        { label: 'Digerleri', value: Math.max(report.currentSales - Math.round(report.currentSales * report.top3Share / 100), 0) }
    ], { size: 250, colors: ['#2457C5', '#DCE4F2'] });
    return wrapReportHtml(
        `Turkiye Traktor Pazari`,
        `${report.periodLabel} | Lider markalar, il dagilimi ve HP segment resmi`,
        [
            `<div class="grid">
                <div class="kpi"><div class="label">Toplam Pazar</div><div class="value">${formatNumberTR(report.currentSales)}</div></div>
                <div class="kpi"><div class="label">Yillik Degisim</div><div class="value">${formatPctSigned(report.yoy)}</div></div>
                <div class="kpi"><div class="label">Lider Marka</div><div class="value">${escapeHtml(report.topBrands[0]?.name || '-')}</div></div>
                <div class="kpi"><div class="label">Lider Il</div><div class="value">${escapeHtml(report.topProvinces[0]?.name || '-')}</div></div>
            </div>`,
            `<section class="section"><h2>Yonetici Ozeti</h2><p>${escapeHtml(report.commentary || `${report.periodLabel} doneminde pazar hacmi ${formatNumberTR(report.currentSales)} adede ulasmistir.`)}</p></section>`,
            `<section class="section"><h2>Pazar Konsantrasyonu</h2><div class="split"><div class="chart">${brandsSvg}</div><div class="chart">${concentrationDonut}</div></div></section>`,
            `<section class="section"><h2>Talep Segmentasyonu</h2><div class="split"><div class="chart">${hpSvg}</div><div class="list-grid">${report.categories.map(item => `<div class="pill"><span class="mini">${escapeHtml(item.name)}</span><strong>${formatNumberTR(item.total)} adet</strong></div>`).join('')}</div></div></section>`,
            `<section class="section"><h2>Lider Iller</h2><ul>${report.topProvinces.map(item => `<li>${escapeHtml(item.name)}: ${formatNumberTR(item.total)} adet</li>`).join('')}</ul><p style="margin-top:14px;">Aktif il sayisi: <strong>${formatNumberTR(report.activeProvinceCount)}</strong></p></section>`
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

        const result = await resolveAssistantQuestion(question);
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
    res.status(200).json({ received: true });

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value || {};
        const message = value.messages?.[0];

        if (!message || message.type !== 'text') return;

        const question = message.text?.body?.trim();
        const from = message.from;
        const messageId = message.id;
        const profileName = value.contacts?.[0]?.profile?.name || null;
        if (!question || !from) return;

        try {
            if (await forwardWhatsAppEventToN8n({
                question,
                from,
                message_id: messageId,
                profile_name: profileName
            })) {
                return;
            }
        } catch (forwardErr) {
            console.error('WhatsApp webhook n8n forward error, falling back to direct response:', forwardErr.message);
        }

        const result = await resolveAssistantQuestion(question);
        await sendWhatsAppTextMessage(from, result.answer || 'Sorunuz islenemedi.');
    } catch (err) {
        console.error('WhatsApp webhook error:', err);
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
// TECHNICAL BENCHMARKING & GAP ANALYSIS
// ============================================
app.get('/api/sales/benchmark', authMiddleware, async (req, res) => {
    try {
        const { brand1_id, brand2_id } = req.query;
        if (!brand1_id || !brand2_id) return res.status(400).json({ error: 'brand1_id ve brand2_id gerekli' });

        const latestRes = await pool.query('SELECT MAX(year) as max_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year);
        const mmRes = await pool.query('SELECT MAX(month) as mm FROM sales_data WHERE year=$1', [maxYear]);
        const maxMonth = parseInt(mmRes.rows[0].mm);
        const prevYear = maxYear - 1;
        const minYearRes = await pool.query('SELECT MIN(year) as min_year FROM sales_data');
        const minYear = parseInt(minYearRes.rows[0].min_year);
        const years = [];
        for (let y = minYear; y <= maxYear; y++) years.push(y);

        const hpMidpoints = {'1-39':25,'40-49':45,'50-54':52,'55-59':57,'60-69':65,'70-79':75,'80-89':85,'90-99':95,'100-109':105,'110-119':115,'120+':130};
        const hpOrder = ['1-39','40-49','50-54','55-59','60-69','70-79','80-89','90-99','100-109','110-119','120+'];

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
                FROM sales_data s JOIN provinces p ON s.province_id = p.id
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
            const priceModels = models.filter(m => m.price_list_tl > 0);
            const avgPrice = priceModels.length > 0 ? priceModels.reduce((s, m) => s + parseFloat(m.price_list_tl), 0) / priceModels.length : 0;
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
                    name: m.model_name, hp: parseFloat(m.horsepower), price: m.price_list_tl ? parseFloat(m.price_list_tl) : 0,
                    category: m.category, cabin: m.cabin_type, drive: m.drive_type, gear: m.gear_config, hp_range: m.hp_range
                }))
            };
        }

        // Total market by year and by province
        const mktYearRes = await pool.query('SELECT year, SUM(quantity) as total FROM sales_data GROUP BY year');
        const mktYearly = {};
        mktYearRes.rows.forEach(r => { mktYearly[r.year] = parseInt(r.total); });

        const mktProvRes = await pool.query(`
            SELECT s.province_id, p.name, SUM(s.quantity) as total
            FROM sales_data s JOIN provinces p ON s.province_id = p.id
            WHERE s.year = $1
            GROUP BY s.province_id, p.name ORDER BY total DESC
        `, [maxYear]);

        // Brand sales by province for dominance map
        const b1ProvRes = await pool.query('SELECT province_id, SUM(quantity) as total FROM sales_data WHERE brand_id=$1 AND year=$2 GROUP BY province_id', [brand1_id, maxYear]);
        const b2ProvRes = await pool.query('SELECT province_id, SUM(quantity) as total FROM sales_data WHERE brand_id=$1 AND year=$2 GROUP BY province_id', [brand2_id, maxYear]);
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
        const mktHpRes = await pool.query('SELECT hp_range, SUM(quantity) as total FROM sales_data WHERE year=$1 GROUP BY hp_range', [maxYear]);
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
                FROM sales_data WHERE brand_id=$1 AND year=$2
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
// TARMAKBIR - Model Yılı Bazlı Aylık Satış
// ============================================
app.get('/api/sales/tarmakbir', authMiddleware, async (req, res) => {
    try {
        // Determine which year the user wants to view
        const latestRes = await pool.query('SELECT MAX(year) as max_year, MIN(year) as min_year FROM sales_data');
        const maxYear = parseInt(latestRes.rows[0].max_year) || 2025;
        const minYear = parseInt(latestRes.rows[0].min_year) || 2019;
        
        // Selected year (the "data year" the user is viewing)
        const requestedYear = req.query.year ? parseInt(req.query.year) : maxYear;
        const selectedYear = !isNaN(requestedYear) ? Math.min(Math.max(requestedYear, minYear), maxYear) : maxYear;
        
        console.log(`TarmakBir Request: req=${req.query.year}, selected=${selectedYear}, range=${minYear}-${maxYear}`);
        
        // Get ALL unique registration years from the database for the rows
        const yearsRes = await pool.query('SELECT DISTINCT year FROM sales_data ORDER BY year DESC');
        const compareYears = yearsRes.rows.map(r => parseInt(r.year));
        
        // Get monthly sales for ALL registration years (Strictly filtering for only the last 2 model years per registration year)
        const salesRes = await pool.query(`
            SELECT year, month, SUM(quantity) as total
            FROM sales_data
            WHERE (year = model_year OR year = model_year + 1)
              AND year = ANY($1)
            GROUP BY year, month
            ORDER BY year DESC, month
        `, [compareYears]);
        
        // Get Model Year breakdown for the SELECTED year (showing only latest 2 model years)
        const modelYearRes = await pool.query(`
            SELECT model_year, month, SUM(quantity) as total
            FROM sales_data
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
            
            try {
                await pool.query('ALTER TABLE sales_data ADD COLUMN model_year INTEGER');
                console.log('✅ sales_data tablosuna model_year sütunu eklendi');
            } catch (e) {
                // Sütun zaten varsa hata verecek, yoksayıyoruz.
            }
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
    });
});

process.on('SIGTERM', async () => {
    console.log('Sunucu kapatılıyor...');
    await pool.end();
    process.exit(0);
});
