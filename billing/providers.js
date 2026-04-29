// ============================================
// PAYMENT PROVIDERS — Stripe / iyzico / Banka Havalesi
// ============================================
// Tek dosyada üç sağlayıcının ortak arabirimi.
// Her sağlayıcı şu metodları sağlar:
//   - createCheckout({ user, plan, period, returnUrl, cancelUrl }) -> { redirect_url, provider_session_id, metadata }
//   - verifyWebhook(rawBody, headers) -> { event, payload } veya hata fırlatır
//   - parseWebhookEvent(event) -> { type, provider_payment_id, provider_subscription_id, amount, status, metadata }
//
// Production'da ortam değişkenleriyle aktive olur. Yoksa sandbox/MOCK modunda çalışır
// (lokal geliştirme + Railway staging için). Bu sayede uçtan uca akış hiç ödeme tahsilatı
// yapmadan da test edilebilir.

const crypto = require('crypto');

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const IYZICO_API_KEY = process.env.IYZICO_API_KEY || '';
const IYZICO_SECRET = process.env.IYZICO_SECRET_KEY || '';
const IYZICO_BASE = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';
const BANK_DETAILS = {
    bank_name: process.env.BANK_TRANSFER_BANK || 'Garanti BBVA',
    account_holder: process.env.BANK_TRANSFER_HOLDER || 'Traktör Sektör Analizi A.Ş.',
    iban: process.env.BANK_TRANSFER_IBAN || 'TR00 0006 2000 0000 0000 0000 00',
    swift: process.env.BANK_TRANSFER_SWIFT || 'TGBATRIS'
};

// MOCK_MODE: Stripe/iyzico anahtarı yoksa otomatik mock akış
const STRIPE_MOCK = !STRIPE_SECRET || STRIPE_SECRET.startsWith('sk_test_dummy') || STRIPE_SECRET === 'YOUR_STRIPE_SECRET_KEY';
const IYZICO_MOCK = !IYZICO_API_KEY || IYZICO_API_KEY === 'YOUR_IYZICO_KEY';

function mockSessionId(prefix) {
    return `${prefix}_mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBankReference(userId) {
    const stamp = Date.now().toString(36).toUpperCase().slice(-6);
    return `TSA-${userId}-${stamp}`;
}

// ============================================
// STRIPE
// ============================================
const StripeProvider = {
    code: 'stripe',
    name: 'Stripe (Uluslararası Kart)',
    icon: 'fa-credit-card',
    description: 'Visa / Mastercard / Amex — anında aktivasyon',
    is_mock: STRIPE_MOCK,

    async createCheckout({ user, plan, period, returnUrl, cancelUrl, baseUrl }) {
        const amount = period === 'yearly' ? Number(plan.price_yearly || 0) : Number(plan.price_monthly || 0);
        const sessionId = mockSessionId('cs_stripe');

        if (STRIPE_MOCK) {
            // Lokal/sandbox: kendi success sayfamıza dönen sahte oturum
            const successUrl = `${baseUrl}/billing/success?provider=stripe&session_id=${sessionId}&plan=${plan.slug}&period=${period}`;
            return {
                provider: 'stripe',
                provider_session_id: sessionId,
                redirect_url: successUrl,
                amount,
                currency: plan.currency || 'TRY',
                is_mock: true,
                metadata: { plan_id: plan.id, plan_slug: plan.slug, user_id: user.id, period }
            };
        }

        // Gerçek Stripe Checkout Session API çağrısı
        const params = new URLSearchParams();
        params.append('mode', 'subscription');
        params.append('success_url', returnUrl);
        params.append('cancel_url', cancelUrl);
        params.append('customer_email', user.email);
        params.append('metadata[plan_slug]', plan.slug);
        params.append('metadata[user_id]', String(user.id));
        params.append('metadata[period]', period);
        params.append('line_items[0][quantity]', '1');
        params.append('line_items[0][price_data][currency]', String(plan.currency || 'TRY').toLowerCase());
        params.append('line_items[0][price_data][unit_amount]', String(Math.round(amount * 100)));
        params.append('line_items[0][price_data][product_data][name]', `${plan.name} — ${period === 'yearly' ? 'Yıllık' : 'Aylık'}`);
        params.append('line_items[0][price_data][recurring][interval]', period === 'yearly' ? 'year' : 'month');

        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${STRIPE_SECRET}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });
        const json = await res.json();
        if (!res.ok) throw new Error(`Stripe checkout failed: ${json?.error?.message || res.status}`);
        return {
            provider: 'stripe',
            provider_session_id: json.id,
            redirect_url: json.url,
            amount,
            currency: plan.currency || 'TRY',
            is_mock: false,
            metadata: { plan_id: plan.id, plan_slug: plan.slug, user_id: user.id, period }
        };
    },

    verifyWebhook(rawBody, headers) {
        if (STRIPE_MOCK) {
            const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
            return { event: parsed, verified: false };
        }
        const sig = headers['stripe-signature'] || '';
        if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET tanımlı değil');
        const parts = String(sig).split(',').reduce((acc, p) => {
            const [k, v] = p.split('=');
            acc[k] = v;
            return acc;
        }, {});
        const expected = crypto
            .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
            .update(`${parts.t}.${rawBody}`)
            .digest('hex');
        if (expected !== parts.v1) throw new Error('Stripe webhook imzası geçersiz');
        return { event: JSON.parse(rawBody), verified: true };
    },

    parseWebhookEvent(event) {
        const data = event?.data?.object || {};
        const meta = data?.metadata || {};
        const type = event?.type || '';
        let status = 'pending';
        if (type === 'checkout.session.completed' || type === 'invoice.paid') status = 'completed';
        else if (type === 'invoice.payment_failed') status = 'failed';
        else if (type === 'customer.subscription.deleted') status = 'cancelled';
        return {
            type,
            status,
            provider_payment_id: data.payment_intent || data.id || '',
            provider_subscription_id: data.subscription || data.id || '',
            provider_customer_id: data.customer || '',
            plan_slug: meta.plan_slug || '',
            user_id: meta.user_id ? Number(meta.user_id) : null,
            period: meta.period || 'monthly',
            amount: data.amount_total ? data.amount_total / 100 : (data.amount_paid ? data.amount_paid / 100 : 0),
            currency: (data.currency || 'try').toUpperCase(),
            metadata: meta
        };
    }
};

// ============================================
// IYZICO (Türkiye yerel kart)
// ============================================
const IyzicoProvider = {
    code: 'iyzico',
    name: 'iyzico (Türkiye Kart)',
    icon: 'fa-money-check-dollar',
    description: '3D Secure ile yerel kart ödemesi — anında aktivasyon',
    is_mock: IYZICO_MOCK,

    async createCheckout({ user, plan, period, returnUrl, baseUrl }) {
        const amount = period === 'yearly' ? Number(plan.price_yearly || 0) : Number(plan.price_monthly || 0);
        const sessionId = mockSessionId('iyz_session');

        if (IYZICO_MOCK) {
            const successUrl = `${baseUrl}/billing/success?provider=iyzico&session_id=${sessionId}&plan=${plan.slug}&period=${period}`;
            return {
                provider: 'iyzico',
                provider_session_id: sessionId,
                redirect_url: successUrl,
                amount,
                currency: plan.currency || 'TRY',
                is_mock: true,
                metadata: { plan_id: plan.id, plan_slug: plan.slug, user_id: user.id, period }
            };
        }

        // Gerçek iyzico Checkout Form API
        const conversationId = `tsa-${user.id}-${Date.now()}`;
        const body = {
            locale: 'tr',
            conversationId,
            price: amount.toFixed(2),
            paidPrice: amount.toFixed(2),
            currency: plan.currency || 'TRY',
            basketId: `plan_${plan.id}`,
            paymentGroup: 'SUBSCRIPTION',
            callbackUrl: returnUrl,
            buyer: {
                id: String(user.id),
                name: (user.full_name || user.email || 'Kullanici').split(' ')[0] || 'Kullanici',
                surname: (user.full_name || '').split(' ').slice(1).join(' ') || 'Soyadi',
                email: user.email,
                identityNumber: '11111111111',
                registrationAddress: 'Türkiye',
                city: 'İstanbul',
                country: 'Turkey',
                ip: '85.0.0.1'
            },
            shippingAddress: { contactName: user.full_name || user.email, city: 'İstanbul', country: 'Turkey', address: 'Türkiye' },
            billingAddress: { contactName: user.full_name || user.email, city: 'İstanbul', country: 'Turkey', address: 'Türkiye' },
            basketItems: [{
                id: `plan_${plan.id}`,
                name: `${plan.name} — ${period === 'yearly' ? 'Yıllık' : 'Aylık'}`,
                category1: 'Subscription',
                itemType: 'VIRTUAL',
                price: amount.toFixed(2)
            }]
        };
        const headers = iyzicoHeaders('/payment/iyzipos/checkoutform/initialize/auth/ecom', body);
        const res = await fetch(`${IYZICO_BASE}/payment/iyzipos/checkoutform/initialize/auth/ecom`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (json.status !== 'success') throw new Error(`iyzico checkout failed: ${json?.errorMessage || 'unknown'}`);
        return {
            provider: 'iyzico',
            provider_session_id: json.token,
            redirect_url: json.paymentPageUrl,
            amount,
            currency: plan.currency || 'TRY',
            is_mock: false,
            metadata: { plan_id: plan.id, plan_slug: plan.slug, user_id: user.id, period, conversationId }
        };
    },

    verifyWebhook(rawBody, headers) {
        if (IYZICO_MOCK) {
            const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
            return { event: parsed, verified: false };
        }
        const sig = headers['x-iyz-signature'] || '';
        const expected = crypto
            .createHmac('sha256', IYZICO_SECRET)
            .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
            .digest('base64');
        if (expected !== sig) throw new Error('iyzico webhook imzası geçersiz');
        return { event: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody, verified: true };
    },

    parseWebhookEvent(event) {
        return {
            type: event?.eventType || event?.iyziEventType || 'payment.update',
            status: (event?.paymentStatus === 'SUCCESS' || event?.status === 'success') ? 'completed' : (event?.paymentStatus === 'FAILURE' ? 'failed' : 'pending'),
            provider_payment_id: event?.paymentId || event?.iyziPaymentId || '',
            provider_subscription_id: event?.subscriptionReferenceCode || '',
            provider_customer_id: event?.customerReferenceCode || '',
            plan_slug: event?.metadata?.plan_slug || '',
            user_id: event?.metadata?.user_id ? Number(event.metadata.user_id) : null,
            period: event?.metadata?.period || 'monthly',
            amount: Number(event?.price || event?.paidPrice || 0),
            currency: event?.currency || 'TRY',
            metadata: event?.metadata || {}
        };
    }
};

function iyzicoHeaders(uri, body) {
    if (!IYZICO_API_KEY) return {};
    const random = String(Date.now());
    const payload = IYZICO_API_KEY + random + IYZICO_SECRET + uri + JSON.stringify(body);
    const hash = crypto.createHash('sha1').update(payload).digest('base64');
    return {
        'Authorization': `IYZWS ${IYZICO_API_KEY}:${hash}`,
        'x-iyzi-rnd': random
    };
}

// ============================================
// BANK TRANSFER (Manuel onay)
// ============================================
const BankTransferProvider = {
    code: 'bank_transfer',
    name: 'Banka Havalesi / EFT',
    icon: 'fa-university',
    description: 'Manuel onay — IBAN bilgisi ve referans kodu üretilir',
    is_mock: false,

    async createCheckout({ user, plan, period, baseUrl }) {
        const amount = period === 'yearly' ? Number(plan.price_yearly || 0) : Number(plan.price_monthly || 0);
        const reference = buildBankReference(user.id);
        return {
            provider: 'bank_transfer',
            provider_session_id: reference,
            redirect_url: `${baseUrl}/billing/bank-info?ref=${encodeURIComponent(reference)}&plan=${plan.slug}&period=${period}`,
            amount,
            currency: plan.currency || 'TRY',
            bank_reference: reference,
            bank_details: BANK_DETAILS,
            is_mock: false,
            metadata: { plan_id: plan.id, plan_slug: plan.slug, user_id: user.id, period, status: 'awaiting_transfer' }
        };
    },

    verifyWebhook() { throw new Error('Banka havalesi webhook desteklemez. Admin panelinden onaylanır.'); },
    parseWebhookEvent() { return { type: 'manual', status: 'pending' }; }
};

function getProvider(code) {
    switch (String(code || '').toLowerCase()) {
        case 'stripe': return StripeProvider;
        case 'iyzico': return IyzicoProvider;
        case 'bank_transfer':
        case 'bank':
        case 'havale': return BankTransferProvider;
        default: return null;
    }
}

function listProviders() {
    return [
        {
            code: StripeProvider.code,
            name: StripeProvider.name,
            icon: StripeProvider.icon,
            description: StripeProvider.description,
            is_mock: StripeProvider.is_mock,
            instant: true
        },
        {
            code: IyzicoProvider.code,
            name: IyzicoProvider.name,
            icon: IyzicoProvider.icon,
            description: IyzicoProvider.description,
            is_mock: IyzicoProvider.is_mock,
            instant: true
        },
        {
            code: BankTransferProvider.code,
            name: BankTransferProvider.name,
            icon: BankTransferProvider.icon,
            description: BankTransferProvider.description,
            is_mock: BankTransferProvider.is_mock,
            instant: false,
            bank_details: BANK_DETAILS
        }
    ];
}

module.exports = {
    StripeProvider,
    IyzicoProvider,
    BankTransferProvider,
    getProvider,
    listProviders,
    BANK_DETAILS
};
