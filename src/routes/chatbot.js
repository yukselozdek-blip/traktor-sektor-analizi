'use strict';
// Web sohbet asistanı (/api/chatbot/*): doğal dil soru → mevcut metin-SQL / ciro motoru (resolveAssistantQuestion).
// Güvenlik: oturum zorunlu; paket özelliği + AI kotası (yardım/tanıtım yanıtları kotadan düşmez); kullanıcı başına hız sınırı;
// konuşma kimliği SUNUCUDA kullanıcıdan türetilir (istemci session_id'si kabul edilmez → başkasının geçmişi okunamaz);
// üretilen SQL yalnızca yöneticiye döner.
const rateLimit = require('express-rate-limit');
const { logRouteError } = require('../lib/log-error');

const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 5000;

const SUGGESTIONS = [
    '2025 yılında en çok satan 5 marka hangileri?',
    'New Holland ile Massey Ferguson 2024 satışlarını karşılaştır',
    "Konya'da 70-79 HP segmentinde lider marka",
    'Bahçe traktörlerinde en çok satan modeller',
    'TÜMOSAN markasının 2024 yılı cirosu',
    "İstanbul'da hangi marka önde?"
];

const HELP_ANSWER = `🤖 *Traktör Sektör Asistanı*\n\nTürkiye traktör sektörü hakkında doğal dille soru sorabilirsiniz:\n\n` +
    `📊 Satış: "2024 toplam satış kaç adet?"\n🏆 Karşılaştırma: "New Holland ile John Deere'i karşılaştır"\n` +
    `📈 Segment: "70-79 HP segmentinde lider marka"\n🗺️ İl analizi: "Konya'da hangi marka önde?"\n` +
    `💰 Ciro: "TÜMOSAN 2024 cirosu"\n\nÖnceki sorularınızın devamını da sorabilirsiniz.`;
const ABOUT_ANSWER = `🚜 *Traktör Sektör Analiz Asistanı*\n\nTÜİK tescil verisi ve teknik özellik veritabanı üzerinden Türkiye traktör pazarını analiz eder:\n\n` +
    `• Marka, il ve model bazlı satış verileri\n• HP segmentleri, çekiş ve kabin kategorileri\n• Marka karşılaştırması ve trend analizi\n` +
    `• Ciro tahmini (satış × ortalama model fiyatı)\n\nSQL bilmenize gerek yok.`;

module.exports = function registerChatbot(app, ctx) {
    const { authMiddleware, requireFeature, requireAiQuota, recordAiUsage, resolveAssistantQuestion, normalizeSearchText } = ctx;

    const sessions = new Map(); // "web:<userId>" → [{ q, a, intent, ts }]
    const sessionKey = req => `web:${req.user.id}`;
    const push = (key, entry) => {
        if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const arr = sessions.get(key) || [];
        arr.push({ ...entry, ts: Date.now() });
        while (arr.length > MAX_HISTORY) arr.shift();
        sessions.set(key, arr);
    };
    setInterval(() => {
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const [k, arr] of sessions) if (!arr.length || arr[arr.length - 1].ts < cutoff) sessions.delete(k);
    }, 10 * 60 * 1000).unref();

    function detectIntent(question) {
        const norm = normalizeSearchText(question || '');
        if (!norm) return 'empty';
        if (['yardim', 'help', 'komutlar', 'nasil kullan', 'neler sorabil', 'merhaba', 'selam'].some(k => norm.includes(k))) return 'help';
        if (['kim sin', 'sen kim', 'ne yapabil', 'kendini tanit', 'kapsam'].some(k => norm.includes(k))) return 'about';
        return 'data_query';
    }

    // Soru gövdeden doğrulanır ve normalize edilir (kontrol karakterleri atılır).
    function validateQuestion(req, res, next) {
        const raw = req.body && req.body.question;
        if (typeof raw !== 'string') return res.status(400).json({ ok: false, error: 'Soru metin olmalı', suggestions: SUGGESTIONS });
        const q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!q) return res.status(400).json({ ok: false, error: 'Soru boş olamaz', suggestions: SUGGESTIONS });
        if (q.length > MAX_QUESTION_CHARS) return res.status(400).json({ ok: false, error: `Soru çok uzun (en fazla ${MAX_QUESTION_CHARS} karakter)` });
        req.chatQuestion = q;
        req.chatIntent = detectIntent(q);
        next();
    }

    const quota = requireAiQuota();
    const quotaForDataOnly = (req, res, next) => (req.chatIntent === 'data_query' ? quota(req, res, next) : next());

    const perUserLimiter = rateLimit({
        windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
        keyGenerator: req => `chat-${req.user.id}`,
        message: { ok: false, error: 'Çok hızlı soruyorsunuz. Bir dakika sonra tekrar deneyin.' }
    });

    app.post('/api/chatbot/ask',
        authMiddleware, requireFeature('ai_insights', 'ai_insights_limited'), validateQuestion, perUserLimiter, quotaForDataOnly,
        async (req, res) => {
            const t0 = Date.now();
            const question = req.chatQuestion;
            const key = sessionKey(req);
            try {
                if (req.chatIntent === 'help' || req.chatIntent === 'about') {
                    const answer = req.chatIntent === 'help' ? HELP_ANSWER : ABOUT_ANSWER;
                    push(key, { q: question, a: answer, intent: req.chatIntent });
                    return res.json({ ok: true, intent: req.chatIntent, answer, suggestions: SUGGESTIONS, elapsed_ms: Date.now() - t0 });
                }
                const result = await resolveAssistantQuestion(question, key);
                const ok = result.ok !== false;
                // Başarılı veri sorgusu kotadan kalıcı olarak düşer; başarısızlıkta rezervasyon iade edilir (kapanışta).
                if (ok) await recordAiUsage(req.user.id, 'chatbot', 'assistant', 0, 0, req);
                push(key, { q: question, a: result.answer, intent: result.intent || 'data_query' });
                const body = { ok, intent: result.intent || 'data_query', answer: result.answer, elapsed_ms: Date.now() - t0 };
                if (!ok) body.suggestions = SUGGESTIONS;
                if (req.user.role === 'admin' && result.sql) body.sql = result.sql; // şema bilgisi yalnızca yöneticiye
                return res.json(body);
            } catch (err) {
                logRouteError(req, err, 'POST /api/chatbot/ask');
                return res.status(500).json({ ok: false, error: 'Soru işlenirken hata oluştu. Lütfen tekrar deneyin.', elapsed_ms: Date.now() - t0 });
            }
        });

    app.get('/api/chatbot/history', authMiddleware, requireFeature('ai_insights', 'ai_insights_limited'), (req, res) => {
        const history = sessions.get(sessionKey(req)) || [];
        res.json({ ok: true, history: history.map(h => ({ q: h.q, a: h.a, intent: h.intent, ts: h.ts })), count: history.length });
    });

    app.delete('/api/chatbot/history', authMiddleware, requireFeature('ai_insights', 'ai_insights_limited'), (req, res) => {
        sessions.delete(sessionKey(req));
        res.json({ ok: true, cleared: true });
    });
};
