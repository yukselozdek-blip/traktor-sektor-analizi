'use strict';
const { logRouteError } = require('../lib/log-error');
// Subscription plans, billing checkout/webhooks and plan management routes,
// moved verbatim from server.js. Registration order is preserved (called at the
// original position). Plan/feature helpers used by other sections stay in server.js.
const express = require('express');
const jwt = require('jsonwebtoken');
const billingProviders = require('../../billing/providers');
const { getRequestToken } = require('../lib/session');

// Sahte (MOCK) ödeme akışı ücretsiz abonelik aktive eder: yalnızca geliştirme ortamında ya da
// açıkça ALLOW_MOCK_BILLING=1 verildiğinde çalışır. Üretimde gerçek aktivasyon yalnızca imzalı webhook ile yapılır.
const MOCK_BILLING_ALLOWED = !require('../lib/env').isProduction() || process.env.ALLOW_MOCK_BILLING === '1';
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseMeta(m) {
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = {}; } }
    return (m && typeof m === 'object') ? m : {};
}

module.exports = function registerBilling(app, ctx) {
    const {
        pool, authMiddleware, adminOnly, errMsg, JWT_SECRET,
        getUserActiveSubscription, getUserSubscriptionAnyStatus, isSubscriptionEntitled, getPreviewPlanSlug, getPreviewPlanFeatures
    } = ctx;

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
            // Görüntüleme: bekleyen (ödeme onayı beklenen) abonelik de gösterilir; yetki için is_entitled kullanın
            const sub = await getUserSubscriptionAnyStatus(req.user.id);
            if (!sub) return res.json(null);
            let keys = [];
            try {
                keys = typeof sub.feature_keys === 'string' ? JSON.parse(sub.feature_keys) : (Array.isArray(sub.feature_keys) ? sub.feature_keys : []);
            } catch (e) { keys = []; }
            const entitled = isSubscriptionEntitled(sub);
            // Entitled kullanıcının onay bekleyen plan değişikliği (abonelik satırı değişmez; yalnızca payments'ta tutulur)
            let pending_change = null;
            if (entitled) {
                const pc = await pool.query(
                    `SELECT metadata FROM payments WHERE user_id = $1 AND status = 'pending' AND metadata->>'plan_slug' IS NOT NULL
                     ORDER BY created_at DESC, id DESC LIMIT 1`, [req.user.id]);
                if (pc.rows.length) {
                    const m = parseMeta(pc.rows[0].metadata);
                    if (m.plan_slug) pending_change = { plan_slug: m.plan_slug, period: m.period === 'yearly' ? 'yearly' : 'monthly' };
                }
            }
            res.json({ ...sub, feature_keys: keys, is_entitled: entitled, payment_pending: sub.status === 'pending', pending_change });
        } catch (err) {
            logRouteError(req, err, 'GET /api/subscription');
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
            const sub = await getUserSubscriptionAnyStatus(req.user.id);
            const entitled = isSubscriptionEntitled(sub);
            let keys = [];
            if (sub && entitled) {
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
                has_active_subscription: entitled,
                payment_pending: !!sub && sub.status === 'pending'
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
            logRouteError(req, err, 'GET /api/billing/payment-providers');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    const startCheckout = async (req, res) => {
        try {
            const { plan_slug, provider, period } = req.body || {};
            if (!plan_slug || !provider) return res.status(400).json({ error: 'plan_slug ve provider zorunlu' });
            const periodNorm = period === 'yearly' ? 'yearly' : 'monthly';

            const planRes = await pool.query('SELECT * FROM subscription_plans WHERE slug = $1 AND is_active = true', [String(plan_slug).toLowerCase()]);
            if (planRes.rows.length === 0) return res.status(404).json({ error: 'Plan bulunamadı' });
            const plan = planRes.rows[0];

            const providerImpl = billingProviders.getProvider(provider);
            if (!providerImpl) return res.status(400).json({ error: 'Geçersiz ödeme sağlayıcısı' });
            if (providerImpl.is_mock && !MOCK_BILLING_ALLOWED) {
                return res.status(503).json({ error: 'Bu ödeme yöntemi şu anda kullanılamıyor. Lütfen banka havalesini seçin veya bizimle iletişime geçin.' });
            }

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const returnUrl = `${baseUrl}/billing/success?provider=${providerImpl.code}&plan=${plan.slug}&period=${periodNorm}`;
            const cancelUrl = `${baseUrl}/billing/cancel`;

            const session = await providerImpl.createCheckout({
                user: req.user, plan, period: periodNorm, returnUrl, cancelUrl, baseUrl
            });

            // Entitled (active/trialing, süresi dolmamış) aboneliği olan kullanıcının aboneliği DEĞİŞTİRİLMEZ:
            // erişim ödeme onaylanana kadar eski planla sürer, bekleyen değişiklik yalnızca payments kaydında tutulur.
            // Entitled olmayanlar (yeni/pending/past_due/cancelled/süresi dolmuş) için pending abonelik oluşturulur/güncellenir.
            const entitledSub = await getUserActiveSubscription(req.user.id);
            let subscriptionId;
            if (entitledSub) {
                subscriptionId = entitledSub.id;
            } else {
                const existing = await pool.query(
                    `SELECT id FROM subscriptions WHERE user_id = $1 AND status IN ('pending', 'active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
                    [req.user.id]
                );
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
            }

            // Pending payment kaydı
            await pool.query(
                `INSERT INTO payments (user_id, subscription_id, provider, provider_payment_id, amount, currency, status, payment_method, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
                [
                    req.user.id, subscriptionId, providerImpl.code, session.provider_session_id,
                    session.amount, session.currency || 'TRY',
                    providerImpl.code === 'bank_transfer' ? 'bank_transfer' : 'card',
                    JSON.stringify({ ...(session.metadata || {}), plan_slug: plan.slug, bank_reference: session.bank_reference || null, period: periodNorm })
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
            res.status(500).json({ error: errMsg(err) || 'Sunucu hatası' });
        }
    };
    // Anonim sarmalayıcı: route envanteri snapshot'ı işleyici adını da içerir.
    app.post('/api/billing/checkout', authMiddleware, (req, res) => startCheckout(req, res));

    // Ödeme sonrası dönüş sayfası. Abonelik ASLA buradan (sorgu parametreleriyle) aktive edilmez:
    // gerçek sağlayıcılarda aktivasyonu imzalı webhook yapar. Yalnızca MOCK akışta (geliştirme ya da
    // ALLOW_MOCK_BILLING=1) ve yalnızca oturumdaki kullanıcının kendi bekleyen ödemesi için çalışır;
    // plan/dönem sorgudan değil ödeme kaydından okunur.
    app.get('/billing/success', async (req, res) => {
        try {
            if (!MOCK_BILLING_ALLOWED) return res.redirect('/?page=subscription&billing=processing');

            const found = getRequestToken(req);
            let userId = null;
            if (found) {
                try { userId = jwt.verify(found.token, JWT_SECRET, { algorithms: ['HS256'] })?.id || null; } catch (e) { /* geçersiz token */ }
            }
            const sessionId = String(req.query.session_id || '');
            if (!userId || !sessionId) return res.redirect('/?page=subscription&billing=error');

            const pay = await pool.query(
                `SELECT id, metadata FROM payments WHERE provider_payment_id = $1 AND user_id = $2 AND status = 'pending'
                 ORDER BY created_at DESC LIMIT 1`, [sessionId, userId]);
            if (pay.rows.length === 0) return res.redirect('/?page=subscription&billing=error');
            const meta = parseMeta(pay.rows[0].metadata);
            if (!meta.plan_slug) return res.redirect('/?page=subscription&billing=error');

            await activateUserSubscription(userId, meta.plan_slug, String(req.query.provider || 'mock'), meta.period === 'yearly' ? 'yearly' : 'monthly', pay.rows[0].id);
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
<div class="row"><span>Plan</span><strong>${escHtml(plan)} (${period === 'yearly' ? 'Yıllık' : 'Aylık'})</strong></div>
<div class="row"><span>Banka</span><strong>${escHtml(bank.bank_name)}</strong></div>
<div class="row"><span>Hesap Sahibi</span><strong>${escHtml(bank.account_holder)}</strong></div>
<div class="row"><span>IBAN</span><strong>${escHtml(bank.iban)}</strong></div>
<div class="row"><span>SWIFT</span><strong>${escHtml(bank.swift)}</strong></div>
<div class="row"><span>Referans Kodu</span><strong>${escHtml(ref)}</strong></div>
<p style="margin-top:24px;"><a href="/?page=subscription">← Abonelik sayfasına dön</a></p>
</body></html>`);
    });

    // paymentId: onaylanan ÖDEME kaydı. Yalnızca o kayıt 'completed' olur (aynı kullanıcının diğer bekleyen
    // ödemeleri etkilenmez); plan/dönem çağıranın ödeme kaydından okuduğu değerlerdir.
    async function activateUserSubscription(userId, planSlug, provider, period, paymentId) {
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
            if (paymentId) await pool.query(`UPDATE payments SET status = 'completed', subscription_id = $2 WHERE id = $1 AND user_id = $3 AND status = 'pending'`, [paymentId, existing.rows[0].id, userId]);
            return existing.rows[0].id;
        }
        const ins = await pool.query(
            `INSERT INTO subscriptions (user_id, plan_id, status, provider, current_period_start, current_period_end)
         VALUES ($1, $2, 'active', $3, NOW(), $4) RETURNING id`,
            [userId, planId, provider, periodEnd]
        );
        if (paymentId) await pool.query(`UPDATE payments SET status = 'completed', subscription_id = $2 WHERE id = $1 AND user_id = $3 AND status = 'pending'`, [paymentId, ins.rows[0].id, userId]);
        return ins.rows[0].id;
    }

    // Webhook/banka onayı için ilgili bekleyen ödemeyi bul: önce sağlayıcı referansı, yoksa aynı plan+dönemdeki en yeni bekleyen kayıt.
    async function findPendingPayment(userId, provider, refs, planSlug, period) {
        const ids = (refs || []).filter(Boolean).map(String);
        if (ids.length) {
            const r = await pool.query(
                `SELECT id, metadata FROM payments WHERE user_id = $1 AND provider = $2 AND status = 'pending'
                   AND (provider_payment_id = ANY($3::text[]) OR bank_reference = ANY($3::text[]))
                 ORDER BY created_at DESC, id DESC LIMIT 1`, [userId, provider, ids]);
            if (r.rows.length) return r.rows[0];
        }
        const r = await pool.query(
            `SELECT id, metadata FROM payments WHERE user_id = $1 AND provider = $2 AND status = 'pending'
               AND metadata->>'plan_slug' = $3 AND COALESCE(metadata->>'period', 'monthly') = $4
             ORDER BY created_at DESC, id DESC LIMIT 1`, [userId, provider, String(planSlug).toLowerCase(), period === 'yearly' ? 'yearly' : 'monthly']);
        return r.rows[0] || null;
    }

    // Stripe webhook (raw body için ayrı parse)
    app.post('/api/billing/webhook/stripe', async (req, res) => {
        try {
            const provider = billingProviders.StripeProvider;
            const { event } = provider.verifyWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {})), req.headers);
            const parsed = provider.parseWebhookEvent(event);

            if (parsed.status === 'completed' && parsed.user_id && parsed.plan_slug) {
                const pend = await findPendingPayment(parsed.user_id, 'stripe', [parsed.provider_payment_id, event?.data?.object?.id], parsed.plan_slug, parsed.period);
                await activateUserSubscription(parsed.user_id, parsed.plan_slug, 'stripe', parsed.period, pend?.id);
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
            res.status(400).json({ error: 'Webhook doğrulanamadı' });
        }
    });

    // iyzico webhook
    app.post('/api/billing/webhook/iyzico', express.json(), async (req, res) => {
        try {
            const provider = billingProviders.IyzicoProvider;
            const { event } = provider.verifyWebhook(JSON.stringify(req.body), req.headers);
            const parsed = provider.parseWebhookEvent(event);
            if (parsed.status === 'completed' && parsed.user_id && parsed.plan_slug) {
                const pend = await findPendingPayment(parsed.user_id, 'iyzico', [parsed.provider_payment_id], parsed.plan_slug, parsed.period);
                await activateUserSubscription(parsed.user_id, parsed.plan_slug, 'iyzico', parsed.period, pend?.id);
            }
            await pool.query(
                `INSERT INTO payments (user_id, provider, provider_payment_id, amount, currency, status, metadata)
             VALUES ($1, 'iyzico', $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
                [parsed.user_id || null, parsed.provider_payment_id, parsed.amount || 0, parsed.currency || 'TRY', parsed.status, JSON.stringify(parsed.metadata)]
            );
            res.json({ received: true });
        } catch (err) {
            console.error('iyzico webhook error:', err);
            res.status(400).json({ error: 'Webhook doğrulanamadı' });
        }
    });

    // Banka havalesi onay (admin)
    app.post('/api/billing/bank-confirm', authMiddleware, adminOnly, async (req, res) => {
        try {
            const { reference, user_id, plan_slug, period } = req.body || {};
            if (!user_id || !plan_slug) return res.status(400).json({ error: 'user_id ve plan_slug zorunlu' });
            const uid = Number(user_id);
            // Onaylanan ödeme: referans (varsa) ya da aynı plan+dönemdeki bekleyen havale; plan/dönem ödeme kaydından okunur.
            const pend = await findPendingPayment(uid, 'bank_transfer', [reference], plan_slug, period);
            const pm = pend ? parseMeta(pend.metadata) : {};
            const planToApply = pm.plan_slug || plan_slug;
            const periodToApply = (pend ? pm.period : period) === 'yearly' ? 'yearly' : 'monthly';
            const subId = await activateUserSubscription(uid, planToApply, 'bank_transfer', periodToApply, pend?.id);
            if (reference && pend) {
                await pool.query(`UPDATE payments SET bank_reference = $1 WHERE id = $2`, [reference, pend.id]);
            }
            res.json({ success: true, subscription_id: subId });
        } catch (err) {
            logRouteError(req, err, 'POST /api/billing/bank-confirm');
            res.status(500).json({ error: errMsg(err) });
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
            LEFT JOIN subscription_plans sp ON sp.slug = p.metadata->>'plan_slug'
            WHERE p.provider = 'bank_transfer' AND p.status = 'pending'
            ORDER BY p.created_at DESC LIMIT 200
        `);
            res.json(r.rows);
        } catch (err) {
            logRouteError(req, err, 'GET /api/billing/bank-pending');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Aboneliği iptal et
    app.post('/api/billing/cancel', authMiddleware, async (req, res) => {
        try {
            const sub = await getUserSubscriptionAnyStatus(req.user.id);
            if (!sub) return res.status(404).json({ error: 'Aktif abonelik yok' });
            await pool.query(
                `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`,
                [sub.id]
            );
            res.json({ success: true, message: 'Mevcut dönem sonunda iptal edilecek' });
        } catch (err) {
            logRouteError(req, err, 'POST /api/billing/cancel');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // Plan yükselt / düşür (provider üzerinden değil, doğrudan değiştirme — yeni dönem aktive olur)
    app.post('/api/billing/change-plan', authMiddleware, async (req, res) => {
        try {
            const { plan_slug, provider, period } = req.body || {};
            if (!plan_slug || !provider) return res.status(400).json({ error: 'plan_slug ve provider zorunlu' });
            // Yeni checkout başlat (entitled abonelik değişmez, bekleyen değişiklik payments'ta tutulur; entitled değilse pending abonelik oluşur)
            req.body = { plan_slug, provider, period };
            return startCheckout(req, res);
        } catch (err) {
            logRouteError(req, err, 'POST /api/billing/change-plan');
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
            logRouteError(req, err, 'GET /api/billing/invoices');
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });
};
