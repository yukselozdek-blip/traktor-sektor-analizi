'use strict';
// AI analiz route'u (/api/ai/analyze), server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

const MAX_CONTEXT_CHARS = 20000;
const MAX_QUESTION_CHARS = 2000;
const LLM_TIMEOUT_MS = 30000;

module.exports = function registerAiAnalyze(app, ctx) {
    const { authMiddleware, requireFeature, requireAiQuota, MINIMAX_API_KEY, MINIMAX_MODEL, errMsg } = ctx;

    app.post('/api/ai/analyze', authMiddleware, requireFeature('ai_insights', 'ai_insights_limited', 'model_region_analysis'), requireAiQuota(), async (req, res) => {
        let llmCalled = false;
        try {
            if (!MINIMAX_API_KEY) return res.status(500).json({ error: 'MINIMAX_API_KEY tanımlı değil' });

            const { type, context } = req.body || {};
            if (!type) return res.status(400).json({ error: 'Analiz tipi gerekli' });
            if (typeof type !== 'string' || type.length > 64) return res.status(400).json({ error: 'Geçersiz analiz tipi' });
            if (context !== undefined && context !== null && (typeof context !== 'object' || Array.isArray(context))) {
                return res.status(400).json({ error: 'context nesne olmalı' });
            }
            let ctxSize = 0;
            try { ctxSize = JSON.stringify(context ?? {}).length; } catch (_) { ctxSize = Infinity; }
            if (ctxSize > MAX_CONTEXT_CHARS) return res.status(400).json({ error: `context çok büyük (en fazla ${MAX_CONTEXT_CHARS} karakter)` });
            // Serbest metin alanları (soru/not vb.) varsa sınırla
            for (const k of ['question', 'prompt', 'note', 'query']) {
                const v = req.body[k] ?? (context && context[k]);
                if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > MAX_QUESTION_CHARS)) {
                    return res.status(400).json({ error: `${k} metin olmalı ve en fazla ${MAX_QUESTION_CHARS} karakter olabilir` });
                }
            }
            // Dizi bekleyen alanlar dizi değilse .slice/.map 500 üretmesin
            const ARRAY_KEYS = ['regionLadder', 'whitespaceProvinces', 'provinceArena', 'siblingStack', 'rivalStack', 'provinces', 'models',
                'topBrands', 'topModels', 'soilMachineRows', 'cropOperationRows', 'climateActions', 'pressureMonths'];
            for (const k of ARRAY_KEYS) {
                if (context && context[k] !== undefined && context[k] !== null && !Array.isArray(context[k])) {
                    return res.status(400).json({ error: `context.${k} dizi olmalı` });
                }
            }
            if (type === 'brand-compare') {
                const c = context || {};
                if (!c.data1 || !c.data2 || typeof c.data1 !== 'object' || typeof c.data2 !== 'object') {
                    return res.status(400).json({ error: 'context.data1 ve context.data2 nesne olmalı' });
                }
            } else if (['brand-region', 'regional-index', 'tarmakbir-command'].includes(type) && !context) {
                return res.status(400).json({ error: 'context gerekli' });
            }

            // Build prompt based on analysis type
            let systemPrompt = `Sen Türkiye traktör sektörü konusunda uzman bir analistsin. Verilen verileri analiz edip Türkçe olarak profesyonel, derinlikli, stratejik öneriler içeren raporlar hazırlıyorsun. Yanıtlarında markdown formatı kullan. Kısa ve öz ol ama derinlikli analiz yap. Sayısal verilerle destekle.`;

            let userPrompt = '';

            if (type === 'model-region') {
                const {
                    brandName,
                    modelName,
                    overview = {},
                    regionLadder = [],
                    whitespaceProvinces = [],
                    provinceArena = [],
                    siblingStack = [],
                    rivalStack = []
                } = context || {};

                const regionStr = regionLadder.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.region}: ${item.total_sales} adet, pay ${item.share_pct}%, uyum ${item.avg_fit_score}, YoY ${item.yoy_growth_pct ?? 'yeni'}, ana urun ${item.dominant_crop || '-'}, rol ${item.mission_label || '-'}`
                ).join('\n');

                const whitespaceStr = whitespaceProvinces.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.province_name} (${item.region}): firsat ${item.opportunity_score}, uyum ${item.fit_score}, il pazari ${item.province_market_units}, model payi ${item.province_share_pct}%, urun ${item.dominant_crop || '-'}, destek ${item.support_programs || 'yok'}`
                ).join('\n');

                const arenaStr = provinceArena.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.province_name} (${item.region}): toplam ${item.total_sales} adet, il payi ${item.province_share_pct}%, uyum ${item.fit_score}, YoY ${item.yoy_growth_pct ?? 'yeni'}, urun ${item.dominant_crop || '-'}`
                ).join('\n');

                const siblingStr = siblingStack.slice(0, 6).map((item, index) =>
                    `${index + 1}. ${item.model_name}: ${item.hp_range || '-'} HP, toplam ${item.total_sales} adet, rol ${item.role_note || '-'}`
                ).join('\n');

                const rivalStr = rivalStack.slice(0, 6).map((item, index) =>
                    `${index + 1}. ${item.brand_name} / ${item.model_name}: ${item.total_sales} adet, baskin bolge ${item.dominant_region || '-'}`
                ).join('\n');

                userPrompt = `**${brandName || '-'} / ${modelName || '-'}** icin model-bolge saha plani hazirla.

    MODEL OZETI:
    - Toplam model satisi: ${overview.total_sales || 0} adet
    - Son pencere satisi: ${overview.current_year_sales || 0} adet
    - Yillik degisim: ${overview.yoy_growth_pct ?? 'yeni'}%
    - Aktif il: ${overview.active_provinces || 0}
    - Aktif bolge: ${overview.active_regions || 0}
    - Ulusal model payi: ${overview.national_model_share_pct || 0}%
    - Ortalama il payi: ${overview.avg_province_share_pct || 0}%
    - Dogal habitat: ${overview.dominant_region || '-'}
    - Agro eksen: ${overview.dominant_crop || '-'}
    - Destek etkisi: ${overview.support_driven_share_pct || 0}%
    - Tahmini toplam ciro: ${overview.estimated_revenue_usd ? Math.round(overview.estimated_revenue_usd / 1000) + 'K $' : 'fiyat verisi sinirli'}

    BOLGE KOMUT CETVELI:
    ${regionStr || '-'}

    BEYAZ ALAN ILLERI:
    ${whitespaceStr || '-'}

    MEVCUT HABITAT ILLERI:
    ${arenaStr || '-'}

    KARDES MODEL ROUTING:
    ${siblingStr || '-'}

    RAKIP MODEL BASKISI:
    ${rivalStr || '-'}

    Su basliklarda yonetim kuruluna sunulacak kadar net ve profesyonel bir analiz yap:
    1. **Modelin Dogal Habitat Tezi**: Bu modelin hangi bolge ve urun deseninde dogal olarak kazandigini acikla.
    2. **Savunulacak Kale / Buyutulecek Cephe**: Mevcut habitatta korunacak illerle buyume yatirimi yapilacak illeri ayir.
    3. **Beyaz Alan Saldiri Plani**: Ilk 90 gunde gidilecek ilk 3 il ve nedenleri.
    4. **Kardes Model Routing**: Portfoy icinde bu model hangi rolleri ustlenmeli, hangi kardes modelle saha cakisimi onlenmeli?
    5. **Rakip Kirma Taktikleri**: Ayni koridordaki rakip modellere karsi fiyatlama, bayi, demo ve ekipman paketi bazli somut taktikler ver.
    6. **Riskler ve Ongoruler**: Destek, iklim, urun deseni ve pazar yogunluguna gore gelecek donem risk/firsat analizi yap.
    7. **CEO Ozet Notu**: En sonda 5 maddelik cok net aksiyon listesi ver.`;

            } else if (type === 'brand-region') {
                // Brand-specific regional analysis
                const { brandName, provinces, models, totalSales, totalRevenue } = context;
                const topProvStr = (provinces || []).slice(0, 10).map((p, i) =>
                    `${i + 1}. ${p.name} (${p.region}): ${p.total} adet, Pazar payı: ${p.marketShareCurr}%, YoY: ${p.yoyGrowth}%, Bahçe: ${(p.bahce / (p.total || 1) * 100).toFixed(0)}%, Toprak: ${p.soil_type || '-'}, İklim: ${p.climate_zone || '-'}, Ürünler: ${Array.isArray(p.primary_crops) ? p.primary_crops.join(', ') : (p.primary_crops || '-')}, Tahmini Ciro: ${Math.round(p.estimatedRevenue / 1000000)}M $`
                ).join('\n');
                const modelStr = (models || []).map(m => `${m.name} (${m.hp}HP, ${m.category}, ${m.price ? Math.round(m.price / 1000) + 'B TL' : '-'})`).join(', ');

                userPrompt = `**${brandName}** markası için bölgesel strateji analizi yap.

    TOPLAM VERİ:
    - Toplam satış: ${totalSales} adet
    - Tahmini toplam ciro: ${Math.round(totalRevenue / 1000000)}M $
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

            } else if (type === 'regional-province') {
                const {
                    provinceName,
                    region,
                    provinceMetrics = {},
                    overview = {},
                    focusBrand = {},
                    topBrands = [],
                    topModels = [],
                    soilMachineRows = [],
                    cropOperationRows = [],
                    climateActions = [],
                    narrative = []
                } = context || {};

                const brandStr = topBrands.slice(0, 6).map((item, index) =>
                    `${index + 1}. ${item.brand_name || item.name || '-'}: ${item.total_sales || item.total || 0} adet, pay ${item.share_pct || item.share || 0}%, HP ${item.avg_hp || item.avgHp || '-'}, tahmini gelir ${item.revenue_band || '-'}`
                ).join('\n');

                const modelStr = topModels.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.model_name || '-'}: ${item.sales || item.total_sales || 0} adet, ${item.hp || item.hp_band || '-'}, ${item.drive || item.drive_type || '-'}, ${item.reason || item.fit_note || '-'}`
                ).join('\n');

                const soilStr = soilMachineRows.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.soil || '-'} / ${item.texture || '-'}: urun ${item.crop || '-'}, cekis ${item.drive || '-'}, HP ${item.hpBand || '-'}, ekipman ${item.implement || '-'}`
                ).join('\n');

                const cropStr = cropOperationRows.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.crop || '-'}: alan ${item.area || '-'}, uretim ${item.production || '-'}, HP ${item.hpBand || '-'}, arketip ${item.archetype || '-'}, ekipman ${item.implement || '-'}`
                ).join('\n');

                const climateStr = climateActions.slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.month || '-'}: sicaklik ${item.temp ?? '-'}, yagis ${item.rain ?? '-'}, kuraklik ${item.drought ?? '-'}, aksiyon ${item.action || '-'}`
                ).join('\n');

                const narrativeStr = Array.isArray(narrative) && narrative.length
                    ? narrative.map((item, index) => `${index + 1}. ${item}`).join('\n')
                    : '-';

                userPrompt = `**${provinceName || '-'} / ${region || '-'}** icin bolgesel mekanizasyon strateji raporu hazirla.

    IL KOMUTA OZETI:
    - Toplam satis: ${provinceMetrics.total || overview.total_sales || 0} adet
    - Mekanizasyon endeksi: ${provinceMetrics.mechIndex || provinceMetrics.mech_index || 0}
    - Ortalama HP: ${provinceMetrics.avgHp || provinceMetrics.avg_hp || overview.avg_hp || 0}
    - 4WD orani: ${provinceMetrics.ratio4wd || provinceMetrics.drive_ratio_4wd || 0}%
    - Kabin orani: ${provinceMetrics.cabinRatio || provinceMetrics.cabin_ratio || 0}%
    - Yillik degisim: ${provinceMetrics.yoyGrowth || provinceMetrics.yoy_growth_pct || 0}%
    - Fokus marka: ${focusBrand?.brand_name || focusBrand?.name || '-'}
    - Fokus marka payi: ${focusBrand?.share_pct || focusBrand?.share || 0}%
    - Dominant urun/desen: ${overview.dominant_crop || overview.primary_crop || '-'}
    - Toprak tipi: ${overview.soil_type || provinceMetrics.soil_type || '-'}
    - Iklim zonu: ${overview.climate_zone || provinceMetrics.climate_zone || '-'}

    AKICI SAHA OKUMASI:
    ${narrativeStr}

    MARKA LIDERLIK CETVELI:
    ${brandStr || '-'}

    TERCIH EDILEN TRAKTOR STACKI:
    ${modelStr || '-'}

    TOPRAK - MAKINA MATRISI:
    ${soilStr || '-'}

    URUN - OPERASYON ORKESTRASI:
    ${cropStr || '-'}

    IKLIM AKSIYON CETVELI:
    ${climateStr || '-'}

    Yonetim kuruluna sunulacak profesyonel bir strateji raporu yaz. Sunum dili net, akici ve premium olsun.
    Su basliklarda cikti ver:
    1. **Ilin Mekanizasyon Kimligi**: Il hangi tarimsal ve mekanik DNA ile tanimlaniyor?
    2. **Toprak-Urun-Makina Tezi**: Toprak yapisi, ekili urunler ve tercih edilen traktor mimarisi arasindaki iliskiyi derinlikli kur.
    3. **Marka ve Portfoy Rekabeti**: Hangi markalar ve modeller kazaniyor, neden kazaniyor?
    4. **Onerilen Traktor ve Ekipman Mimarisi**: Bu il icin satilmasi gereken ideal HP, cekis, kabin, ekipman paketini acikla.
    5. **90 Gunluk Saha Plani**: Bayi, demo, ekipman paketi, kampanya ve stok tarafinda cok somut hamleler ver.
    6. **Riskler ve Firsatlar**: Iklim, urun deseni, mekanizasyon seviyesi ve pazar yogunluguna gore firsat/risk matrisi kur.
    7. **5 Yillik Ongoruler**: Bu ilde gelecek yillarda hangi tip traktorlere ve ekipmanlara kayis olacagini aciklanabilir sekilde tahmin et.
    8. **CEO Aksiyon Notu**: En sonda 5 maddelik cok net yonetici ozet listesi ver.`;

            } else if (type === 'regional-index') {
                const { year, provinces: provs } = context;
                const top10 = (provs || []).slice(0, 15).map((p, i) =>
                    `${i + 1}. ${p.name} (${p.region}): ${p.total} adet, Bahçe: ${p.bahceRatio?.toFixed(0)}%, Ort.HP: ${p.avgHp}, 4WD: ${p.ratio4wd?.toFixed(0)}%, Mek.İndeks: ${p.mechIndex}, YoY: ${p.yoyGrowth}%, Toprak: ${p.soil_type || '-'}`
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

            } else if (type === 'tarmakbir-command') {
                const {
                    year,
                    filteredTotal,
                    fullTotal,
                    carryoverTotal,
                    carryoverShare,
                    filteredYoy,
                    topBrands,
                    focusBrand,
                    pressureMonths
                } = context;

                const topBrandStr = (topBrands || []).slice(0, 8).map((item, index) =>
                    `${index + 1}. ${item.name}: ${item.total} adet, pay ${item.share}%, zirve ay ${item.peakMonth}, Q4 agirligi ${item.q4Share}%`
                ).join('\n');

                const pressureStr = (pressureMonths || []).slice(0, 6).map(item =>
                    `${item.month}: butun madde ${item.fullTotal}, N+N1 ${item.filteredTotal}, fark ${item.gap}, fark orani ${item.gapShare}%`
                ).join('\n');

                const focusBrandStr = focusBrand
                    ? `${focusBrand.name}: sira ${focusBrand.rank}, toplam ${focusBrand.total} adet, pay ${focusBrand.share}%, zirve ay ${focusBrand.peakMonth}, ritim ${focusBrand.rhythm}`
                    : 'Odak marka secili degil; analizi toplam pazar bakisiyla yap.';

                userPrompt = `${year} yili icin TarmakBir komuta merkezi analizi yap.

    ANA KPI:
    - N+N1 filtreli toplam: ${filteredTotal} adet
    - Butun madde toplam: ${fullTotal} adet
    - Eski model / carryover etkisi: ${carryoverTotal} adet
    - Carryover payi: ${carryoverShare}%
    - N+N1 yillik degisim: ${filteredYoy}%

    ODAK MARKA:
    ${focusBrandStr}

    MARKA LIDERLIK TABLOSU:
    ${topBrandStr}

    AYLIK BASKI NOKTALARI:
    ${pressureStr}

    Su basliklarda yonetime sunulacak kadar aksiyon odakli analiz yap:
    1. **Pazar Ritim Okumasi**: N+N1 ve butun madde arasindaki fark ne anlatiyor?
    2. **Carryover / Eski Model Baskisi**: Hangi aylarda stok veya gecis baskisi yuksek?
    3. **Marka Yogunlugu**: Lider markalar pazari nasil kilitliyor, nerede acik alan olabilir?
    4. **Odak Marka Hamlesi**: Secili marka varsa hangi 3 hamleyle saha pozisyonu guclenir?
    5. **Ticari Alarm Listesi**: Hemen izlenmesi gereken riskler ve nedenleri.
    6. **90 Gunluk Plan**: Kisa vadede uygulanabilir 5 somut aksiyon oner.`;

            } else if (type === 'brand-compare') {
                const { brand1, brand2, data1, data2, maxYear } = context;
                userPrompt = `**${brand1}** vs **${brand2}** marka karşılaştırma analizi yap.

    ${brand1}: ${maxYear} satış: ${data1.currPartial} adet, YoY: ${data1.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data1.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data1.avgPrice / 1000)}B TL, Model sayısı: ${data1.models?.length}
    ${brand2}: ${maxYear} satış: ${data2.currPartial} adet, YoY: ${data2.yoyGrowth?.toFixed(1)}%, Pazar payı: ${data2.marketShare?.[maxYear]?.toFixed(1)}%, Ort.Fiyat: ${Math.round(data2.avgPrice / 1000)}B TL, Model sayısı: ${data2.models?.length}

    Şu başlıklarda karşılaştırmalı analiz yap:
    1. **Pazar Konumları**: Her iki markanın güçlü ve zayıf yönleri.
    2. **Fiyat-Performans**: Fiyat stratejileri ve değer önerileri.
    3. **Büyüme Dinamikleri**: YoY trendler neyi işaret ediyor?
    4. **Rekabet Avantajları**: Her markanın temel rekabet üstünlüğü.
    5. **Gelecek Öngörüleri**: Pazar payı değişim beklentileri.`;

            } else {
                return res.status(400).json({ error: 'Bilinmeyen analiz tipi' });
            }

            llmCalled = true;
            // Call Groq API
            const groqRes = await fetch('https://api.minimax.io/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${MINIMAX_API_KEY}`
                },
                body: JSON.stringify({
                    model: MINIMAX_MODEL,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 2048
                }),
                signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
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
            if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
                return res.status(504).json({ error: 'AI servisi zaman aşımına uğradı' });
            }
            // Prompt oluşturma sırasında beklenmeyen şekilli context (ör. null öğeler) -> 400, 500 değil
            if (err instanceof TypeError && !llmCalled) {
                return res.status(400).json({ error: 'Geçersiz context biçimi' });
            }
            res.status(500).json({ error: 'AI analiz hatası: ' + errMsg(err) });
        }
    });
};
