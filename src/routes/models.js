'use strict';
// Traktör modelleri, model istihbaratı ve görsel galeri yönetimi route'ları, server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerModels(app, ctx) {
    const { geoHelpers, pool, authMiddleware, adminOnly, normalizeSearchText, roundMetric, calculateYoY, errMsg, APP_BASE_URL, MEDIA_WATCH_WEBHOOK_KEY, N8N_MODEL_INTEL_WEBHOOK_URL, MODEL_IMAGE_BRIDGE_URL } = ctx;

    // ============================================
    // TRACTOR MODELS
    // ============================================
    const MODEL_INTEL_ALLOWED_EXTERNAL_HOSTS = new Set([
        'www.tr.lectura-specs.com',
        'tr.lectura-specs.com',
        'www.lectura-specs.com',
        'lectura-specs.com'
    ]);

    function toUpperPlain(value = '') {
        return String(value || '').trim().toUpperCase();
    }

    function normalizeBrandAliasesForModelIntel(brandName = '') {
        const raw = String(brandName || '').trim();
        const upper = toUpperPlain(raw);
        const aliases = new Set([upper]);

        if (upper === 'CASE') aliases.add('CASE IH');
        if (upper === 'CASE IH') aliases.add('CASE');
        if (upper === 'DEUTZ') aliases.add('DEUTZ-FAHR');
        if (upper === 'DEUTZ-FAHR') aliases.add('DEUTZ');
        if (upper === 'KIOTI' || upper === 'KİOTİ') {
            aliases.add('KIOTI');
            aliases.add('KİOTİ');
        }

        return [...aliases].filter(Boolean);
    }

    function normalizeModelSearch(value = '') {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeTurkishSearchKey(value = '') {
        return String(value || '')
            .trim()
            .toLocaleUpperCase('tr-TR')
            .replace(/[İIı]/g, 'I')
            .replace(/[Ş]/g, 'S')
            .replace(/[Ğ]/g, 'G')
            .replace(/[Ü]/g, 'U')
            .replace(/[Ö]/g, 'O')
            .replace(/[Ç]/g, 'C')
            .replace(/\s+/g, ' ');
    }

    function numberOrNull(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }

    function formatModelIntelUsd(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return '-';
        return `${Math.round(numeric).toLocaleString('tr-TR')} $`;
    }

    function compactModelIntelText(value = '') {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function decodeBasicHtmlEntities(value = '') {
        return String(value || '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&uuml;/gi, 'ü')
            .replace(/&Uuml;/g, 'Ü')
            .replace(/&ouml;/gi, 'ö')
            .replace(/&Ouml;/g, 'Ö')
            .replace(/&ccedil;/gi, 'ç')
            .replace(/&Ccedil;/g, 'Ç')
            .replace(/&scedil;/gi, 'ş')
            .replace(/&Scedil;/g, 'Ş')
            .replace(/&imath;/gi, 'ı')
            .replace(/&Idot;/g, 'İ')
            .replace(/&acirc;/gi, 'â')
            .replace(/&Acirc;/g, 'Â');
    }

    function htmlToModelIntelLines(html = '') {
        const withoutBlocks = String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
        return decodeBasicHtmlEntities(withoutBlocks)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|dt|dd)>/gi, '\n')
            .replace(/<[^>]+>/g, '\n')
            .split(/\n+/)
            .map(compactModelIntelText)
            .filter(Boolean);
    }

    function extractMetaContent(html = '', property = '') {
        const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
        const altRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
        const match = String(html || '').match(regex) || String(html || '').match(altRegex);
        return match ? decodeBasicHtmlEntities(match[1]) : '';
    }

    function getNextLineValue(lines = [], label = '') {
        const target = toUpperPlain(label).replace(/\s+/g, ' ');
        for (let i = 0; i < lines.length; i += 1) {
            const current = toUpperPlain(lines[i]).replace(/\s+/g, ' ');
            if (current === target || current.replace(/:$/, '') === target.replace(/:$/, '')) {
                const next = lines[i + 1] || '';
                if (next && !toUpperPlain(next).startsWith(target)) return next;
            }
        }
        return '';
    }

    function parseExternalModelSourceHtml(html = '', sourceUrl = '') {
        const title = extractMetaContent(html, 'og:title')
            || decodeBasicHtmlEntities((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
        const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description');
        const imageUrl = extractMetaContent(html, 'og:image') || '';
        const lines = htmlToModelIntelLines(html);

        const lecturaLabels = [
            'Motor gücü',
            'Model Serisi',
            'Geri lastikler',
            'Ön lastikler',
            'Transmisyon',
            'Ağırlık',
            'Kontrol ünitesi',
            'Motor imalatçısı',
            'Motor tipi',
            'Deplasman',
            'Maks torkta devirler',
            'Maks. dönme momenti',
            'Silindir sayısı',
            'Emisyon seviyesi',
            'Üç nokta kategorisi',
            'Kabin',
            'Ön hdrolikler',
            'Ön PTO',
            'Hava Frenleri',
            'ISO otobüs',
            'Klima'
        ];

        const specs = lecturaLabels
            .map(label => ({ label, value: getNextLineValue(lines, label) }))
            .filter(item => item.value);

        return {
            provider: 'LECTURA Specs',
            url: sourceUrl,
            status: specs.length ? 'ok' : 'partial',
            title: compactModelIntelText(title),
            description: compactModelIntelText(description),
            image_url: imageUrl,
            specs,
            fetched_at: new Date().toISOString()
        };
    }

    async function fetchExternalModelSource(sourceUrl = '') {
        if (!sourceUrl) return null;

        let parsedUrl;
        try {
            parsedUrl = new URL(sourceUrl);
        } catch {
            return { status: 'error', error: 'Kaynak URL formatı geçersiz', url: sourceUrl };
        }

        const host = parsedUrl.hostname.toLowerCase();
        if (parsedUrl.protocol !== 'https:' || !MODEL_INTEL_ALLOWED_EXTERNAL_HOSTS.has(host)) {
            const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
            if (fallback) return fallback;
            return {
                status: 'blocked',
                error: 'Canlı okuma şu anda yalnızca LECTURA Specs HTTPS kaynaklarıyla sınırlandırıldı',
                url: sourceUrl
            };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6500);
        try {
            const response = await fetch(parsedUrl.toString(), {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'TraktorSektorAnalizi/1.0 model-intelligence',
                    'Accept': 'text/html,application/xhtml+xml'
                }
            });
            if (!response.ok) {
                const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
                if (fallback) return fallback;
                return { status: 'error', error: `Kaynak HTTP ${response.status}`, url: sourceUrl };
            }
            const html = await response.text();
            return parseExternalModelSourceHtml(html, parsedUrl.toString());
        } catch (err) {
            const fallback = getKnownExternalModelSourceFallback(parsedUrl.toString());
            if (fallback) return fallback;
            return {
                status: 'error',
                error: err.name === 'AbortError' ? 'Kaynak okuma zaman aşımına uğradı' : err.message,
                url: sourceUrl
            };
        } finally {
            clearTimeout(timer);
        }
    }

    function inferKnownModelSourceUrl(brandName = '', modelName = '') {
        const combined = `${brandName} ${modelName}`.toUpperCase();
        if (combined.includes('CLAAS') && combined.includes('ARION') && combined.includes('450')) {
            return 'https://www.tr.lectura-specs.com/tr/model/tarim-makinalari/traktorler-4wd-claas/arion-450-trend-11756863';
        }
        if ((combined.includes('TÜMOSAN') || combined.includes('TUMOSAN')) && combined.includes('8110')) {
            return 'https://www.tumosan.com.tr/tr/urunler/8110';
        }
        return '';
    }

    function getKnownExternalModelSourceFallback(sourceUrl = '') {
        const normalizedSourceUrl = String(sourceUrl || '').toLowerCase();
        if (normalizedSourceUrl.includes('tumosan.com.tr') && normalizedSourceUrl.includes('/urunler/8110')) {
            return {
                provider: 'Tümosan resmi ürün sayfası',
                url: sourceUrl,
                status: 'fallback',
                title: 'Tümosan 8110 Teknik Özellikler',
                description: 'Resmi Tümosan ürün sayfasındaki görsel, motor, şanzıman, PTO, hidrolik, kabin ve lastik bilgileri.',
                image_url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
                image_provider: 'Tümosan',
                image_source_url: 'https://www.tumosan.com.tr/tr/urunler/8110',
                model_match_level: 'exact_product_page',
                verification_status: 'official_product_page',
                review_status: 'approved',
                image_gallery: [
                    {
                        url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
                        label: 'Tümosan 8110 resmi ürün görseli',
                        source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                        source_name: 'Tümosan resmi ürün sayfası',
                        model_match_level: 'exact_product_page',
                        verification_status: 'official_product_page',
                        review_status: 'approved',
                        confidence_score: 0.98
                    },
                    {
                        url: 'https://www.tumosan.com.tr/uploads/2023/08/8100serisi1616-fotogaleri-01_w1200_q90_op.jpg',
                        label: 'Tümosan 8110 yan görünüm',
                        source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                        source_name: 'Tümosan resmi ürün sayfası',
                        model_match_level: 'series_gallery',
                        verification_status: 'candidate',
                        review_status: 'candidate',
                        confidence_score: 0.72
                    },
                    {
                        url: 'https://www.tumosan.com.tr/uploads/2023/08/8100serisi1616-fotogaleri-02_w1200_q90_op.jpg',
                        label: 'Tümosan 8110 kabinli seri fotoğrafı',
                        source: 'https://www.tumosan.com.tr/tr/urunler/8110',
                        source_name: 'Tümosan resmi ürün sayfası',
                        model_match_level: 'series_gallery',
                        verification_status: 'candidate',
                        review_status: 'candidate',
                        confidence_score: 0.72
                    }
                ],
                specs: [
                    { label: 'Motor Markası', value: 'Tümosan' },
                    { label: 'Emisyon Seviyesi', value: 'Stage IIIA / Faz 3A' },
                    { label: 'Nominal Motor Gücü', value: '105 HP' },
                    { label: 'Anma Motor Devri', value: '2500 rpm' },
                    { label: 'Silindir Sayısı / Aspirasyon', value: '4 / Turbo Intercooler' },
                    { label: 'Silindir Hacmi', value: '3,9 L' },
                    { label: 'Maksimum Tork', value: '400 Nm' },
                    { label: 'Azami Tork Devri', value: '1500 rpm' },
                    { label: 'Hava Filtresi Tipi', value: 'Kuru tip' },
                    { label: 'Yakıt Depo Kapasitesi', value: '115 lt' },
                    { label: 'Dişli Kutusu Tipi', value: 'Mekanik - Senkromeçli' },
                    { label: 'Vites Seçeneği', value: '16 ileri / 16 geri' },
                    { label: 'İleri - Geri Mekik Kolu', value: 'Mekanik' },
                    { label: 'Çift Çeker Kumandası', value: 'Elektro-hidrolik' },
                    { label: 'Ön Diferansiyel Kilidi', value: 'Kendinden kilitli' },
                    { label: 'Arka Diferansiyel Kilidi', value: 'Elektro-hidrolik' },
                    { label: 'PTO Tipi', value: 'Bağımsız' },
                    { label: 'PTO Kumanda Şekli', value: 'Elektro-hidrolik' },
                    { label: 'Kuyruk Mili Devri', value: '540 / 540E' },
                    { label: 'Hidrolik Güç Çıkışı', value: '6 adet' },
                    { label: 'Kaldırma Kapasitesi', value: '4.000 kg' },
                    { label: 'Kabin donanımı', value: 'Klima, yolcu koltuğu, radyo, kompresör' },
                    { label: 'Standart konfor', value: 'Ayarlanabilir direksiyon, ayarlanabilir sürücü koltuğu' },
                    { label: 'Yüksüz Kütle - 4WD Kabinli', value: '3.500 kg' },
                    { label: '1. Opsiyon 4WD-Ön', value: '380/70R24' },
                    { label: '1. Opsiyon 4WD-Arka', value: '420/85R34' },
                    { label: '2. Opsiyon 4WD-Ön', value: '340/85R24' },
                    { label: '2. Opsiyon 4WD-Arka', value: '380/85R38' }
                ],
                fetched_at: new Date().toISOString()
            };
        }
        if (!String(sourceUrl || '').includes('arion-450-trend-11756863')) return null;
        return {
            provider: 'LECTURA Specs',
            url: sourceUrl,
            status: 'fallback',
            title: 'Claas Arion 450 Trend Teknik Özellikler ve Veriler (2022-2026)',
            description: 'Canlı fetch HTTP 403 döndürürse kullanılan doğrulanmış örnek kaynak özeti.',
            image_url: 'https://www.tractorspecifications.com/uploads/tractor-data/140-8570-td3a.jpg',
            image_provider: 'TractorSpecifications',
            image_source_url: 'https://www.tractorspecifications.com/en/tractors/farm/claas/claas-arion-450',
            specs: [
                { label: 'Motor gücü', value: '99 kW' },
                { label: 'Model Serisi', value: 'Arion' },
                { label: 'Geri lastikler', value: '600/65 R38' },
                { label: 'Ön lastikler', value: '480/65 R28' },
                { label: 'Taşıma uzunluğu', value: '4.44 m' },
                { label: 'Taşıma yüksekliği', value: '2.74 m' },
                { label: 'Seyahat hızı', value: '40 km/h' },
                { label: 'Transmisyon', value: '16/16' },
                { label: 'İletim türü', value: 'LS' },
                { label: 'Ağırlık', value: '4.9 t' },
                { label: 'Kontrol ünitesi', value: '-/3 ew/dw' },
                { label: 'Üç nokta kategorisi', value: '3' },
                { label: 'Motor imalatçısı', value: 'FPT' },
                { label: 'Motor tipi', value: 'NEF 4' },
                { label: 'Deplasman', value: '4.485 l' },
                { label: 'Maks torkta devirler', value: '2000 rpm' },
                { label: 'Maks. dönme momenti', value: '573 Nm' },
                { label: 'Silindir sayısı', value: '4' },
                { label: 'Emisyon seviyesi', value: 'V' },
                { label: 'Kabin', value: 'Yes' },
                { label: 'Ön hidrolikler', value: 'No' },
                { label: 'Ön PTO', value: 'No' },
                { label: 'Hava Frenleri', value: 'Yes' },
                { label: 'ISO otobüs', value: 'Yes' },
                { label: 'Klima', value: 'Yes' },
                { label: 'Years of manufacture', value: '2022—2026' }
            ],
            fetched_at: new Date().toISOString()
        };
    }

    function buildModelIntelSearchLinks({ brandName = '', modelName = '', brandProfile = {} }) {
        const query = compactModelIntelText(`${brandName} ${modelName} traktör teknik özellikleri`);
        const imageQuery = compactModelIntelText(`${brandName} ${modelName} tractor photo`);
        const officialSite = brandProfile.website_url || brandProfile.website || '';
        let officialDomain = '';
        try {
            officialDomain = officialSite ? new URL(officialSite).hostname.replace(/^www\./, '') : '';
        } catch {
            officialDomain = '';
        }

        const links = [];
        if (officialSite) {
            links.push({ type: 'official', label: 'Marka resmi sitesi', url: officialSite, note: 'Resmi ürün, bayi ve katalog başlangıcı' });
        }
        if (brandProfile.price_list_url) {
            links.push({ type: 'price-list', label: 'Resmi fiyat/katalog', url: brandProfile.price_list_url, note: 'Marka portalındaki fiyat veya katalog bağlantısı' });
        }
        if (brandProfile.dealer_locator_url) {
            links.push({ type: 'dealer', label: 'Bayi/servis ağı', url: brandProfile.dealer_locator_url, note: 'Satış ve servis temas noktası' });
        }
        if (officialDomain) {
            links.push({
                type: 'official-search',
                label: 'Resmi sitede model ara',
                url: `https://www.google.com/search?q=${encodeURIComponent(`${brandName} ${modelName} site:${officialDomain}`)}`,
                note: 'Modelin marka sitesindeki sayfasını bulmak için'
            });
        }
        links.push({
            type: 'lectura',
            label: 'LECTURA teknik kaynak ara',
            url: `https://www.google.com/search?q=${encodeURIComponent(`site:lectura-specs.com ${brandName} ${modelName} tractor specs`)}`,
            note: 'Bağımsız teknik özellik ve ölçü katalogları'
        });
        links.push({
            type: 'images',
            label: 'Görsel araması',
            url: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(imageQuery)}`,
            note: 'Model fotoğrafı, kabin ve dış tasarım görüntüleri'
        });
        links.push({
            type: 'used-market',
            label: 'Sahibinden ilan araması',
            url: `https://www.sahibinden.com/arama?query=${encodeURIComponent(`${brandName} ${modelName}`)}`,
            note: 'Model yılına göre ikinci el fiyat sinyali'
        });
        links.push({
            type: 'global',
            label: 'Global satış/ülke izi',
            url: `https://www.google.com/search?q=${encodeURIComponent(`${brandName} ${modelName} countries sold factory engine transmission`)}`,
            note: 'Fabrika, motor, şanzıman ve ülke varlığı doğrulaması'
        });

        return links;
    }

    function getModelIntelRuntimeBase(req) {
        const requestBase = req?.get ? `${req.protocol}://${req.get('host')}` : '';
        return (APP_BASE_URL || requestBase || '').replace(/\/$/, '');
    }

    function parsePositiveInteger(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
    }

    function normalizeModelImageUrl(value = '') {
        const raw = compactModelIntelText(value);
        if (!raw) return '';
        try {
            const parsed = new URL(raw);
            if (!['http:', 'https:'].includes(parsed.protocol)) return '';
            return parsed.toString();
        } catch {
            return '';
        }
    }

    function sanitizeModelGalleryItem(item = {}, defaults = {}, index = 0) {
        const rawUrl = item.url || item.image_url || item.src || item.href || '';
        const url = normalizeModelImageUrl(rawUrl);
        if (!url) return null;

        const sourceUrl = normalizeModelImageUrl(
            item.source_url || item.source || item.page_url || item.product_url || defaults.source_url || defaults.sourceUrl || ''
        );
        const label = compactModelIntelText(
            item.label || item.angle_label || item.angle || item.caption || item.alt || defaults.label || (index === 0 ? 'Ana ürün görseli' : 'Ürün görseli')
        );
        const sourceName = compactModelIntelText(
            item.source_name || item.provider || item.publisher || defaults.source_name || defaults.sourceName || 'n8n model galeri'
        );
        const confidence = Number(item.confidence_score ?? item.confidence ?? defaults.confidence_score ?? 0.75);

        return {
            url,
            image_url: url,
            label,
            angle_label: compactModelIntelText(item.angle_label || item.angle || label || 'Ürün görseli'),
            caption: compactModelIntelText(item.caption || item.label || label),
            source: sourceUrl,
            source_url: sourceUrl,
            source_name: sourceName,
            width: parsePositiveInteger(item.width),
            height: parsePositiveInteger(item.height),
            confidence_score: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.75,
            model_match_level: compactModelIntelText(item.model_match_level || defaults.model_match_level || 'unknown'),
            verification_status: compactModelIntelText(item.verification_status || defaults.verification_status || 'candidate'),
            review_status: compactModelIntelText(item.review_status || defaults.review_status || 'candidate'),
            sort_order: Number.isFinite(Number(item.sort_order)) ? Math.round(Number(item.sort_order)) : (index + 1) * 10,
            is_primary: Boolean(item.is_primary || item.primary || index === 0),
            raw_payload: item.raw_payload || item
        };
    }

    function isPublishableModelGalleryItem(item = {}) {
        const confidence = Number(item.confidence_score || 0);
        const reviewStatus = String(item.review_status || '').toLowerCase();
        const verificationStatus = String(item.verification_status || '').toLowerCase();
        const matchLevel = String(item.model_match_level || '').toLowerCase();
        const approved = reviewStatus === 'approved' || verificationStatus === 'manual_approved';
        const exact = ['exact_model', 'exact_product_page', 'official_product_page', 'manual_verified'].includes(matchLevel);
        const verified = ['official_product_page', 'manual_approved', 'manual_verified', 'exact_model'].includes(verificationStatus);
        return approved && exact && verified && confidence >= 0.85;
    }

    function filterPublishableModelGallery(items = []) {
        return dedupeModelGallery(items.filter(isPublishableModelGalleryItem));
    }

    function dedupeModelGallery(items = []) {
        const seen = new Set();
        return items.filter(item => {
            if (!item?.url) return false;
            const key = item.url.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function mapModelGalleryDbRow(row = {}) {
        return {
            id: row.id,
            url: row.image_url,
            image_url: row.image_url,
            label: row.caption || row.angle_label || 'Ürün görseli',
            angle_label: row.angle_label || null,
            caption: row.caption || null,
            source: row.source_url || '',
            source_url: row.source_url || '',
            source_name: row.source_name || 'Model galeri',
            confidence_score: numberOrNull(row.confidence_score),
            model_match_level: row.model_match_level || 'unknown',
            verification_status: row.verification_status || 'candidate',
            review_status: row.review_status || 'candidate',
            sort_order: row.sort_order,
            is_primary: row.is_primary,
            provider: row.source_name || 'Model galeri'
        };
    }

    async function getModelImageGalleryFromDb({ brandName = '', modelName = '', tuikModelName = '' } = {}) {
        const brandAliases = normalizeBrandAliasesForModelIntel(brandName);
        const modelKeys = [...new Set([modelName, tuikModelName].map(toUpperPlain).filter(Boolean))];
        const modelPatterns = [...new Set([modelName, tuikModelName]
            .map(normalizeModelSearch)
            .filter(value => value.length >= 3)
            .map(value => `%${value}%`))];
        if (!brandAliases.length || !modelKeys.length) return [];

        const result = await pool.query(`
            SELECT *
            FROM model_image_gallery
            WHERE is_active = true
              AND review_status = 'approved'
              AND UPPER(brand_name) = ANY($1::text[])
              AND (
                UPPER(model_name) = ANY($2::text[])
                OR UPPER(COALESCE(tuik_model_adi, '')) = ANY($2::text[])
                OR model_name ILIKE ANY($3::text[])
                OR COALESCE(tuik_model_adi, '') ILIKE ANY($3::text[])
              )
            ORDER BY is_primary DESC, sort_order ASC, id ASC
            LIMIT 18
        `, [brandAliases, modelKeys, modelPatterns.length ? modelPatterns : ['__no_model_gallery_pattern__']]);

        return result.rows.map(mapModelGalleryDbRow);
    }

    async function upsertModelImageGallery({ brandName = '', modelName = '', tuikModelName = '', images = [] } = {}) {
        const cleanBrand = compactModelIntelText(brandName);
        const cleanModel = compactModelIntelText(modelName);
        if (!cleanBrand || !cleanModel || !Array.isArray(images) || !images.length) return [];

        const normalized = dedupeModelGallery(images
            .map((item, index) => sanitizeModelGalleryItem(item, {
                source_name: item?.source_name || item?.provider || 'n8n model galeri'
            }, index))
            .filter(Boolean));

        const saved = [];
        for (const [index, image] of normalized.entries()) {
            const result = await pool.query(`
                INSERT INTO model_image_gallery (
                    brand_name, model_name, tuik_model_adi, image_url, source_url, source_name,
                    angle_label, caption, width, height, confidence_score, model_match_level,
                    verification_status, review_status, verified_at, sort_order, is_primary,
                    raw_payload, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,NOW())
                ON CONFLICT (brand_name, model_name, image_url)
                DO UPDATE SET
                    tuik_model_adi = COALESCE(EXCLUDED.tuik_model_adi, model_image_gallery.tuik_model_adi),
                    source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), model_image_gallery.source_url),
                    source_name = COALESCE(NULLIF(EXCLUDED.source_name, ''), model_image_gallery.source_name),
                    angle_label = COALESCE(NULLIF(EXCLUDED.angle_label, ''), model_image_gallery.angle_label),
                    caption = COALESCE(NULLIF(EXCLUDED.caption, ''), model_image_gallery.caption),
                    width = COALESCE(EXCLUDED.width, model_image_gallery.width),
                    height = COALESCE(EXCLUDED.height, model_image_gallery.height),
                    confidence_score = GREATEST(COALESCE(EXCLUDED.confidence_score, 0), COALESCE(model_image_gallery.confidence_score, 0)),
                    model_match_level = COALESCE(NULLIF(EXCLUDED.model_match_level, ''), model_image_gallery.model_match_level),
                    verification_status = COALESCE(NULLIF(EXCLUDED.verification_status, ''), model_image_gallery.verification_status),
                    review_status = COALESCE(NULLIF(EXCLUDED.review_status, ''), model_image_gallery.review_status),
                    verified_at = COALESCE(EXCLUDED.verified_at, model_image_gallery.verified_at),
                    sort_order = LEAST(COALESCE(EXCLUDED.sort_order, 100), COALESCE(model_image_gallery.sort_order, 100)),
                    is_primary = model_image_gallery.is_primary OR EXCLUDED.is_primary,
                    is_active = true,
                    raw_payload = COALESCE(EXCLUDED.raw_payload, model_image_gallery.raw_payload),
                    updated_at = NOW()
                RETURNING *
            `, [
                cleanBrand,
                cleanModel,
                compactModelIntelText(tuikModelName) || null,
                image.url,
                image.source_url || '',
                image.source_name || '',
                image.angle_label || (index === 0 ? 'Ana ürün görseli' : 'Ürün görseli'),
                image.caption || image.label || '',
                image.width,
                image.height,
                image.confidence_score,
                image.model_match_level || 'unknown',
                image.verification_status || 'candidate',
                image.review_status || 'candidate',
                image.review_status === 'approved' ? new Date() : null,
                image.sort_order || (index + 1) * 10,
                image.is_primary || index === 0,
                JSON.stringify(image.raw_payload || image)
            ]);
            saved.push(mapModelGalleryDbRow(result.rows[0]));
        }

        return saved;
    }

    function buildModelPhotoSearchPlan({ brandName = '', modelName = '', tuikModelName = '', brandProfile = {}, sourceUrl = '', callbackUrl = '' } = {}) {
        const officialSite = brandProfile.website_url || brandProfile.website || '';
        let officialDomain = '';
        try {
            officialDomain = officialSite ? new URL(officialSite).hostname.replace(/^www\./, '') : '';
        } catch {
            officialDomain = '';
        }

        const modelLabel = compactModelIntelText(`${brandName} ${modelName || tuikModelName}`);
        const officialQuery = officialDomain
            ? `${modelLabel} site:${officialDomain}`
            : `${modelLabel} official tractor product page`;

        return {
            task: 'model_photo_gallery',
            brand: compactModelIntelText(brandName),
            model: compactModelIntelText(modelName),
            tuik_model_adi: compactModelIntelText(tuikModelName),
            source_url: sourceUrl || null,
            callback_url: callbackUrl || null,
            callback_header: MEDIA_WATCH_WEBHOOK_KEY ? { 'x-webhook-key': '<MEDIA_WATCH_WEBHOOK_KEY>' } : null,
            expected_angles: ['ana ürün görseli', 'ön görünüm', 'yan görünüm', 'arka görünüm', 'kabin içi', 'çalışma sahası'],
            search_queries: [
                officialQuery,
                `${modelLabel} traktör fotoğraf`,
                `${modelLabel} tractor gallery`,
                `${modelLabel} cabin interior tractor`
            ],
            acceptance_rules: [
                'URL doğrudan görsel dosyasına veya hotlink izinli CDN görseline işaret etmeli.',
                'Fotoğraf model adıyla eşleşmeli; marka logosu veya katalog kapağı tek başına yeterli değil.',
                'Öncelik resmi marka sitesi, katalog PDF görselleri ve doğrulanabilir bayi sayfalarıdır.',
                'Her görsel için kaynak sayfa, açı etiketi ve güven skoru döndürülmelidir.'
            ],
            response_contract: {
                images: [{
                    url: 'https://...',
                    source_url: 'https://...',
                    source_name: 'Resmi marka sitesi',
                    angle_label: 'yan görünüm',
                    caption: 'Model adı ve seri bilgisi',
                    confidence_score: 0.92,
                    model_match_level: 'exact_product_page',
                    verification_status: 'official_product_page',
                    review_status: 'approved',
                    is_primary: true
                }]
            }
        };
    }

    async function fetchN8nModelImageGallery(payload = {}) {
        if (!N8N_MODEL_INTEL_WEBHOOK_URL) {
            return { status: 'not_configured', images: [], raw: null };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 14000);
        try {
            const response = await fetch(N8N_MODEL_INTEL_WEBHOOK_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    ...(MEDIA_WATCH_WEBHOOK_KEY ? { 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY } : {})
                },
                body: JSON.stringify(payload)
            });
            const text = await response.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = { message: text };
            }
            if (!response.ok) {
                return {
                    status: 'error',
                    images: [],
                    error: data?.error || data?.message || `n8n HTTP ${response.status}`,
                    raw: data
                };
            }

            const rawImages = Array.isArray(data)
                ? data
                : (data.images || data.image_gallery || data.gallery || data.data?.images || []);
            const images = dedupeModelGallery((Array.isArray(rawImages) ? rawImages : [])
                .map((item, index) => sanitizeModelGalleryItem(item, { source_name: 'n8n model galeri' }, index))
                .filter(Boolean));

            return {
                status: images.length ? 'ready' : (response.status === 202 || data.status === 'accepted' ? 'accepted' : 'empty'),
                images,
                raw: data
            };
        } catch (err) {
            return {
                status: 'error',
                images: [],
                error: err.name === 'AbortError' ? 'n8n galeri taraması zaman aşımına uğradı' : err.message,
                raw: null
            };
        } finally {
            clearTimeout(timer);
        }
    }

    function inferKnownModelImageGallery(brandName = '', modelName = '') {
        const brandKey = normalizeTurkishSearchKey(brandName);
        const modelKey = normalizeTurkishSearchKey(modelName).replace(/\s+/g, '');
        const gallery = [];
        const brandReferenceImages = [
            {
                matches: ['TUMOSAN', 'TÜMOSAN'],
                url: 'https://www.tumosan.com.tr/uploads/2023/07/8000-serisi-1_op.jpg',
                source_url: 'https://www.tumosan.com.tr/en/products/8095',
                source_name: 'TÜMOSAN 8000 Serisi',
                caption: 'TÜMOSAN marka referans traktör görseli'
            },
            {
                matches: ['BASAK', 'BAŞAK'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Ba%C5%9Fak%20Trakt%C3%B6r%20Agritechnica%202017.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Ba%C5%9Fak_Trakt%C3%B6r_Agritechnica_2017.jpg',
                source_name: 'Wikimedia Commons Başak Traktör',
                caption: 'Başak marka referans traktör görseli'
            },
            {
                matches: ['NEW HOLLAND'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:New%20Holland%207840%20tractor%20%2819330925415%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:New_Holland_7840_tractor_(19330925415).jpg',
                source_name: 'Wikimedia Commons New Holland',
                caption: 'New Holland marka referans traktör görseli'
            },
            {
                matches: ['MASSEY FERGUSON'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Massey%20Ferguson%205460%20tractor%20%2823472773879%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Massey_Ferguson_5460_tractor_(23472773879).jpg',
                source_name: 'Wikimedia Commons Massey Ferguson',
                caption: 'Massey Ferguson marka referans traktör görseli'
            },
            {
                matches: ['JOHN DEERE'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:John%20Deere%20tractor%20%281%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:John_Deere_tractor_(1).jpg',
                source_name: 'Wikimedia Commons John Deere',
                caption: 'John Deere marka referans traktör görseli'
            },
            {
                matches: ['CASE', 'CASE IH'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Case%20IH%2C%20WAW%281%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Case_IH,_WAW(1).jpg',
                source_name: 'Wikimedia Commons Case IH',
                caption: 'Case IH marka referans traktör görseli'
            },
            {
                matches: ['DEUTZ', 'DEUTZ-FAHR'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Deutz%20100%2006%20tractor%20%2817135177425%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Deutz_100_06_tractor_(17135177425).jpg',
                source_name: 'Wikimedia Commons Deutz',
                caption: 'Deutz marka referans traktör görseli'
            },
            {
                matches: ['KUBOTA'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Kubota%20tractor%20%2850600439387%29.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Kubota_tractor_(50600439387).jpg',
                source_name: 'Wikimedia Commons Kubota',
                caption: 'Kubota marka referans traktör görseli'
            },
            {
                matches: ['FENDT'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Fendt%20933%20tractor.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Fendt_933_tractor.jpg',
                source_name: 'Wikimedia Commons Fendt',
                caption: 'Fendt marka referans traktör görseli'
            },
            {
                matches: ['VALTRA'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Valtra%204th%20generation%20N%20Series%20tractor.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Valtra_4th_generation_N_Series_tractor.jpg',
                source_name: 'Wikimedia Commons Valtra',
                caption: 'Valtra marka referans traktör görseli'
            },
            {
                matches: ['LANDINI', 'MCCORMICK'],
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Landini%20Tractor%201706.JPG',
                source_url: 'https://commons.wikimedia.org/wiki/File:Landini_Tractor_1706.JPG',
                source_name: 'Wikimedia Commons Landini',
                caption: 'Landini marka referans traktör görseli'
            }
        ];

        if ((brandKey.includes('TUMOSAN') || brandKey.includes('TÜMOSAN')) && modelKey.includes('8110')) {
            gallery.push({
                url: 'https://www.tumosan.com.tr/uploads/2023/07/8100-1616-serisi-1_op.jpg',
                source_url: 'https://www.tumosan.com.tr/tr/urunler/8110',
                source_name: 'Tümosan resmi ürün sayfası',
                angle_label: 'resmi ürün görseli',
                caption: 'Tümosan 8110 resmi ürün sayfasındaki alt=8110 görseli',
                confidence_score: 0.98,
                model_match_level: 'exact_product_page',
                verification_status: 'official_product_page',
                review_status: 'approved',
                is_primary: true
            });
        }

        if (brandKey.includes('NEW HOLLAND')) {
            if (modelKey.startsWith('TT') || modelKey.includes('TT60') || modelKey.includes('TT55') || modelKey.includes('TT65') || modelKey.includes('TT75')) {
                gallery.push(
                    {
                        url: 'https://i.machinio.com/medium/al/5qj7ap/2086954677_2/ddf6/new-holland-tt60-tractor.jpg',
                        source_url: 'https://www.machinio.com/listings/1604-new-holland-tt60-tractor',
                        source_name: 'Machinio TT60 ilan görseli',
                        angle_label: 'ana görünüm',
                        caption: `${brandName} ${modelName} ürün fotoğrafı`,
                        confidence_score: modelKey.includes('TT60') ? 0.86 : 0.68,
                        is_primary: true
                    },
                    {
                        url: 'https://cnhi-p-001-delivery.sitecorecontenthub.cloud/api/public/content/1918e3190db14d60a6e32f9f1290ef26?t=size500&v=45a64884',
                        source_url: 'https://agriculture.newholland.com/en/asiapacific/products/agricultural-tractors/tt',
                        source_name: 'New Holland resmi TT seri sayfası',
                        angle_label: 'seri görseli',
                        caption: 'New Holland TT seri resmi ürün görseli',
                        confidence_score: 0.74,
                        is_primary: false
                    }
                );
            }

            if (modelKey.startsWith('T5') || modelKey.includes('T590') || modelKey.includes('T5.90')) {
                gallery.push(
                    {
                        url: 'https://imagedelivery.net/mhuCRcTxCdbPtYk1I1TKMA/roc%2Fbinghamequipment%2F31906f463585214bde2976d0d14ca93c/New%20Holland%20T5.90%20Tractor.jpg/400x400',
                        source_url: 'https://www.binghamequipment.com/products/catalog/equipment/tractors/new-holland/new-holland-t5-90-dual-command-tractor/t5-90-dual-command',
                        source_name: 'Bingham Equipment T5.90 ürün sayfası',
                        angle_label: 'ana görünüm',
                        caption: `${brandName} ${modelName} ürün fotoğrafı`,
                        confidence_score: modelKey.includes('T590') || modelKey.includes('T5.90') ? 0.9 : 0.72,
                        is_primary: true
                    },
                    {
                        url: 'https://imagedelivery.net/mhuCRcTxCdbPtYk1I1TKMA/roc%2Fbinghamequipment%2F62ef39de8e0f03e92046f0fac8367293/New%20Holland%20T5%20tractor.png/400x400',
                        source_url: 'https://www.binghamequipment.com/products/catalog/equipment/tractors/new-holland/new-holland-t5-90-dual-command-tractor/t5-90-dual-command',
                        source_name: 'Bingham Equipment T5 seri görseli',
                        angle_label: 'seri görünüm',
                        caption: 'New Holland T5 seri ürün görseli',
                        confidence_score: 0.76,
                        is_primary: false
                    }
                );
            }
        }

        if (!gallery.length) {
            const brandReference = brandReferenceImages.find(item => item.matches.some(match => brandKey.includes(match)));
            const fallback = brandReference || {
                url: 'https://commons.wikimedia.org/wiki/Special:FilePath/File:Tractor-agricultural-machine-cultivating-field.jpg',
                source_url: 'https://commons.wikimedia.org/wiki/File:Tractor-agricultural-machine-cultivating-field.jpg',
                source_name: 'Wikimedia Commons traktör referansı',
                caption: 'Traktör marka/model referans görseli'
            };
            gallery.push({
                ...fallback,
                angle_label: 'referans görünüm',
                caption: `${brandName} ${modelName} için ${fallback.caption || 'referans traktör görseli'}`,
                confidence_score: brandReference ? 0.42 : 0.28,
                is_primary: true
            });
        }

        return dedupeModelGallery(gallery
            .map((item, index) => sanitizeModelGalleryItem(item, {
                source_name: 'Bilinen model görsel kaynağı'
            }, index))
            .filter(Boolean));
    }

    function mapTechnicalVariantForIntel(row = {}) {
        return {
            id: row.id,
            brand_name: row.marka,
            model_name: row.model || row.tuik_model_adi,
            tuik_model_name: row.tuik_model_adi,
            price_usd: numberOrNull(row.fiyat_usd),
            design: {
                origin: row.mensei || null,
                use_case: row.kullanim_alani || null,
                protection: row.koruma || null,
                drive_type: row.cekis_tipi || null,
                model_years: row.model_yillari || null
            },
            engine: {
                brand: row.motor_marka || null,
                power_hp: numberOrNull(row.motor_gucu_hp),
                rated_rpm: numberOrNull(row.motor_devri_rpm),
                max_torque_nm: numberOrNull(row.maksimum_tork),
                cylinders: numberOrNull(row.silindir_sayisi),
                emission: row.emisyon_seviyesi || null
            },
            transmission: {
                gear_config: row.vites_sayisi || null
            },
            hydraulics: {
                lift_capacity_kg: numberOrNull(row.hidrolik_kaldirma)
            },
            dimensions: {
                fuel_tank_liters: numberOrNull(row.depo_hacmi_lt),
                weight_kg: numberOrNull(row.agirlik),
                wheelbase_mm: numberOrNull(row.dingil_mesafesi),
                length_mm: numberOrNull(row.uzunluk),
                width_mm: numberOrNull(row.genislik),
                height_mm: numberOrNull(row.yukseklik)
            }
        };
    }

    function buildModelIntelSpecGroups(primary = {}, tractorModel = {}, externalSource = null) {
        const engine = primary.engine || {};
        const design = primary.design || {};
        const transmission = primary.transmission || {};
        const hydraulics = primary.hydraulics || {};
        const dimensions = primary.dimensions || {};
        const externalSpec = (...labels) => {
            const specs = externalSource?.specs || [];
            for (const label of labels) {
                const item = specs.find(spec => String(spec.label || '').toLocaleLowerCase('tr-TR') === String(label || '').toLocaleLowerCase('tr-TR'));
                if (item?.value !== undefined && item.value !== null && item.value !== '') return item.value;
            }
            return null;
        };

        return {
            hero: [
                { label: 'Motor gücü', value: engine.power_hp || tractorModel.horsepower, unit: 'HP' },
                { label: 'Fiyat', value: primary.price_usd || tractorModel.price_usd, format: 'usd' },
                { label: 'Çekiş', value: design.drive_type || tractorModel.drive_type },
                { label: 'Kabin/koruma', value: design.protection || tractorModel.cabin_type }
            ],
            design: [
                { label: 'Kullanım sınıfı', value: design.use_case || tractorModel.category },
                { label: 'Menşei', value: design.origin },
                { label: 'Model yılları', value: design.model_years },
                { label: 'Koruma', value: design.protection || tractorModel.cabin_type },
                { label: 'Çekiş tipi', value: design.drive_type || tractorModel.drive_type },
                { label: 'Kabin donanımı', value: externalSpec('Kabin donanımı') },
                { label: 'Standart konfor', value: externalSpec('Standart konfor') }
            ],
            engine: [
                { label: 'Motor markası', value: engine.brand || tractorModel.engine_brand },
                { label: 'Motor gücü', value: engine.power_hp || tractorModel.horsepower, unit: 'HP' },
                { label: 'Motor devri', value: engine.rated_rpm, unit: 'rpm' },
                { label: 'Silindir / aspirasyon', value: externalSpec('Silindir Sayısı / Aspirasyon') },
                { label: 'Silindir hacmi', value: externalSpec('Silindir Hacmi') },
                { label: 'Maksimum tork', value: engine.max_torque_nm || tractorModel.max_torque_nm || externalSpec('Maksimum Tork') },
                { label: 'Azami tork devri', value: externalSpec('Azami Tork Devri') },
                { label: 'Silindir', value: engine.cylinders || tractorModel.cylinder_count },
                { label: 'Emisyon', value: engine.emission || tractorModel.emission_standard || externalSpec('Emisyon Seviyesi') },
                { label: 'Hava filtresi', value: externalSpec('Hava Filtresi Tipi') }
            ],
            transmission: [
                { label: 'Şanzıman/vites', value: transmission.gear_config || tractorModel.gear_config || externalSpec('Vites Seçeneği') },
                { label: 'Transmisyon tipi', value: tractorModel.transmission_type || externalSpec('Dişli Kutusu Tipi') },
                { label: 'İleri vites', value: tractorModel.forward_gears },
                { label: 'Geri vites', value: tractorModel.reverse_gears },
                { label: 'İleri-geri mekik', value: externalSpec('İleri - Geri Mekik Kolu') },
                { label: 'Çift çeker kumandası', value: externalSpec('Çift Çeker Kumandası') },
                { label: 'Ön diferansiyel kilidi', value: externalSpec('Ön Diferansiyel Kilidi') },
                { label: 'Arka diferansiyel kilidi', value: externalSpec('Arka Diferansiyel Kilidi') },
                { label: 'Shuttle', value: tractorModel.has_shuttle === true ? 'Var' : tractorModel.has_shuttle === false ? 'Yok' : null },
                { label: 'Creeper', value: tractorModel.has_creeper === true ? 'Var' : tractorModel.has_creeper === false ? 'Yok' : null }
            ],
            hydraulics: [
                { label: 'Hidrolik kaldırma', value: hydraulics.lift_capacity_kg || tractorModel.lift_capacity_kg || externalSpec('Kaldırma Kapasitesi') },
                { label: 'Hidrolik kapasite', value: tractorModel.hydraulic_capacity_lpm, unit: 'lt/dk' },
                { label: 'Hidrolik güç çıkışı', value: externalSpec('Hidrolik Güç Çıkışı') },
                { label: 'PTO', value: tractorModel.pto_rpm || externalSpec('Kuyruk Mili Devri') },
                { label: 'PTO tipi', value: externalSpec('PTO Tipi') },
                { label: 'PTO kumanda', value: externalSpec('PTO Kumanda Şekli') },
                { label: 'PTO gücü', value: tractorModel.pto_power_hp, unit: 'HP' },
                { label: 'Yakıt deposu', value: dimensions.fuel_tank_liters || tractorModel.fuel_tank_liters, unit: 'lt' }
            ],
            dimensions: [
                { label: 'Ağırlık', value: dimensions.weight_kg || tractorModel.weight_kg || externalSpec('Yüksüz Kütle - 4WD Kabinli'), unit: 'kg' },
                { label: 'Dingil mesafesi', value: dimensions.wheelbase_mm || tractorModel.wheelbase_mm, unit: 'mm' },
                { label: 'Uzunluk', value: dimensions.length_mm || tractorModel.length_mm, unit: 'mm' },
                { label: 'Genişlik', value: dimensions.width_mm || tractorModel.width_mm, unit: 'mm' },
                { label: 'Yükseklik', value: dimensions.height_mm || tractorModel.height_mm, unit: 'mm' },
                { label: 'Ön lastik', value: tractorModel.front_tire || externalSpec('1. Opsiyon 4WD-Ön', '2. Opsiyon 4WD-Ön') },
                { label: 'Arka lastik', value: tractorModel.rear_tire || externalSpec('1. Opsiyon 4WD-Arka', '2. Opsiyon 4WD-Arka') }
            ]
        };
    }

    app.get('/api/models', authMiddleware, async (req, res) => {
        try {
            const { brand_id, category, drive_type, cabin_type, hp_min, hp_max, q } = req.query;
            const turkishSqlChars = '\u0130I\u0131\u015E\u015F\u011E\u011F\u00DC\u00FC\u00D6\u00F6\u00C7\u00E7';
            const asciiSqlChars = 'IIISSGGUUOOCC';
            const normalizedSqlText = (expr) => `
                TRANSLATE(
                    UPPER(COALESCE(${expr}, '')),
                    '${turkishSqlChars}',
                    '${asciiSqlChars}'
                )
            `;
            const brandAliasExpr = (expr) => `
                CASE
                    WHEN ${normalizedSqlText(expr)} IN ('CASE IH', 'CASEIH') THEN 'CASE'
                    WHEN ${normalizedSqlText(expr)} IN ('DEUTZ-FAHR', 'DEUTZ FAHR') THEN 'DEUTZ'
                    ELSE ${normalizedSqlText(expr)}
                END
            `;
            const modelNameExpr = `COALESCE(NULLIF(TRIM(tk.model), ''), NULLIF(TRIM(tk.tuik_model_adi), ''))`;
            const useCaseExpr = normalizedSqlText('tk.kullanim_alani');
            const driveExpr = normalizedSqlText('tk.cekis_tipi');
            const protectionExpr = normalizedSqlText('tk.koruma');

            let query = `
                SELECT
                    (MIN(tk.id) + 100000)::int AS id,
                    b.id AS brand_id,
                    b.name AS brand_name,
                    b.slug AS brand_slug,
                    ${modelNameExpr} AS model_name,
                    MIN(NULLIF(TRIM(tk.tuik_model_adi), '')) AS model_code,
                    ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) AS horsepower,
                    ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) AS price_usd,
                    ROUND(AVG(NULLIF(tk.agirlik, 0))::numeric, 0) AS weight_kg,
                    MODE() WITHIN GROUP (ORDER BY
                        CASE
                            WHEN ${useCaseExpr} LIKE '%BAHCE%' AND ${useCaseExpr} LIKE '%TARLA%' THEN 'hibrit'
                            WHEN ${useCaseExpr} LIKE '%HIBRIT%' THEN 'hibrit'
                            WHEN ${useCaseExpr} LIKE '%BAHCE%' THEN 'bahce'
                            WHEN ${useCaseExpr} LIKE '%TARLA%' THEN 'tarla'
                            ELSE 'tarla'
                        END
                    ) AS category,
                    MODE() WITHIN GROUP (ORDER BY
                        CASE
                            WHEN ${protectionExpr} LIKE '%KABIN%' THEN 'kabinli'
                            WHEN ${protectionExpr} LIKE '%ROPS%' OR ${protectionExpr} LIKE '%ROLL%' THEN 'rollbar'
                            ELSE NULLIF(tk.koruma, '')
                        END
                    ) AS cabin_type,
                    MODE() WITHIN GROUP (ORDER BY
                        CASE
                            WHEN ${driveExpr} LIKE '%4%' THEN '4WD'
                            WHEN ${driveExpr} LIKE '%2%' THEN '2WD'
                            ELSE NULLIF(UPPER(tk.cekis_tipi), '')
                        END
                    ) AS drive_type,
                    MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.vites_sayisi), '')) AS gear_config,
                    MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.motor_marka), '')) AS engine_brand,
                    MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(tk.emisyon_seviyesi), '')) AS emission_standard,
                    'teknik_veri' AS source_table
                FROM teknik_veri tk
                JOIN brands b ON ${brandAliasExpr('tk.marka')} = ${brandAliasExpr('b.name')}
                WHERE ${modelNameExpr} IS NOT NULL
            `;
            const params = [];
            if (brand_id) { params.push(brand_id); query += ` AND b.id = $${params.length}`; }
            if (category) {
                const normalizedCategory = normalizeTurkishSearchKey(category).toLowerCase();
                if (normalizedCategory === 'bahce') {
                    query += ` AND (${useCaseExpr} LIKE '%BAHCE%' OR ${useCaseExpr} LIKE '%HIBRIT%')`;
                } else if (normalizedCategory === 'tarla') {
                    query += ` AND (${useCaseExpr} LIKE '%TARLA%' OR ${useCaseExpr} LIKE '%HIBRIT%')`;
                } else if (normalizedCategory === 'hibrit') {
                    query += ` AND (${useCaseExpr} LIKE '%HIBRIT%' OR (${useCaseExpr} LIKE '%BAHCE%' AND ${useCaseExpr} LIKE '%TARLA%'))`;
                }
            }
            if (drive_type) {
                const normalizedDrive = normalizeTurkishSearchKey(drive_type);
                if (normalizedDrive.includes('4')) {
                    query += ` AND ${driveExpr} LIKE '%4%'`;
                } else if (normalizedDrive.includes('2')) {
                    query += ` AND ${driveExpr} LIKE '%2%'`;
                }
            }
            if (cabin_type) {
                const normalizedCabin = normalizeTurkishSearchKey(cabin_type).toLowerCase();
                if (normalizedCabin === 'kabinli' || normalizedCabin === 'kabin') {
                    query += ` AND ${protectionExpr} LIKE '%KABIN%'`;
                } else if (normalizedCabin === 'rollbar' || normalizedCabin === 'rops') {
                    query += ` AND (${protectionExpr} LIKE '%ROPS%' OR ${protectionExpr} LIKE '%ROLL%')`;
                }
            }
            if (hp_min) { params.push(Number(hp_min)); query += ` AND tk.motor_gucu_hp >= $${params.length}`; }
            if (hp_max) { params.push(Number(hp_max)); query += ` AND tk.motor_gucu_hp <= $${params.length}`; }
            if (q) {
                params.push(`%${normalizeTurkishSearchKey(q)}%`);
                query += ` AND (
                    ${normalizedSqlText('tk.model')} LIKE $${params.length}
                    OR ${normalizedSqlText('tk.tuik_model_adi')} LIKE $${params.length}
                )`;
            }
            query += `
                GROUP BY b.id, b.name, b.slug, ${modelNameExpr}
                ORDER BY b.name, ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) NULLS LAST, model_name
                LIMIT 500
            `;
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            console.error('Models list error:', err);
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

    app.get('/api/model-intelligence', authMiddleware, async (req, res) => {
        try {
            const brandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;
            const brandQuery = normalizeModelSearch(req.query.brand || '');
            const modelQuery = normalizeModelSearch(req.query.model || req.query.q || '');
            const tuikModelQuery = normalizeModelSearch(req.query.tuik_model_adi || req.query.model_code || '');
            const requestedModelNames = [...new Set([modelQuery, tuikModelQuery].filter(Boolean))];
            const requestedSourceUrl = normalizeModelSearch(req.query.source_url || '');

            if (!brandId && !brandQuery && !modelQuery && !tuikModelQuery && !requestedSourceUrl) {
                return res.status(400).json({ error: 'brand_id, brand, model veya source_url gerekli' });
            }

            let brandProfile = null;
            if (brandId || brandQuery) {
                const profileWhere = brandId
                    ? 'b.id = $1'
                    : '(UPPER(b.name) = UPPER($1) OR b.slug = LOWER($1))';
                const profileRes = await pool.query(`
                    SELECT
                        b.id, b.name, b.slug, b.logo_url, b.primary_color, b.secondary_color,
                        b.country_of_origin, b.parent_company, b.website, b.description,
                        p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url,
                        p.headquarters, p.source_notes_json
                    FROM brands b
                    LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                    WHERE ${profileWhere}
                    LIMIT 1
                `, [brandId || brandQuery]);
                brandProfile = profileRes.rows[0] || null;
            }

            let brandAliases = normalizeBrandAliasesForModelIntel(brandProfile?.name || brandQuery);
            const techParams = [];
            const techWhere = [];
            let modelExactIdx = null;
            if (brandAliases.length) {
                techParams.push(brandAliases);
                techWhere.push(`UPPER(tk.marka) = ANY($${techParams.length}::text[])`);
            }
            if (requestedModelNames.length) {
                techParams.push(requestedModelNames.map(toUpperPlain));
                modelExactIdx = techParams.length;
                techParams.push(requestedModelNames.map(value => `%${value}%`));
                const likeIdx = techParams.length;
                techWhere.push(`(
                    UPPER(tk.tuik_model_adi) = ANY($${modelExactIdx}::text[])
                    OR UPPER(tk.model) = ANY($${modelExactIdx}::text[])
                    OR tk.tuik_model_adi ILIKE ANY($${likeIdx}::text[])
                    OR tk.model ILIKE ANY($${likeIdx}::text[])
                )`);
            }

            let technicalRows = [];
            if (techWhere.length) {
                const orderExactSql = modelExactIdx
                    ? `CASE WHEN UPPER(tk.tuik_model_adi) = ANY($${modelExactIdx}::text[]) OR UPPER(tk.model) = ANY($${modelExactIdx}::text[]) THEN 0 ELSE 1 END,`
                    : '';
                const technicalRes = await pool.query(`
                    SELECT *
                    FROM teknik_veri tk
                    WHERE ${techWhere.join(' AND ')}
                    ORDER BY
                        ${orderExactSql}
                        tk.motor_gucu_hp NULLS LAST,
                        tk.fiyat_usd NULLS LAST,
                        tk.model
                    LIMIT 18
                `, techParams);
                technicalRows = technicalRes.rows;
            }

            if (!brandProfile && technicalRows[0]?.marka) {
                brandAliases = normalizeBrandAliasesForModelIntel(technicalRows[0].marka);
                const profileRes = await pool.query(`
                    SELECT
                        b.id, b.name, b.slug, b.logo_url, b.primary_color, b.secondary_color,
                        b.country_of_origin, b.parent_company, b.website, b.description,
                        p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url,
                        p.headquarters, p.source_notes_json
                    FROM brands b
                    LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                    WHERE UPPER(b.name) = ANY($1::text[])
                    LIMIT 1
                `, [brandAliases]);
                brandProfile = profileRes.rows[0] || null;
            }

            const tmParams = [];
            const tmWhere = ['m.is_current_model = true'];
            if (brandProfile?.id) {
                tmParams.push(brandProfile.id);
                tmWhere.push(`m.brand_id = $${tmParams.length}`);
            } else if (brandAliases.length) {
                tmParams.push(brandAliases);
                tmWhere.push(`UPPER(b.name) = ANY($${tmParams.length}::text[])`);
            }
            if (requestedModelNames.length) {
                tmParams.push(requestedModelNames.map(value => `%${value}%`));
                tmWhere.push(`m.model_name ILIKE ANY($${tmParams.length}::text[])`);
            }

            const tractorModelRes = await pool.query(`
                SELECT m.*, b.name AS brand_name, b.primary_color, b.logo_url
                FROM tractor_models m
                JOIN brands b ON b.id = m.brand_id
                WHERE ${tmWhere.join(' AND ')}
                ORDER BY m.horsepower NULLS LAST, m.model_name
                LIMIT 6
            `, tmParams);
            const tractorModel = tractorModelRes.rows[0] || {};

            const effectiveBrandName = brandProfile?.name || tractorModel.brand_name || technicalRows[0]?.marka || brandQuery || '';
            const effectiveModelName = technicalRows[0]?.model || technicalRows[0]?.tuik_model_adi || tractorModel.model_name || modelQuery || '';
            if (!brandAliases.length && effectiveBrandName) {
                brandAliases = normalizeBrandAliasesForModelIntel(effectiveBrandName);
            }

            const mappedVariants = technicalRows.map(mapTechnicalVariantForIntel);
            const primaryVariant = mappedVariants[0] || {};
            let specGroups = buildModelIntelSpecGroups(primaryVariant, tractorModel);
            const prices = mappedVariants.map(item => item.price_usd).filter(value => value && value > 0);
            const powers = mappedVariants.map(item => item.engine?.power_hp).filter(value => value && value > 0);
            const priceStats = {
                min_usd: prices.length ? Math.min(...prices) : numberOrNull(tractorModel.price_usd),
                max_usd: prices.length ? Math.max(...prices) : numberOrNull(tractorModel.price_usd),
                avg_usd: prices.length ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length) : numberOrNull(tractorModel.price_usd)
            };
            const hpStats = {
                min_hp: powers.length ? Math.min(...powers) : numberOrNull(tractorModel.horsepower),
                max_hp: powers.length ? Math.max(...powers) : numberOrNull(tractorModel.horsepower),
                avg_hp: powers.length ? Math.round((powers.reduce((sum, value) => sum + value, 0) / powers.length) * 10) / 10 : numberOrNull(tractorModel.horsepower)
            };

            const modelWindowFilter = `
                tv.tescil_yil IS NOT NULL
                AND tv.tescil_ay IS NOT NULL
                AND (tv.model_yili IS NULL OR tv.tescil_yil = tv.model_yili OR tv.tescil_yil = tv.model_yili + 1)
            `;
            const salesParams = [];
            const salesWhere = [modelWindowFilter];
            if (brandAliases.length) {
                salesParams.push(brandAliases);
                salesWhere.push(`UPPER(tv.marka) = ANY($${salesParams.length}::text[])`);
            }
            const salesModelNames = [...new Set([
                technicalRows[0]?.tuik_model_adi,
                tuikModelQuery,
                tractorModel.model_name,
                modelQuery
            ].map(normalizeModelSearch).filter(Boolean))];
            if (salesModelNames.length) {
                salesParams.push(salesModelNames.map(value => `%${value}%`));
                salesWhere.push(`tv.tuik_model_adi ILIKE ANY($${salesParams.length}::text[])`);
            }

            const salesWhereSql = salesWhere.join(' AND ');
            const shouldRunSales = Boolean(salesModelNames.length || brandAliases.length);
            const [
                salesSummaryRes,
                salesYearRes,
                salesProvinceRes,
                salesColorRes,
                salesModelYearRes,
                salesDisplacementRes
            ] = shouldRunSales
                ? await Promise.all([
                    pool.query(`
                        SELECT
                            COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales,
                            COUNT(*)::int AS row_count,
                            MIN(tv.tescil_yil)::int AS first_year,
                            MAX(tv.tescil_yil)::int AS latest_year,
                            MAX(MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1)) AS latest_period
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql}
                    `, salesParams),
                    pool.query(`
                        SELECT tv.tescil_yil AS year, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql}
                        GROUP BY tv.tescil_yil
                        ORDER BY tv.tescil_yil
                    `, salesParams),
                    pool.query(`
                        SELECT tv.sehir_adi AS province_name, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql}
                        GROUP BY tv.sehir_adi
                        ORDER BY total_sales DESC
                        LIMIT 8
                    `, salesParams),
                    pool.query(`
                        SELECT NULLIF(TRIM(tv.renk), '') AS color, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql} AND NULLIF(TRIM(tv.renk), '') IS NOT NULL
                        GROUP BY NULLIF(TRIM(tv.renk), '')
                        ORDER BY total_sales DESC
                        LIMIT 6
                    `, salesParams),
                    pool.query(`
                        SELECT tv.model_yili AS model_year, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql} AND tv.model_yili IS NOT NULL
                        GROUP BY tv.model_yili
                        ORDER BY tv.model_yili DESC
                        LIMIT 8
                    `, salesParams),
                    pool.query(`
                        SELECT NULLIF(TRIM(tv.motor_hacmi_cc), '') AS displacement, COALESCE(SUM(tv.satis_adet), 0)::int AS total_sales
                        FROM tuik_veri tv
                        WHERE ${salesWhereSql} AND NULLIF(TRIM(tv.motor_hacmi_cc), '') IS NOT NULL
                        GROUP BY NULLIF(TRIM(tv.motor_hacmi_cc), '')
                        ORDER BY total_sales DESC
                        LIMIT 6
                    `, salesParams)
                ])
                : [{ rows: [{}] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];

            const sourceUrl = requestedSourceUrl || inferKnownModelSourceUrl(effectiveBrandName, effectiveModelName);
            const externalSource = sourceUrl ? await fetchExternalModelSource(sourceUrl) : null;
            specGroups = buildModelIntelSpecGroups(primaryVariant, tractorModel, externalSource);
            const galleryTuikModelName = technicalRows[0]?.tuik_model_adi || tuikModelQuery || salesModelNames[0] || '';
            const persistedGallery = await getModelImageGalleryFromDb({
                brandName: effectiveBrandName,
                modelName: effectiveModelName,
                tuikModelName: galleryTuikModelName
            });
            const externalGallery = dedupeModelGallery([
                externalSource?.image_url
                    ? {
                        url: externalSource.image_url,
                        label: `${externalSource.image_provider || externalSource.provider || 'Harici kaynak'} görseli`,
                        source: externalSource.image_source_url || externalSource.url || sourceUrl || '',
                        source_name: externalSource.image_provider || externalSource.provider || 'Harici kaynak',
                        model_match_level: externalSource.model_match_level || 'unknown',
                        verification_status: externalSource.verification_status || 'candidate',
                        review_status: externalSource.review_status || 'candidate',
                        confidence_score: externalSource.review_status === 'approved' ? 0.96 : 0.75,
                        is_primary: true
                    }
                    : null,
                ...(Array.isArray(externalSource?.image_gallery) ? externalSource.image_gallery : [])
            ]
                .filter(Boolean)
                .map((item, index) => sanitizeModelGalleryItem(item, {
                    source_url: externalSource?.url || sourceUrl || '',
                    source_name: externalSource?.provider || 'Harici kaynak',
                    model_match_level: externalSource?.model_match_level || 'unknown',
                    verification_status: externalSource?.verification_status || 'candidate',
                    review_status: externalSource?.review_status || 'candidate'
                }, index))
                .filter(Boolean));
            const fallbackGallery = inferKnownModelImageGallery(effectiveBrandName, effectiveModelName);
            const callbackBase = getModelIntelRuntimeBase(req);
            const photoSearchPlan = buildModelPhotoSearchPlan({
                brandName: effectiveBrandName,
                modelName: effectiveModelName,
                tuikModelName: galleryTuikModelName,
                brandProfile: brandProfile || {},
                sourceUrl,
                callbackUrl: callbackBase ? `${callbackBase}/api/model-intelligence/gallery-callback` : ''
            });
            const candidateGallery = [
                ...persistedGallery,
                ...externalGallery,
                ...fallbackGallery
            ]
                .filter(Boolean)
                .filter((item, index, list) => list.findIndex(candidate => candidate.url === item.url) === index);
            const imageGallery = filterPublishableModelGallery(candidateGallery);
            const galleryStatus = {
                image_count: imageGallery.length,
                candidate_count: candidateGallery.length,
                blocked_candidate_count: Math.max(0, candidateGallery.length - imageGallery.length),
                persisted_count: persistedGallery.length,
                external_count: externalGallery.length,
                fallback_count: fallbackGallery.length,
                source: imageGallery.length ? (imageGallery[0].source_name || 'verified_gallery') : 'source_needed',
                source_label: imageGallery.length ? (imageGallery[0].source_name || 'Doğrulanmış model görseli') : 'Doğrulanmış model görseli bekleniyor',
                policy: 'Sadece onaylı, tam model eşleşmeli ve doğrulanmış görseller yayınlanır.',
                n8n_ready: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL),
                sync_endpoint: '/api/model-intelligence/gallery-sync'
            };
            const sourceLinks = buildModelIntelSearchLinks({
                brandName: effectiveBrandName,
                modelName: effectiveModelName,
                brandProfile: brandProfile || {}
            });
            if (sourceUrl && !sourceLinks.some(item => item.url === sourceUrl)) {
                sourceLinks.unshift({
                    type: 'live-source',
                    label: 'Canlı okunan teknik kaynak',
                    url: sourceUrl,
                    note: externalSource?.provider || 'Harici teknik kaynak'
                });
            }

            const dataCoverage = [
                { key: 'technical', label: 'Teknik çekirdek', status: mappedVariants.length ? 'ready' : 'missing', source: 'teknik_veri' },
                { key: 'sales', label: 'Model satış izi', status: Number(salesSummaryRes.rows[0]?.total_sales || 0) > 0 ? 'ready' : 'missing', source: 'tuik_veri' },
                { key: 'images', label: 'Fotoğraf/görsel', status: imageGallery.length ? 'ready' : 'source_needed', source: galleryStatus.source_label },
                { key: 'factory', label: 'Fabrika ve tedarik izi', status: primaryVariant.design?.origin ? 'partial' : 'source_needed', source: 'resmi marka kaynakları' },
                { key: 'used_market', label: 'Model yılı fiyat koridoru', status: 'source_linked', source: 'sahibinden.com araması' }
            ];

            const externalSpec = (label) => (externalSource?.specs || []).find(item => item.label === label)?.value || null;
            const sourceCards = [
                {
                    label: 'Model görseli',
                    value: imageGallery.length ? `${imageGallery.length} görsel hazır` : 'Görsel bekliyor',
                    note: imageGallery.length
                        ? `${imageGallery[0].label} rapor vitrinine bağlandı; galeri ${galleryStatus.source_label} kaynağından besleniyor.`
                        : 'n8n taraması resmi ürün sayfası, katalog ve bayi kaynaklarından galeri adaylarını toplayabilir.',
                    status: imageGallery.length ? 'ready' : 'source_needed'
                },
                {
                    label: 'Teknik özellik kaynağı',
                    value: externalSource?.specs?.length
                        ? `${externalSource.specs.length} harici alan`
                        : `${mappedVariants.length} teknik varyant`,
                    note: externalSource?.specs?.length
                        ? `${externalSource.provider || 'Harici kaynak'} üzerinden motor, transmisyon, lastik, ağırlık ve emisyon alanları alındı.`
                        : 'Çekirdek teknik bilgiler teknik_veri tablosundan okunuyor.',
                    status: externalSource?.specs?.length || mappedVariants.length ? 'ready' : 'missing'
                },
                {
                    label: 'Motor ve aktarma',
                    value: [
                        primaryVariant.engine?.brand || externalSpec('Motor imalatçısı'),
                        primaryVariant.engine?.power_hp ? `${primaryVariant.engine.power_hp} HP` : null,
                        externalSpec('Maksimum Tork'),
                        primaryVariant.transmission?.gear_config || externalSpec('Transmisyon') || externalSpec('Vites Seçeneği')
                    ].filter(Boolean).join(' · ') || 'Kaynak bekliyor',
                    note: 'Motor markası, güç ve vites mimarisi tek kartta özetlenir.',
                    status: primaryVariant.engine?.brand || primaryVariant.engine?.power_hp || primaryVariant.transmission?.gear_config || externalSpec('Motor imalatçısı') ? 'ready' : 'source_needed'
                },
                {
                    label: 'Fiyat bandı',
                    value: priceStats.min_usd || priceStats.max_usd
                        ? (priceStats.min_usd !== priceStats.max_usd
                            ? `${formatModelIntelUsd(priceStats.min_usd)} - ${formatModelIntelUsd(priceStats.max_usd)}`
                            : formatModelIntelUsd(priceStats.avg_usd || priceStats.max_usd || priceStats.min_usd))
                        : 'Fiyat bekliyor',
                    note: 'Fiyat kaynağı teknik_veri.fiyat_usd alanıdır.',
                    status: priceStats.min_usd || priceStats.max_usd ? 'ready' : 'missing'
                },
                {
                    label: 'Türkiye satış izi',
                    value: `${Number(salesSummaryRes.rows[0]?.total_sales || 0).toLocaleString('tr-TR')} adet`,
                    note: `${salesSummaryRes.rows[0]?.first_year || '-'}-${salesSummaryRes.rows[0]?.latest_year || '-'} aralığında tuik_veri N ve N-1 penceresi.`,
                    status: Number(salesSummaryRes.rows[0]?.total_sales || 0) > 0 ? 'ready' : 'missing'
                },
                {
                    label: 'Resmi kanal',
                    value: brandProfile?.website_url || brandProfile?.website ? 'Marka sitesi var' : 'Resmi link bekliyor',
                    note: brandProfile?.price_list_url
                        ? 'Marka portalında fiyat/katalog bağlantısı da tanımlı.'
                        : 'Resmi ürün sayfası ve katalog bağlantısı marka portal profilinden beslenir.',
                    status: brandProfile?.website_url || brandProfile?.website ? 'ready' : 'source_needed'
                }
            ];

            const subsystemSignals = [
                {
                    label: 'Motor',
                    value: [
                        primaryVariant.engine?.brand || externalSpec('Motor Markası'),
                        primaryVariant.engine?.power_hp ? `${primaryVariant.engine.power_hp} HP` : externalSpec('Nominal Motor Gücü'),
                        externalSpec('Silindir Hacmi'),
                        externalSpec('Maksimum Tork'),
                        primaryVariant.engine?.emission || externalSpec('Emisyon Seviyesi')
                    ].filter(Boolean).join(' · ') || null,
                    note: 'Motor markası, güç, hacim, tork, devir ve emisyon bilgisi teknik veri/resmi kaynakla doğrulanır'
                },
                {
                    label: 'Şanzıman',
                    value: [
                        primaryVariant.transmission?.gear_config || tractorModel.gear_config || externalSpec('Vites Seçeneği'),
                        externalSpec('Dişli Kutusu Tipi'),
                        externalSpec('İleri - Geri Mekik Kolu')
                    ].filter(Boolean).join(' · ') || null,
                    note: 'Vites mimarisi, dişli kutusu tipi ve ileri-geri mekik bilgisi resmi kaynakla desteklenir'
                },
                {
                    label: 'Kabin ve tasarım',
                    value: [
                        primaryVariant.design?.protection || tractorModel.cabin_type,
                        primaryVariant.design?.drive_type || tractorModel.drive_type,
                        externalSpec('Kabin donanımı')
                    ].filter(Boolean).join(' · ') || null,
                    note: 'Kabin, çekiş ve konfor donanımları resmi ürün sayfasından tamamlanır'
                },
                {
                    label: 'Lastik ve aks',
                    value: [
                        [tractorModel.front_tire || externalSpec('1. Opsiyon 4WD-Ön'), tractorModel.rear_tire || externalSpec('1. Opsiyon 4WD-Arka')].filter(Boolean).join(' / '),
                        [externalSpec('2. Opsiyon 4WD-Ön'), externalSpec('2. Opsiyon 4WD-Arka')].filter(Boolean).join(' / ')
                    ].filter(Boolean).join(' · ') || null,
                    note: 'Lastik opsiyonları ve aks donanımı resmi katalog/ürün kaynağı üzerinden tamamlanır'
                },
                {
                    label: 'Hidrolik/PTO',
                    value: [
                        primaryVariant.hydraulics?.lift_capacity_kg ? `${primaryVariant.hydraulics.lift_capacity_kg} kg` : externalSpec('Kaldırma Kapasitesi'),
                        externalSpec('Hidrolik Güç Çıkışı'),
                        tractorModel.pto_rpm || externalSpec('Kuyruk Mili Devri'),
                        externalSpec('PTO Kumanda Şekli')
                    ].filter(Boolean).join(' · ') || null,
                    note: 'Kaldırma, hidrolik çıkış, PTO devri ve PTO kumandası tek sekmede izlenir'
                }
            ];

            res.json({
                profile: {
                    brand_id: brandProfile?.id || tractorModel.brand_id || null,
                    brand_name: effectiveBrandName || null,
                    brand_slug: brandProfile?.slug || null,
                    model_name: effectiveModelName || null,
                    tuik_model_name: technicalRows[0]?.tuik_model_adi || tuikModelQuery || salesModelNames[0] || null,
                    display_name: compactModelIntelText(`${effectiveBrandName} ${effectiveModelName}`),
                    brand_color: brandProfile?.primary_color || tractorModel.primary_color || '#3b82f6',
                    brand_logo_url: brandProfile?.logo_url || tractorModel.logo_url || null,
                    country_of_origin: brandProfile?.country_of_origin || null,
                    parent_company: brandProfile?.parent_company || null,
                    headquarters: brandProfile?.headquarters || null
                },
                metrics: {
                    variant_count: mappedVariants.length,
                    tractor_model_count: tractorModelRes.rows.length,
                    price: priceStats,
                    horsepower: hpStats
                },
                spec_groups: specGroups,
                variants: mappedVariants,
                catalog_models: tractorModelRes.rows,
                sales: {
                    summary: salesSummaryRes.rows[0] || {},
                    yearly: salesYearRes.rows,
                    top_provinces: salesProvinceRes.rows,
                    colors: salesColorRes.rows,
                    model_years: salesModelYearRes.rows,
                    displacements: salesDisplacementRes.rows
                },
                subsystem_signals: subsystemSignals,
                external_source: externalSource,
                image_gallery: imageGallery,
                gallery_status: galleryStatus,
                photo_search_plan: photoSearchPlan,
                source_cards: sourceCards,
                source_links: sourceLinks,
                data_coverage: dataCoverage,
                automation: {
                    n8n_model_intel_webhook_configured: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL),
                    suggested_payload: {
                        ...photoSearchPlan,
                        brand: effectiveBrandName,
                        model: effectiveModelName,
                        tuik_model_adi: technicalRows[0]?.tuik_model_adi || null,
                        source_url: sourceUrl || null,
                        tasks: ['official_product_page', 'photo_gallery', 'factory_supply_chain', 'transmission_detail', 'used_market_price_by_model_year']
                    }
                },
                meta: {
                    generated_at: new Date().toISOString(),
                    primary_sources: ['teknik_veri', 'tuik_veri', 'tractor_models'],
                    model_window_note: 'Model bazlı satış izi N ve N-1 kuralına göre tuik_veri üzerinden hesaplandı.',
                    source_url: sourceUrl || null
                }
            });
        } catch (err) {
            console.error('Model intelligence error:', err);
            res.status(500).json({ error: 'Model röntgen raporu hazırlanamadı' });
        }
    });

    app.post('/api/model-intelligence/gallery-sync', authMiddleware, async (req, res) => {
        try {
            const body = req.body || {};
            const brandId = body.brand_id ? parseInt(body.brand_id, 10) : null;
            let brandName = normalizeModelSearch(body.brand || body.brand_name || '');
            const modelName = normalizeModelSearch(body.model || body.model_name || body.q || '');
            const tuikModelName = normalizeModelSearch(body.tuik_model_adi || body.tuik_model_name || modelName);
            const sourceUrl = normalizeModelImageUrl(body.source_url || '');

            let brandProfile = null;
            if (brandId || brandName) {
                const profileWhere = brandId
                    ? 'b.id = $1'
                    : '(UPPER(b.name) = UPPER($1) OR b.slug = LOWER($1))';
                const profileRes = await pool.query(`
                    SELECT
                        b.id, b.name, b.slug, b.website,
                        p.website_url, p.dealer_locator_url, p.price_list_url, p.portal_url
                    FROM brands b
                    LEFT JOIN brand_portal_profiles p ON p.brand_id = b.id
                    WHERE ${profileWhere}
                    LIMIT 1
                `, [brandId || brandName]);
                brandProfile = profileRes.rows[0] || null;
                brandName = brandName || brandProfile?.name || '';
            }

            if (!brandName || !modelName) {
                return res.status(400).json({ error: 'Galeri taraması için marka ve model gerekli' });
            }

            const callbackBase = getModelIntelRuntimeBase(req);
            const photoSearchPlan = buildModelPhotoSearchPlan({
                brandName,
                modelName,
                tuikModelName,
                brandProfile: brandProfile || {},
                sourceUrl,
                callbackUrl: callbackBase ? `${callbackBase}/api/model-intelligence/gallery-callback` : ''
            });
            const existingImages = await getModelImageGalleryFromDb({ brandName, modelName, tuikModelName });

            if (!N8N_MODEL_INTEL_WEBHOOK_URL) {
                return res.json({
                    status: 'not_configured',
                    message: 'N8N_MODEL_INTEL_WEBHOOK_URL tanımlanınca galeri taraması bu uçtan tetiklenir.',
                    images: existingImages,
                    new_images: [],
                    photo_search_plan: photoSearchPlan
                });
            }

            const n8nResult = await fetchN8nModelImageGallery({
                ...photoSearchPlan,
                requested_by: {
                    id: req.user?.id || null,
                    email: req.user?.email || null,
                    role: req.user?.role || null
                },
                requested_at: new Date().toISOString()
            });
            const savedImages = n8nResult.images.length
                ? await upsertModelImageGallery({ brandName, modelName, tuikModelName, images: n8nResult.images })
                : [];
            const publishableSavedImages = filterPublishableModelGallery(savedImages);
            const mergedImages = filterPublishableModelGallery([...publishableSavedImages, ...existingImages]);

            res.json({
                status: n8nResult.status,
                error: n8nResult.error || null,
                images: mergedImages,
                new_images: publishableSavedImages,
                candidate_count: savedImages.length,
                blocked_candidate_count: Math.max(0, savedImages.length - publishableSavedImages.length),
                photo_search_plan: photoSearchPlan,
                n8n: {
                    configured: true,
                    image_count: n8nResult.images.length,
                    raw_status: n8nResult.raw?.status || null
                }
            });
        } catch (err) {
            console.error('Model gallery sync error:', err);
            res.status(500).json({ error: 'Model fotoğraf galerisi taraması başlatılamadı' });
        }
    });

    app.post('/api/model-intelligence/gallery-callback', async (req, res) => {
        try {
            const webhookKey = req.get('x-webhook-key') || req.get('x-media-watch-key') || req.query.key || '';
            if (!MEDIA_WATCH_WEBHOOK_KEY) {
                return res.status(503).json({ error: 'Webhook anahtarı yapılandırılmadı' });
            }
            if (webhookKey !== MEDIA_WATCH_WEBHOOK_KEY) {
                return res.status(401).json({ error: 'Yetkisiz webhook' });
            }

            const body = req.body || {};
            const brandName = normalizeModelSearch(body.brand || body.brand_name || '');
            const modelName = normalizeModelSearch(body.model || body.model_name || '');
            const tuikModelName = normalizeModelSearch(body.tuik_model_adi || body.tuik_model_name || modelName);
            const images = body.images || body.image_gallery || body.gallery || [];

            if (!brandName || !modelName || !Array.isArray(images) || !images.length) {
                return res.status(400).json({ error: 'brand, model ve images alanları gerekli' });
            }

            const savedImages = await upsertModelImageGallery({ brandName, modelName, tuikModelName, images });
            res.json({
                ok: true,
                saved_count: savedImages.length,
                images: savedImages
            });
        } catch (err) {
            console.error('Model gallery callback error:', err);
            res.status(500).json({ error: 'Model fotoğraf galerisi kaydedilemedi' });
        }
    });

    // ============================================
    // MODEL IMAGE ADMIN — Marka Merkezi Görsel Yönetimi
    // (anayasa: skills/model-gorsel-dogruluk-anayasasi/SKILL.md)
    // ============================================

    // Coverage: marka bazında fotoğrafı olan / olmayan model sayısı
    app.get('/api/admin/model-images/coverage', authMiddleware, adminOnly, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    b.id AS brand_id,
                    b.name AS brand_name,
                    b.slug AS brand_slug,
                    COUNT(DISTINCT tm.model_name) AS total_models,
                    COUNT(DISTINCT CASE
                        WHEN mig.id IS NOT NULL THEN tm.model_name
                    END) AS covered_models,
                    COUNT(DISTINCT CASE
                        WHEN cand.id IS NOT NULL AND cand.review_status = 'candidate' THEN tm.model_name
                    END) AS pending_models
                FROM brands b
                LEFT JOIN tractor_models tm ON tm.brand_id = b.id
                LEFT JOIN model_image_gallery mig
                    ON UPPER(mig.brand_name) = UPPER(b.name)
                    AND UPPER(mig.model_name) = UPPER(tm.model_name)
                    AND mig.is_active = true
                    AND mig.review_status = 'approved'
                LEFT JOIN model_image_gallery cand
                    ON UPPER(cand.brand_name) = UPPER(b.name)
                    AND UPPER(cand.model_name) = UPPER(tm.model_name)
                    AND cand.is_active = true
                GROUP BY b.id, b.name, b.slug
                ORDER BY b.name
            `);

            const rows = result.rows.map(r => ({
                brand_id: Number(r.brand_id),
                brand_name: r.brand_name,
                brand_slug: r.brand_slug,
                total_models: Number(r.total_models || 0),
                covered_models: Number(r.covered_models || 0),
                pending_models: Number(r.pending_models || 0),
                missing_models: Math.max(0, Number(r.total_models || 0) - Number(r.covered_models || 0)),
                coverage_pct: r.total_models ? Number((Number(r.covered_models) / Number(r.total_models) * 100).toFixed(1)) : 0
            }));

            const overall = rows.reduce((acc, row) => {
                acc.total += row.total_models;
                acc.covered += row.covered_models;
                acc.pending += row.pending_models;
                return acc;
            }, { total: 0, covered: 0, pending: 0 });

            res.json({
                overall: {
                    ...overall,
                    missing: Math.max(0, overall.total - overall.covered),
                    coverage_pct: overall.total ? Number((overall.covered / overall.total * 100).toFixed(1)) : 0
                },
                by_brand: rows,
                bridge: {
                    configured: Boolean(MODEL_IMAGE_BRIDGE_URL),
                    url: MODEL_IMAGE_BRIDGE_URL,
                    n8n_webhook: Boolean(N8N_MODEL_INTEL_WEBHOOK_URL)
                }
            });
        } catch (err) {
            console.error('Model image coverage error:', err);
            res.status(500).json({ error: 'Coverage hesaplanamadı' });
        }
    });

    // Onay bekleyen aday görseller
    app.get('/api/admin/model-images/pending', authMiddleware, adminOnly, async (req, res) => {
        try {
            const limit = Math.min(200, parseInt(req.query.limit, 10) || 60);
            const brandFilter = compactModelIntelText(req.query.brand || '');
            const params = [];
            let where = "WHERE is_active = true AND review_status = 'candidate'";
            if (brandFilter) {
                params.push(brandFilter);
                where += ` AND UPPER(brand_name) = UPPER($${params.length})`;
            }
            params.push(limit);

            const result = await pool.query(`
                SELECT id, brand_name, model_name, tuik_model_adi, image_url, source_url, source_name,
                       angle_label, caption, width, height, confidence_score, model_match_level,
                       verification_status, review_status, raw_payload, created_at, updated_at
                FROM model_image_gallery
                ${where}
                ORDER BY confidence_score DESC NULLS LAST, created_at DESC
                LIMIT $${params.length}
            `, params);

            res.json({
                count: result.rows.length,
                items: result.rows.map(row => ({
                    ...row,
                    confidence_score: row.confidence_score === null ? null : Number(row.confidence_score),
                    raw_payload: typeof row.raw_payload === 'object' ? row.raw_payload : null
                }))
            });
        } catch (err) {
            console.error('Model image pending error:', err);
            res.status(500).json({ error: 'Aday görseller okunamadı' });
        }
    });

    // Eksik (fotoğrafsız) modeller
    app.get('/api/admin/model-images/missing', authMiddleware, adminOnly, async (req, res) => {
        try {
            const limit = Math.min(500, parseInt(req.query.limit, 10) || 80);
            const brandFilter = compactModelIntelText(req.query.brand || '');
            const params = [];
            let where = '';
            if (brandFilter) {
                params.push(brandFilter);
                where = `AND UPPER(b.name) = UPPER($${params.length})`;
            }
            params.push(limit);

            const result = await pool.query(`
                SELECT b.name AS brand_name, b.slug AS brand_slug, tm.model_name,
                       tv.tuik_model_adi,
                       COUNT(cand.id) AS candidate_count
                FROM tractor_models tm
                JOIN brands b ON b.id = tm.brand_id
                LEFT JOIN teknik_veri tv ON UPPER(tv.marka) = UPPER(b.name)
                    AND UPPER(tv.tuik_model_adi) = UPPER(tm.model_name)
                LEFT JOIN model_image_gallery cand
                    ON UPPER(cand.brand_name) = UPPER(b.name)
                    AND UPPER(cand.model_name) = UPPER(tm.model_name)
                    AND cand.is_active = true
                    AND cand.review_status = 'candidate'
                WHERE NOT EXISTS (
                    SELECT 1 FROM model_image_gallery mig
                    WHERE UPPER(mig.brand_name) = UPPER(b.name)
                      AND UPPER(mig.model_name) = UPPER(tm.model_name)
                      AND mig.is_active = true
                      AND mig.review_status = 'approved'
                )
                ${where}
                GROUP BY b.name, b.slug, tm.model_name, tv.tuik_model_adi
                ORDER BY b.name, tm.model_name
                LIMIT $${params.length}
            `, params);

            res.json({
                count: result.rows.length,
                items: result.rows.map(r => ({
                    brand_name: r.brand_name,
                    brand_slug: r.brand_slug,
                    model_name: r.model_name,
                    tuik_model_adi: r.tuik_model_adi,
                    candidate_count: Number(r.candidate_count || 0)
                }))
            });
        } catch (err) {
            console.error('Model image missing error:', err);
            res.status(500).json({ error: 'Eksik modeller okunamadı' });
        }
    });

    // Manuel onay — anayasa kuralına uygun değerleri yazar
    app.post('/api/admin/model-images/:id/approve', authMiddleware, adminOnly, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Geçersiz id' });
            const setPrimary = req.body?.is_primary === true;

            const result = await pool.query(`
                UPDATE model_image_gallery
                SET review_status = 'approved',
                    verification_status = 'manual_approved',
                    model_match_level = CASE
                        WHEN model_match_level IN ('exact_product_page','exact_model','manual_verified') THEN model_match_level
                        ELSE 'manual_verified'
                    END,
                    confidence_score = GREATEST(COALESCE(confidence_score, 0), 0.90),
                    verified_at = NOW(),
                    is_primary = CASE WHEN $2 THEN true ELSE is_primary END,
                    is_active = true,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
            `, [id, setPrimary]);

            if (!result.rows.length) return res.status(404).json({ error: 'Görsel bulunamadı' });

            if (setPrimary) {
                await pool.query(`
                    UPDATE model_image_gallery
                    SET is_primary = false
                    WHERE id <> $1
                      AND UPPER(brand_name) = UPPER($2)
                      AND UPPER(model_name) = UPPER($3)
                `, [id, result.rows[0].brand_name, result.rows[0].model_name]);
            }

            res.json({ ok: true, image: result.rows[0] });
        } catch (err) {
            console.error('Model image approve error:', err);
            res.status(500).json({ error: 'Onay başarısız' });
        }
    });

    // Manuel red
    app.post('/api/admin/model-images/:id/reject', authMiddleware, adminOnly, async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Geçersiz id' });
            const reason = compactModelIntelText(req.body?.reason || '').slice(0, 240);

            const result = await pool.query(`
                UPDATE model_image_gallery
                SET review_status = 'rejected',
                    verification_status = 'rejected',
                    is_active = false,
                    is_primary = false,
                    raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id, brand_name, model_name, image_url, review_status
            `, [id, JSON.stringify({ rejection_reason: reason, rejected_at: new Date().toISOString() })]);

            if (!result.rows.length) return res.status(404).json({ error: 'Görsel bulunamadı' });
            res.json({ ok: true, image: result.rows[0] });
        } catch (err) {
            console.error('Model image reject error:', err);
            res.status(500).json({ error: 'Red başarısız' });
        }
    });

    // Bridge tetikleme — tek model
    app.post('/api/admin/model-images/sync', authMiddleware, adminOnly, async (req, res) => {
        try {
            const brand = compactModelIntelText(req.body?.brand || '');
            const model = compactModelIntelText(req.body?.model || '');
            const tuik = compactModelIntelText(req.body?.tuik_model_adi || model);
            if (!brand || !model) return res.status(400).json({ error: 'brand ve model gerekli' });
            if (!MEDIA_WATCH_WEBHOOK_KEY) return res.status(503).json({ error: 'MEDIA_WATCH_WEBHOOK_KEY yapılandırılmadı' });

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            try {
                const response = await fetch(`${MODEL_IMAGE_BRIDGE_URL}/sync-model`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY },
                    body: JSON.stringify({ brand, model, tuik_model_adi: tuik, run_id: `admin_${Date.now()}_${req.user.id}` })
                });
                const text = await response.text();
                const data = text ? JSON.parse(text) : {};
                if (!response.ok) return res.status(response.status).json({ error: 'bridge_error', detail: data });
                res.json({ ok: true, bridge: data });
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            console.error('Model image sync error:', err);
            res.status(502).json({ error: 'Bridge çağrısı başarısız', detail: errMsg(err) });
        }
    });

    // Bridge tetikleme — toplu eksik tarama
    app.post('/api/admin/model-images/sync-missing', authMiddleware, adminOnly, async (req, res) => {
        try {
            if (!MEDIA_WATCH_WEBHOOK_KEY) return res.status(503).json({ error: 'MEDIA_WATCH_WEBHOOK_KEY yapılandırılmadı' });
            const limit = Math.min(50, parseInt(req.body?.limit, 10) || 12);
            const brand = compactModelIntelText(req.body?.brand || '');

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 300000);
            try {
                const response = await fetch(`${MODEL_IMAGE_BRIDGE_URL}/sync-missing`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', 'x-webhook-key': MEDIA_WATCH_WEBHOOK_KEY },
                    body: JSON.stringify({ limit, brand: brand || undefined, run_id: `admin_bulk_${Date.now()}_${req.user.id}` })
                });
                const text = await response.text();
                const data = text ? JSON.parse(text) : {};
                if (!response.ok) return res.status(response.status).json({ error: 'bridge_error', detail: data });
                res.json({ ok: true, bridge: data });
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            console.error('Model image bulk sync error:', err);
            res.status(502).json({ error: 'Bridge toplu çağrısı başarısız', detail: errMsg(err) });
        }
    });

    // n8n / bridge log alıcısı (run trace kaydı)
    app.post('/api/admin/model-images/log', async (req, res) => {
        try {
            const webhookKey = req.get('x-webhook-key') || req.get('x-media-watch-key') || req.query.key || '';
            if (!MEDIA_WATCH_WEBHOOK_KEY || webhookKey !== MEDIA_WATCH_WEBHOOK_KEY) {
                return res.status(401).json({ error: 'Yetkisiz' });
            }
            const summary = req.body?.summary || null;
            const trace = req.body?.trace || null;
            if (summary) {
                console.log('[model-image-run]', JSON.stringify(summary));
            }
            // Trace'i hafif tutmak için sadece ilk 80 satırını sakla
            const compactTrace = trace ? {
                run_id: trace.run_id || summary?.run_id || null,
                started_at: trace.started_at || null,
                finished_at: trace.finished_at || summary?.finished_at || null,
                results: Array.isArray(trace.results) ? trace.results.slice(0, 80) : null
            } : null;
            res.json({ ok: true, recorded: Boolean(summary || compactTrace) });
        } catch (err) {
            console.error('Model image log error:', err);
            res.status(500).json({ error: 'Log alınamadı' });
        }
    });

    Object.assign(geoHelpers, require('./geo')(app, { pool, authMiddleware, normalizeSearchText, roundMetric, calculateYoY }));

};
