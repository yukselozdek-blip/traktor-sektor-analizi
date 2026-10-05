'use strict';
const { logRouteError } = require('../lib/log-error');
// Media Watch routes (overview, sources registry, manual trigger, geo stats, translate),
// moved verbatim from server.js. Registration order is preserved by the caller.
module.exports = function registerMediaWatch(app, ctx) {
    const {
        pool, authMiddleware, requireFeature, requireAiQuota, recordAiUsage, errMsg,
        resolveMediaWatchScopedBrandId, resolveMediaWatchBrandId, buildMediaWatchOverview,
        isMediaWatchWebhookAuthorized, upsertMediaWatchRun, upsertMediaWatchItems,
        syncMediaWatchAlerts, generateMediaWatchBriefRecord
    } = ctx;

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

    app.post('/api/media-watch/brief/generate', authMiddleware, requireFeature('ai_brief', 'media_watch'), requireAiQuota(), async (req, res) => {
        try {
            const brandId = resolveMediaWatchScopedBrandId(req, req.body.brand_id || req.query.brand_id);
            if (!brandId) return res.status(400).json({ error: 'brand_id gerekli' });
            const brief = await generateMediaWatchBriefRecord(brandId, {
                windowDays: req.body.window_days || req.query.window_days || 14,
                createdBy: req.user?.role || 'user'
            });
            // Yalnızca gerçekten LLM kullanıldıysa say (kural tabanlı yedek özet kota harcamaz)
            if (brief && brief.ai_model && brief.ai_model !== 'rule-based') {
                await recordAiUsage(req.user.id, 'media_watch_brief', String(brief.ai_model).slice(0, 50), 0, 0, req);
            }
            res.json(brief);
        } catch (err) {
            console.error('Media watch brief generate error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.post('/api/media-watch/alerts/rebuild', authMiddleware, requireFeature('media_watch'), async (req, res) => {
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
            logRouteError(req, err, 'GET /api/media-watch/sources');
            res.status(500).json({ error: 'Bridge erişilemedi' });
        }
    });

    // Coğrafi/dil istatistikleri (DB tabanlı, son 30 gün)
    app.get('/api/media-watch/coverage', authMiddleware, requireFeature('media_watch'), async (req, res) => {
        try {
            // Marka kullanıcısı yalnızca kendi markasını görür (admin isteğe bağlı brand_id verebilir).
            const brandId = resolveMediaWatchScopedBrandId(req, req.query.brand_id);
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
            const { pack } = req.body || {};
            const brand_id = resolveMediaWatchScopedBrandId(req, (req.body || {}).brand_id);
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
            res.status(500).json({ error: errMsg(err) || 'Bridge çağrı hatası' });
        }
    });

    // AI çeviri (Türkçe olmayan haberleri TR'ye çevirip özet üret)
    app.post('/api/media-watch/translate', authMiddleware, requireFeature('ai_brief', 'media_watch'), requireAiQuota(), async (req, res) => {
        try {
            const { item_id } = req.body || {};
            if (!item_id) return res.status(400).json({ error: 'item_id zorunlu' });
            const scopedBrandId = resolveMediaWatchScopedBrandId(req, null);
            // Marka kullanıcısı yalnızca kendi markasının kaydını çevirebilir (başkasının kaydı 404 gibi davranır).
            const r = await pool.query(
                `SELECT id, language, title, summary, content_text FROM media_watch_items
                 WHERE id = $1 AND ($2::int IS NULL OR brand_id = $2::int)`,
                [Number.isInteger(Number(item_id)) ? Number(item_id) : -1, req.user.role === 'admin' ? null : scopedBrandId || -1]);
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
                        await recordAiUsage(req.user.id, 'media_watch_translate', 'llama-3.3-70b-versatile', aiJson?.usage?.prompt_tokens || 0, aiJson?.usage?.completion_tokens || 0, req);
                    }
                } catch (e) {}
            }
            res.json({ success: true, ...parsed });
        } catch (err) {
            console.error('media-watch translate error', err);
            res.status(500).json({ error: errMsg(err) || 'Çeviri hatası' });
        }
    });

};
