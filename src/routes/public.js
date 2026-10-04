'use strict';
// Health check, public legal pages, public reports, debug and WhatsApp/assistant endpoints,
// moved verbatim from server.js. Registration order is preserved (called at the original position).
const crypto = require('crypto');
const { safeEqualStr, errMsg, WHATSAPP_QUERY_API_KEY, WHATSAPP_VERIFY_TOKEN } = require('../config');

module.exports = function registerPublic(app, ctx) {
    const {
        pool, authMiddleware, adminOnly, getLatestSalesPeriod, getBrandCatalog, normalizeSearchText,
        buildBrandExecutiveData, renderBrandExecutiveHtml, buildBrandCompareExecutiveData, renderBrandCompareHtml,
        buildMarketOverviewData, renderMarketOverviewHtml, textToSql, buildSmartFallbackSql, executeSafeSql,
        interpretResults, buildCiroSql, resolveAssistantQuestion, addToConversation, getConversationHistory,
        sendWhatsAppTextMessage
    } = ctx;

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
    app.get('/api/debug/version', authMiddleware, adminOnly, (req, res) => {
        res.json({ version: 'smart-fallback-v6-13patterns', deployed: new Date().toISOString() });
    });

    // Groq API test endpoint'i — Groq çalışıyor mu?
    app.get('/api/debug/groq-test', authMiddleware, adminOnly, async (req, res) => {
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
                    groqError: ctx.lastGroqError || 'unknown',
                    elapsed: elapsed + 'ms',
                    fallbackSql: fallbackSql ? fallbackSql.substring(0, 300) : 'NO_FALLBACK',
                    groqApiKey: ctx.MINIMAX_API_KEY ? 'SET' : 'MISSING',
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
            res.json({ error: errMsg(err), question });
        }
    });

    // Ciro motoru test endpoint'i
    app.get('/api/debug/ciro-test', authMiddleware, adminOnly, async (req, res) => {
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
            if (!res.headersSent) res.status(500).json({ error: errMsg(err) });
        }
    });

    app.post('/api/public/assistant/sales-query', async (req, res) => {
        try {
            if (!WHATSAPP_QUERY_API_KEY) {
                return res.status(503).json({ error: 'Sorgu servisi yapılandırılmamış' });
            }
            if (!safeEqualStr(req.headers['x-query-token'] || '', WHATSAPP_QUERY_API_KEY)) {
                return res.status(401).json({ error: 'Gecersiz sorgu token' });
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

        // Boş yapılandırma boş token ile eşleşmesin; challenge yalnızca düz metin (HTML olarak yansıtılmaz).
        if (WHATSAPP_VERIFY_TOKEN && mode === 'subscribe' && safeEqualStr(token || '', WHATSAPP_VERIFY_TOKEN)) {
            return res.status(200).type('text/plain').send(String(challenge ?? '').slice(0, 200));
        }

        return res.status(403).send('verify token mismatch');
    });


    const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
    if (!WHATSAPP_APP_SECRET) {
        console.warn('UYARI: WHATSAPP_APP_SECRET tanımlı değil; WhatsApp webhook imzası doğrulanmıyor.');
    }

    app.post('/api/public/whatsapp/webhook', async (req, res) => {
        // Üretimde imza anahtarı yoksa istek kabul edilmez: imzasız webhook, sahte mesajla LLM/SQL zincirini tetiklerdi.
        if (!WHATSAPP_APP_SECRET && require('../lib/env').isProduction()) {
            return res.status(503).json({ error: 'WhatsApp webhook yapılandırılmamış (WHATSAPP_APP_SECRET)' });
        }
        if (WHATSAPP_APP_SECRET) {
            const sigHeader = String(req.headers['x-hub-signature-256'] || '');
            const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET)
                .update(req.rawBody || Buffer.alloc(0)).digest('hex');
            if (!safeEqualStr(sigHeader, expected)) {
                return res.status(401).json({ error: 'Geçersiz imza' });
            }
        }
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
};
