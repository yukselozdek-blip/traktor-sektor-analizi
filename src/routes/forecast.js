'use strict';
// Marka portalı/gelecek istihbaratı seed fonksiyonları ve tahmin (forecast) route'ları, server.js'ten olduğu gibi taşındı.
// Kayıt sırası korunur (orijinal konumda çağrılır).

module.exports = function registerForecast(app, ctx) {
    const { fs, pool, authMiddleware, adminOnly, normalizeSearchText, getCanonicalBrandPortalSlug, requireFeature, requireAiQuota, errMsg } = ctx;

    async function ensureBrandPortalSeeded() {
        const curatedPortalSeed = require('./database/brand-portal-seed');
        const { brands: seedBrands } = require('./database/seed-data');
        const brandsRes = await pool.query(`
            SELECT id, name, slug, website, description
            FROM brands
            WHERE is_active = true
            ORDER BY name
        `);

        const brandMap = new Map(brandsRes.rows.map(row => [getCanonicalBrandPortalSlug(row.name), row]));
        const seedBrandMap = new Map(seedBrands.map(brand => [getCanonicalBrandPortalSlug(brand.name), brand]));

        for (const brand of brandsRes.rows) {
            const canonicalSlug = getCanonicalBrandPortalSlug(brand.name);
            const seedBrand = seedBrandMap.get(canonicalSlug);
            const defaultSourceNotes = JSON.stringify(
                brand.website
                    ? [{ label: 'Resmi site', url: brand.website }]
                    : []
            );

            if (seedBrand) {
                await pool.query(`
                    UPDATE brands
                    SET
                        primary_color = $1,
                        secondary_color = $2,
                        accent_color = $3,
                        text_color = $4,
                        country_of_origin = COALESCE(country_of_origin, $5),
                        parent_company = COALESCE(parent_company, $6)
                    WHERE id = $7
                `, [
                    seedBrand.primary_color,
                    seedBrand.secondary_color,
                    seedBrand.accent_color,
                    seedBrand.text_color,
                    seedBrand.country_of_origin,
                    seedBrand.parent_company,
                    brand.id
                ]);
            }

            await pool.query(`
                INSERT INTO brand_portal_profiles (
                    brand_id, tagline, hero_title, hero_subtitle, overview,
                    website_url, source_notes_json
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                ON CONFLICT (brand_id) DO NOTHING
            `, [
                brand.id,
                `${brand.name} icin ozel marka deneyimi`,
                `${brand.name} Marka Merkezi`,
                `${brand.name} markasi icin login, urun, saha ve haber akislarini bir araya getiren ozel deneyim.`,
                brand.description || `${brand.name} icin marka deneyimini zenginlestiren portal profili.`,
                brand.website || null,
                defaultSourceNotes
            ]);
        }

        for (const [slug, seedPayload] of Object.entries(curatedPortalSeed || {})) {
            const brand = brandMap.get(slug);
            if (!brand) continue;

            const profile = seedPayload.profile || {};
            await pool.query(`
                INSERT INTO brand_portal_profiles (
                    brand_id, tagline, hero_title, hero_subtitle, overview,
                    website_url, dealer_locator_url, price_list_url, portal_url,
                    contact_phone, contact_email, whatsapp_url, headquarters,
                    hero_stats_json, social_links_json, product_lines_json,
                    focus_regions_json, source_notes_json, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11, $12, $13,
                    $14::jsonb, $15::jsonb, $16::jsonb,
                    $17::jsonb, $18::jsonb, NOW()
                )
                ON CONFLICT (brand_id) DO UPDATE SET
                    tagline = EXCLUDED.tagline,
                    hero_title = EXCLUDED.hero_title,
                    hero_subtitle = EXCLUDED.hero_subtitle,
                    overview = EXCLUDED.overview,
                    website_url = EXCLUDED.website_url,
                    dealer_locator_url = EXCLUDED.dealer_locator_url,
                    price_list_url = EXCLUDED.price_list_url,
                    portal_url = EXCLUDED.portal_url,
                    contact_phone = EXCLUDED.contact_phone,
                    contact_email = EXCLUDED.contact_email,
                    whatsapp_url = EXCLUDED.whatsapp_url,
                    headquarters = EXCLUDED.headquarters,
                    hero_stats_json = EXCLUDED.hero_stats_json,
                    social_links_json = EXCLUDED.social_links_json,
                    product_lines_json = EXCLUDED.product_lines_json,
                    focus_regions_json = EXCLUDED.focus_regions_json,
                    source_notes_json = EXCLUDED.source_notes_json,
                    updated_at = NOW()
            `, [
                brand.id,
                profile.tagline || null,
                profile.hero_title || null,
                profile.hero_subtitle || null,
                profile.overview || null,
                profile.website_url || brand.website || null,
                profile.dealer_locator_url || null,
                profile.price_list_url || null,
                profile.portal_url || null,
                profile.contact_phone || null,
                profile.contact_email || null,
                profile.whatsapp_url || null,
                profile.headquarters || null,
                JSON.stringify(profile.hero_stats_json || []),
                JSON.stringify(profile.social_links_json || []),
                JSON.stringify(profile.product_lines_json || []),
                JSON.stringify(profile.focus_regions_json || []),
                JSON.stringify(profile.source_notes_json || [])
            ]);

            for (const item of seedPayload.items || []) {
                await pool.query(`
                    INSERT INTO brand_portal_items (
                        brand_id, item_type, title, summary, cta_label, cta_url,
                        image_url, meta_json, published_at, priority, is_featured, is_active, updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6,
                        $7, $8::jsonb, $9, $10, $11, true, NOW()
                    )
                    ON CONFLICT (brand_id, item_type, title) DO UPDATE SET
                        summary = EXCLUDED.summary,
                        cta_label = EXCLUDED.cta_label,
                        cta_url = EXCLUDED.cta_url,
                        image_url = EXCLUDED.image_url,
                        meta_json = EXCLUDED.meta_json,
                        published_at = EXCLUDED.published_at,
                        priority = EXCLUDED.priority,
                        is_featured = EXCLUDED.is_featured,
                        is_active = true,
                        updated_at = NOW()
                `, [
                    brand.id,
                    item.item_type,
                    item.title,
                    item.summary || null,
                    item.cta_label || null,
                    item.cta_url || null,
                    item.image_url || null,
                    JSON.stringify(item.meta_json || {}),
                    item.published_at || null,
                    item.priority || 100,
                    item.is_featured === true
                ]);
            }

            for (const contact of seedPayload.contacts || []) {
                await pool.query(`
                    INSERT INTO brand_portal_contacts (
                        brand_id, contact_type, label, region_name, city,
                        contact_name, title, phone, email, url, sort_order, is_active, updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9, $10, $11, true, NOW()
                    )
                    ON CONFLICT (brand_id, contact_type, label, city) DO UPDATE SET
                        region_name = EXCLUDED.region_name,
                        contact_name = EXCLUDED.contact_name,
                        title = EXCLUDED.title,
                        phone = EXCLUDED.phone,
                        email = EXCLUDED.email,
                        url = EXCLUDED.url,
                        sort_order = EXCLUDED.sort_order,
                        is_active = true,
                        updated_at = NOW()
                `, [
                    brand.id,
                    contact.contact_type,
                    contact.label,
                    contact.region_name || null,
                    contact.city || null,
                    contact.contact_name || null,
                    contact.title || null,
                    contact.phone || null,
                    contact.email || null,
                    contact.url || null,
                    contact.sort_order || 100
                ]);
            }
        }
    }

    async function ensureFutureIntelligenceSeeded() {
        const {
            intelligenceSources = [],
            supportPrograms = [],
            supportApplicationWindows = []
        } = require('./database/future-intelligence-seed');

        const sourceIdMap = new Map();

        for (const source of intelligenceSources) {
            const result = await pool.query(`
                INSERT INTO intelligence_sources (
                    source_code, title, publisher, source_type, geography_scope,
                    official_url, publication_date, notes, is_active, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW())
                ON CONFLICT (source_code) DO UPDATE SET
                    title = EXCLUDED.title,
                    publisher = EXCLUDED.publisher,
                    source_type = EXCLUDED.source_type,
                    geography_scope = EXCLUDED.geography_scope,
                    official_url = EXCLUDED.official_url,
                    publication_date = EXCLUDED.publication_date,
                    notes = EXCLUDED.notes,
                    is_active = true,
                    updated_at = NOW()
                RETURNING id, source_code
            `, [
                source.source_code,
                source.title,
                source.publisher || null,
                source.source_type,
                source.geography_scope || 'turkiye',
                source.official_url || null,
                source.publication_date || null,
                source.notes || null
            ]);
            sourceIdMap.set(result.rows[0].source_code, result.rows[0].id);
        }

        const programIdMap = new Map();

        for (const program of supportPrograms) {
            const sourceId = sourceIdMap.get(program.source_code) || null;
            const result = await pool.query(`
                INSERT INTO support_programs (
                    program_code, authority_name, program_name, program_type, status,
                    support_scope, support_mode, currency, min_grant_rate_pct,
                    max_grant_rate_pct, source_id, official_url, notes, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
                ON CONFLICT (program_code) DO UPDATE SET
                    authority_name = EXCLUDED.authority_name,
                    program_name = EXCLUDED.program_name,
                    program_type = EXCLUDED.program_type,
                    status = EXCLUDED.status,
                    support_scope = EXCLUDED.support_scope,
                    support_mode = EXCLUDED.support_mode,
                    currency = EXCLUDED.currency,
                    min_grant_rate_pct = EXCLUDED.min_grant_rate_pct,
                    max_grant_rate_pct = EXCLUDED.max_grant_rate_pct,
                    source_id = EXCLUDED.source_id,
                    official_url = EXCLUDED.official_url,
                    notes = EXCLUDED.notes,
                    updated_at = NOW()
                RETURNING id, program_code
            `, [
                program.program_code,
                program.authority_name,
                program.program_name,
                program.program_type || null,
                program.status || 'announced',
                program.support_scope || null,
                program.support_mode || null,
                program.currency || 'TRY',
                program.min_grant_rate_pct ?? null,
                program.max_grant_rate_pct ?? null,
                sourceId,
                program.official_url || null,
                program.notes || null
            ]);
            programIdMap.set(result.rows[0].program_code, result.rows[0].id);
        }

        for (const windowItem of supportApplicationWindows) {
            const programId = programIdMap.get(windowItem.program_code);
            if (!programId) continue;

            await pool.query(`
                INSERT INTO support_application_windows (
                    program_id, application_year, call_no, open_date, close_date,
                    budget_amount, budget_currency, status, notes
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (program_id, application_year, call_no) DO UPDATE SET
                    open_date = EXCLUDED.open_date,
                    close_date = EXCLUDED.close_date,
                    budget_amount = EXCLUDED.budget_amount,
                    budget_currency = EXCLUDED.budget_currency,
                    status = EXCLUDED.status,
                    notes = EXCLUDED.notes
            `, [
                programId,
                windowItem.application_year,
                windowItem.call_no || null,
                windowItem.open_date || null,
                windowItem.close_date || null,
                windowItem.budget_amount ?? null,
                windowItem.budget_currency || 'EUR',
                windowItem.status || 'announced',
                windowItem.notes || null
            ]);
        }

        const ipardProgramId = programIdMap.get('IPARD_III_2025');
        if (ipardProgramId) {
            const provinceRows = await pool.query('SELECT id FROM provinces ORDER BY id');
            for (const province of provinceRows.rows) {
                await pool.query(`
                    INSERT INTO support_program_coverage (
                        program_id, province_id, coverage_scope, eligible_investments,
                        target_segments, notes
                    )
                    SELECT $1, $2, 'province', $3::text[], $4::text[], $5
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM support_program_coverage
                        WHERE program_id = $1 AND province_id = $2 AND coverage_scope = 'province'
                    )
                `, [
                    ipardProgramId,
                    province.id,
                    ['mekanizasyon', 'tarimsal modernizasyon', 'altyapi', 'isletme yatirimi'],
                    ['tarla', 'bahce', 'karma isletme'],
                    'IPARD III programi kapsami il bazinda izlenmek uzere referans coverage kaydi.'
                ]);
            }
        }

        const irrigationProgramId = programIdMap.get('IPARD_III_OPEN_FIELD_IRRIGATION');
        if (irrigationProgramId) {
            await pool.query(`
                INSERT INTO support_program_coverage (
                    program_id, province_id, region_name, coverage_scope, eligible_investments,
                    target_segments, notes
                )
                SELECT $1, NULL, 'Turkiye', 'national', $2::text[], $3::text[], $4
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM support_program_coverage
                    WHERE program_id = $1 AND coverage_scope = 'national'
                )
            `, [
                irrigationProgramId,
                ['sulama', 'acik alan sulama', 'su verimliligi', 'altyapi'],
                ['sulu tarim', 'yuksek verim hedefi', 'su stresi bolgeleri'],
                'Sulama desteklerinin ulusal etkisini izlemek icin referans coverage kaydi.'
            ]);
        }
    }

    function clampMetric(value, min, max) {
        return Math.min(Math.max(Number(value || 0), min), max);
    }

    function addUtcMonths(dateValue, months) {
        const date = new Date(dateValue);
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    }

    function toIsoDate(dateValue) {
        const date = new Date(dateValue);
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }

    function regionKey(value = '') {
        return normalizeSearchText(value);
    }

    async function bulkInsertRows(tableName, columns, rows, chunkSize = 400) {
        if (!rows.length) return;
        for (let start = 0; start < rows.length; start += chunkSize) {
            const chunk = rows.slice(start, start + chunkSize);
            const values = [];
            const placeholders = chunk.map((row, rowIndex) => {
                const baseOffset = rowIndex * columns.length;
                columns.forEach(column => values.push(row[column] ?? null));
                return `(${columns.map((_, colIndex) => `$${baseOffset + colIndex + 1}`).join(',')})`;
            }).join(',');
            await pool.query(`INSERT INTO ${tableName} (${columns.join(',')}) VALUES ${placeholders}`, values);
        }
    }

    async function ensureReferenceMarketSignalsSeeded(options = {}) {
        const { replaceExisting = false } = options;
        const { commodityCatalog = [] } = require('./database/future-intelligence-seed');
        const { commodityYearBase, monthlySeasonality, regionClimateScenarioReference } = require('./database/future-market-reference');

        const sourceRes = await pool.query(`
            SELECT source_code, id
            FROM intelligence_sources
            WHERE source_code IN ('tuik_data_portal', 'mgm_climate_projections')
        `);
        const sourceMap = new Map(sourceRes.rows.map(row => [row.source_code, row.id]));
        const tuikSourceId = sourceMap.get('tuik_data_portal') || null;
        const mgmSourceId = sourceMap.get('mgm_climate_projections') || null;

        const commodityCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM commodity_prices WHERE market_scope = 'reference-index'`);
        const climateCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`);
        const commodityCount = parseInt(commodityCountRes.rows[0]?.count || 0, 10);
        const climateCount = parseInt(climateCountRes.rows[0]?.count || 0, 10);

        if (replaceExisting) {
            await pool.query(`DELETE FROM commodity_prices WHERE market_scope = 'reference-index'`);
            await pool.query(`DELETE FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`);
        }

        if (replaceExisting || commodityCount === 0) {
            const commodityNameMap = new Map(commodityCatalog.map(item => [item.commodity_code, item.commodity_name]));
            const rows = [];

            for (const [commodityCode, years] of Object.entries(commodityYearBase || {})) {
                const commodityName = commodityNameMap.get(commodityCode) || commodityCode;
                for (const [yearText, baseIndex] of Object.entries(years || {})) {
                    const year = parseInt(yearText, 10);
                    monthlySeasonality.forEach((multiplier, monthIndex) => {
                        const month = monthIndex + 1;
                        rows.push({
                            commodity_code: commodityCode,
                            commodity_name: commodityName,
                            market_scope: 'reference-index',
                            province_id: null,
                            price_date: `${year}-${String(month).padStart(2, '0')}-01`,
                            year,
                            month,
                            unit: 'index_2022_100',
                            currency: 'INDEX',
                            nominal_price: Number((Number(baseIndex) * Number(multiplier)).toFixed(2)),
                            source_id: tuikSourceId,
                            metadata_json: JSON.stringify({
                                mode: 'reference_seed',
                                note: 'Official import gelene kadar forecast motoru icin referans endeks serisi.',
                                year_base: Number(baseIndex),
                                seasonality_multiplier: Number(multiplier)
                            })
                        });
                    });
                }
            }

            await bulkInsertRows('commodity_prices', [
                'commodity_code', 'commodity_name', 'market_scope', 'province_id', 'price_date', 'year', 'month',
                'unit', 'currency', 'nominal_price', 'source_id', 'metadata_json'
            ], rows, 500);
        }

        if (replaceExisting || climateCount === 0) {
            const rows = [];
            const metricLabels = {
                temp_change_c: 'Sicaklik degisimi',
                rainfall_change_pct: 'Yagis degisimi',
                drought_risk_pct: 'Kuraklik riski kaymasi'
            };

            for (const [regionName, scenarios] of Object.entries(regionClimateScenarioReference || {})) {
                for (const [scenarioCode, horizons] of Object.entries(scenarios || {})) {
                    for (const [horizonText, metrics] of Object.entries(horizons || {})) {
                        const horizonYear = parseInt(horizonText, 10);
                        for (const [metricCode, changeValue] of Object.entries(metrics || {})) {
                            rows.push({
                                province_id: null,
                                region_name: regionName,
                                scenario_code: scenarioCode,
                                horizon_year: horizonYear,
                                metric_code: metricCode,
                                metric_label: metricLabels[metricCode] || metricCode,
                                change_value: changeValue,
                                change_unit: metricCode.includes('pct') ? 'pct' : 'celsius',
                                baseline_period: '2020-2024',
                                source_id: mgmSourceId,
                                notes: 'Reference scenario scaffold. Resmi MGM importu geldiginde degistirilecek.'
                            });
                        }
                    }
                }
            }

            await bulkInsertRows('climate_projection_scenarios', [
                'province_id', 'region_name', 'scenario_code', 'horizon_year', 'metric_code', 'metric_label',
                'change_value', 'change_unit', 'baseline_period', 'source_id', 'notes'
            ], rows, 500);
        }
    }

    function adjustFeatureShareRows(featureType, rows, context = {}) {
        const baseRows = rows.map(item => ({ ...item }));
        if (!baseRows.length) return baseRows;

        const adjustments = new Map();
        if (featureType === 'drive_type') {
            if (context.supportBoost > 0 || context.climatePenalty < -0.005) {
                adjustments.set('4WD', 0.03);
                adjustments.set('2WD', -0.03);
            }
        } else if (featureType === 'cabin_type') {
            adjustments.set('kabinli', 0.04);
            adjustments.set('rollbar', -0.04);
        } else if (featureType === 'hp_range') {
            adjustments.set('90-99', 0.02);
            adjustments.set('100-109', 0.02);
            adjustments.set('110-119', 0.01);
            adjustments.set('1-39', -0.02);
            adjustments.set('40-49', -0.015);
            adjustments.set('50-54', -0.01);
        }

        if (adjustments.size === 0) return baseRows;

        baseRows.forEach(item => {
            item.demand_share_pct = clampMetric(Number(item.demand_share_pct || 0) + (adjustments.get(item.feature_value) || 0), 0.001, 0.999);
        });

        const shareTotal = baseRows.reduce((sum, item) => sum + Number(item.demand_share_pct || 0), 0) || 1;
        baseRows.forEach(item => {
            item.demand_share_pct = Number((Number(item.demand_share_pct || 0) / shareTotal).toFixed(6));
            item.demand_units = Number((Number(item.demand_units || 0)).toFixed(4));
        });
        return baseRows;
    }

    async function runBaselineForecast(options = {}) {
        const horizonMonths = Math.max(12, Math.min(parseInt(options.horizonMonths || 24, 10), 120));
        const scenarioCode = String(options.scenarioCode || 'base');
        const createdByUserId = Number(options.createdByUserId || 0) || null;
        const normalizedTuikBrandExpr = `
            CASE
                WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                ELSE UPPER(tv.marka)
            END
        `;
        const normalizedTeknikBrandExpr = `
            CASE
                WHEN UPPER(tk.marka) = 'CASE IH' THEN 'CASE'
                WHEN UPPER(tk.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                WHEN UPPER(tk.marka) = 'KIOTI' THEN 'KİOTİ'
                ELSE UPPER(tk.marka)
            END
        `;
        const hpRangeExpr = `
            CASE
                WHEN tk.motor_gucu_hp IS NULL THEN NULL
                WHEN tk.motor_gucu_hp <= 39 THEN '1-39'
                WHEN tk.motor_gucu_hp <= 49 THEN '40-49'
                WHEN tk.motor_gucu_hp <= 54 THEN '50-54'
                WHEN tk.motor_gucu_hp <= 59 THEN '55-59'
                WHEN tk.motor_gucu_hp <= 69 THEN '60-69'
                WHEN tk.motor_gucu_hp <= 79 THEN '70-79'
                WHEN tk.motor_gucu_hp <= 89 THEN '80-89'
                WHEN tk.motor_gucu_hp <= 99 THEN '90-99'
                WHEN tk.motor_gucu_hp <= 109 THEN '100-109'
                WHEN tk.motor_gucu_hp <= 119 THEN '110-119'
                ELSE '120+'
            END
        `;
        const latestRes = await pool.query(`SELECT MAX(MAKE_DATE(tescil_yil, tescil_ay, 1)) AS latest_period FROM tuik_veri`);
        const latestPeriod = latestRes.rows[0]?.latest_period;
        if (!latestPeriod) {
            return { created: false, reason: 'sales_view bos oldugu icin forecast uretilemedi' };
        }

        await ensureReferenceMarketSignalsSeeded();

        const latestDate = new Date(latestPeriod);
        const latestYear = latestDate.getUTCFullYear();
        const forecastKey = `baseline_${scenarioCode}_${Date.now()}`;

        const seasonalityRes = await pool.query(`
            SELECT tv.tescil_ay AS month, SUM(tv.satis_adet)::decimal AS total_units
            FROM tuik_veri tv
            WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
            GROUP BY tv.tescil_ay
            ORDER BY month
        `, [toIsoDate(latestDate)]);
        const seasonalityMap = new Map();
        const seasonalityValues = seasonalityRes.rows.map(row => Number(row.total_units || 0));
        const seasonalityAvg = seasonalityValues.reduce((sum, item) => sum + item, 0) / Math.max(seasonalityValues.length, 1);
        seasonalityRes.rows.forEach(row => {
            seasonalityMap.set(Number(row.month), seasonalityAvg > 0 ? Number(row.total_units || 0) / seasonalityAvg : 1);
        });

        const comboRes = await pool.query(`
            WITH monthly AS (
                SELECT
                    p.id AS province_id,
                    b.id AS brand_id,
                    MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) AS period_date,
                    SUM(tv.satis_adet)::decimal AS total_units
                FROM tuik_veri tv
                JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
                JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                WHERE tv.tescil_yil IS NOT NULL
                  AND tv.tescil_ay IS NOT NULL
                  AND MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
                GROUP BY p.id, b.id, MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1)
            )
            SELECT
                province_id,
                brand_id,
                SUM(CASE WHEN period_date >= (DATE_TRUNC('month', $1::date) - INTERVAL '11 months') THEN total_units ELSE 0 END) AS last12_units,
                SUM(CASE WHEN period_date BETWEEN (DATE_TRUNC('month', $1::date) - INTERVAL '23 months') AND (DATE_TRUNC('month', $1::date) - INTERVAL '12 months') THEN total_units ELSE 0 END) AS prev12_units,
                AVG(CASE WHEN period_date >= (DATE_TRUNC('month', $1::date) - INTERVAL '5 months') THEN total_units END) AS last6_avg_units,
                COUNT(*)::int AS observed_months
            FROM monthly
            GROUP BY province_id, brand_id
            HAVING SUM(total_units) >= 12
        `, [toIsoDate(latestDate)]);

        const provinceMetaRes = await pool.query(`
            SELECT
                p.id,
                p.name,
                p.region,
                EXISTS (
                    SELECT 1
                    FROM support_program_coverage spc
                    JOIN support_programs sp ON sp.id = spc.program_id
                    WHERE spc.province_id = p.id
                      AND sp.status IN ('announced', 'active')
                ) AS has_support
            FROM provinces p
        `);
        const provinceMetaMap = new Map(provinceMetaRes.rows.map(row => [Number(row.id), row]));

        const climateRes = await pool.query(`
            SELECT
                region_name,
                scenario_code,
                horizon_year,
                MAX(CASE WHEN metric_code = 'temp_change_c' THEN change_value END) AS temp_change_c,
                MAX(CASE WHEN metric_code = 'rainfall_change_pct' THEN change_value END) AS rainfall_change_pct,
                MAX(CASE WHEN metric_code = 'drought_risk_pct' THEN change_value END) AS drought_risk_pct
            FROM climate_projection_scenarios
            WHERE scenario_code IN ('reference_base', 'reference_stress')
              AND horizon_year = 2030
            GROUP BY region_name, scenario_code, horizon_year
        `);
        const climateMap = new Map(climateRes.rows.map(row => [`${regionKey(row.region_name)}:${row.scenario_code}`, row]));

        const commoditySignalRes = await pool.query(`
            SELECT AVG(growth_ratio)::decimal AS avg_growth_ratio
            FROM (
                SELECT
                    curr.commodity_code,
                    AVG((curr.nominal_price - prev.nominal_price) / NULLIF(prev.nominal_price, 0)) AS growth_ratio
                FROM commodity_prices curr
                JOIN commodity_prices prev
                  ON prev.commodity_code = curr.commodity_code
                 AND prev.market_scope = curr.market_scope
                 AND COALESCE(prev.province_id, 0) = COALESCE(curr.province_id, 0)
                 AND prev.month = curr.month
                 AND prev.year = curr.year - 1
                WHERE curr.market_scope = 'reference-index'
                  AND curr.year = $1
                GROUP BY curr.commodity_code
            ) s
        `, [latestYear]);
        const commoditySignal = Number(commoditySignalRes.rows[0]?.avg_growth_ratio || 0);

        const runInsertRes = await pool.query(`
            INSERT INTO forecast_runs (
                forecast_key, model_family, scope_level, target_entity_type, target_entity_id,
                scenario_code, forecast_horizon_months, training_start_year, training_end_year,
                run_status, metrics_json, feature_snapshot_json, notes, created_by_user_id
            )
            VALUES ($1, 'baseline_momentum_v1', 'province_brand', 'market', NULL, $2, $3, $4, $5, 'running', '{}'::jsonb, '{}'::jsonb, $6, $7)
            RETURNING id
        `, [
            forecastKey,
            scenarioCode,
            horizonMonths,
            Math.max(2022, latestYear - 2),
            latestYear,
            'Sales momentum + support + climate + commodity reference signal ile uretilen ilk baz forecast kosusu.',
            createdByUserId
        ]);
        const forecastRunId = runInsertRes.rows[0].id;

        const featureStoreRows = [];
        const forecastOutputRows = [];
        const baselineAnnualUnitsMap = new Map();

        comboRes.rows.forEach(row => {
            const provinceId = Number(row.province_id);
            const brandId = Number(row.brand_id);
            const provinceMeta = provinceMetaMap.get(provinceId) || {};
            const normalizedRegion = regionKey(provinceMeta.region || '');
            const climateBase = climateMap.get(`${normalizedRegion}:reference_base`) || {};
            const climateStress = climateMap.get(`${normalizedRegion}:reference_stress`) || climateBase;
            const last12Units = Number(row.last12_units || 0);
            const prev12Units = Number(row.prev12_units || 0);
            const last6Avg = Number(row.last6_avg_units || 0);
            const yoyGrowth = prev12Units > 0 ? (last12Units - prev12Units) / prev12Units : 0.04;
            const supportBoost = provinceMeta.has_support ? 0.02 : 0;
            const climatePenaltyBase = (Number(climateBase.rainfall_change_pct || 0) < -4 ? -0.012 : -0.004) + (Number(climateBase.temp_change_c || 0) > 1.1 ? -0.008 : 0);
            const climatePenaltyStress = (Number(climateStress.rainfall_change_pct || 0) < -5 ? -0.018 : -0.006) + (Number(climateStress.temp_change_c || 0) > 1.25 ? -0.012 : 0);
            const climatePenalty = scenarioCode === 'stress' ? climatePenaltyStress : climatePenaltyBase;
            const commodityBoost = clampMetric(commoditySignal * 0.20, -0.02, 0.04);
            const yoyFactor = clampMetric(yoyGrowth * 0.35, -0.16, 0.22);
            const annualDrift = 1 + yoyFactor + supportBoost + commodityBoost + climatePenalty;
            const baselineMonthlyUnits = Math.max(last12Units / 12, last6Avg, 1);
            const uncertainty = clampMetric(0.18 + Math.abs(yoyGrowth) * 0.25, 0.12, 0.35);

            baselineAnnualUnitsMap.set(`${provinceId}:${brandId}`, Number((baselineMonthlyUnits * 12).toFixed(4)));

            featureStoreRows.push(
                {
                    forecast_key: forecastKey,
                    snapshot_date: toIsoDate(latestDate),
                    province_id: provinceId,
                    brand_id: brandId,
                    commodity_code: null,
                    feature_code: 'recent_12m_units',
                    feature_value: last12Units,
                    feature_unit: 'units',
                    feature_source: 'sales_view',
                    source_id: null,
                    metadata_json: JSON.stringify({ mode: 'observed' })
                },
                {
                    forecast_key: forecastKey,
                    snapshot_date: toIsoDate(latestDate),
                    province_id: provinceId,
                    brand_id: brandId,
                    commodity_code: null,
                    feature_code: 'yoy_growth_ratio',
                    feature_value: Number(yoyGrowth.toFixed(4)),
                    feature_unit: 'ratio',
                    feature_source: 'sales_view',
                    source_id: null,
                    metadata_json: JSON.stringify({ mode: 'observed' })
                },
                {
                    forecast_key: forecastKey,
                    snapshot_date: toIsoDate(latestDate),
                    province_id: provinceId,
                    brand_id: brandId,
                    commodity_code: null,
                    feature_code: 'support_boost',
                    feature_value: Number(supportBoost.toFixed(4)),
                    feature_unit: 'ratio',
                    feature_source: 'support_program_coverage',
                    source_id: null,
                    metadata_json: JSON.stringify({ has_support: Boolean(provinceMeta.has_support) })
                },
                {
                    forecast_key: forecastKey,
                    snapshot_date: toIsoDate(latestDate),
                    province_id: provinceId,
                    brand_id: brandId,
                    commodity_code: 'AGRI_BASKET',
                    feature_code: 'commodity_signal_ratio',
                    feature_value: Number(commodityBoost.toFixed(4)),
                    feature_unit: 'ratio',
                    feature_source: 'commodity_prices',
                    source_id: null,
                    metadata_json: JSON.stringify({ reference_mode: true })
                },
                {
                    forecast_key: forecastKey,
                    snapshot_date: toIsoDate(latestDate),
                    province_id: provinceId,
                    brand_id: brandId,
                    commodity_code: null,
                    feature_code: 'climate_penalty',
                    feature_value: Number(climatePenalty.toFixed(4)),
                    feature_unit: 'ratio',
                    feature_source: 'climate_projection_scenarios',
                    source_id: null,
                    metadata_json: JSON.stringify({ region: provinceMeta.region || null, scenario_code: scenarioCode })
                }
            );

            for (let offset = 1; offset <= horizonMonths; offset++) {
                const targetDate = addUtcMonths(latestDate, offset);
                const month = targetDate.getUTCMonth() + 1;
                const seasonality = seasonalityMap.get(month) || 1;
                const growthCurve = Math.pow(Math.max(0.90, annualDrift), offset / 12);
                const predictedUnits = Math.max(0.5, baselineMonthlyUnits * seasonality * growthCurve);
                const summaryParts = [
                    `yoy ${Number((yoyGrowth * 100).toFixed(1))}%`,
                    provinceMeta.has_support ? 'destek etkisi +' : 'destek etkisi 0',
                    `iklim ${Number((climatePenalty * 100).toFixed(1))}%`,
                    `emtia ${Number((commodityBoost * 100).toFixed(1))}%`
                ];

                forecastOutputRows.push({
                    forecast_run_id: forecastRunId,
                    period_year: targetDate.getUTCFullYear(),
                    period_month: month,
                    province_id: provinceId,
                    brand_id: brandId,
                    hp_range: null,
                    drive_type: null,
                    cabin_type: null,
                    category: null,
                    predicted_units: Number(predictedUnits.toFixed(4)),
                    confidence_low: Number((predictedUnits * (1 - uncertainty)).toFixed(4)),
                    confidence_high: Number((predictedUnits * (1 + uncertainty)).toFixed(4)),
                    baseline_units: Number(baselineMonthlyUnits.toFixed(4)),
                    signal_summary: summaryParts.join(' | ')
                });
            }
        });

        const featureMixRes = await pool.query(`
            WITH base AS (
                SELECT
                    p.id AS province_id,
                    b.id AS brand_id,
                    ${hpRangeExpr}::text AS feature_value,
                    'hp_range'::text AS feature_type,
                    SUM(tv.satis_adet)::decimal AS units
                FROM tuik_veri tv
                JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
                JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                LEFT JOIN teknik_veri tk
                  ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
                 AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
                WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
                  AND ${hpRangeExpr} IS NOT NULL
                GROUP BY p.id, b.id, ${hpRangeExpr}
                UNION ALL
                SELECT
                    p.id,
                    b.id,
                    COALESCE(NULLIF(tk.cekis_tipi, ''), '4WD')::text,
                    'drive_type'::text,
                    SUM(tv.satis_adet)::decimal
                FROM tuik_veri tv
                JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
                JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                LEFT JOIN teknik_veri tk
                  ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
                 AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
                WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
                GROUP BY p.id, b.id, COALESCE(NULLIF(tk.cekis_tipi, ''), '4WD')
                UNION ALL
                SELECT
                    p.id,
                    b.id,
                    CASE WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli' ELSE 'rollbar' END::text,
                    'cabin_type'::text,
                    SUM(tv.satis_adet)::decimal
                FROM tuik_veri tv
                JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
                JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                LEFT JOIN teknik_veri tk
                  ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
                 AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
                WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
                GROUP BY p.id, b.id, CASE WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli' ELSE 'rollbar' END
                UNION ALL
                SELECT
                    p.id,
                    b.id,
                    CASE WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah%' THEN 'bahce' ELSE 'tarla' END::text,
                    'category'::text,
                    SUM(tv.satis_adet)::decimal
                FROM tuik_veri tv
                JOIN provinces p ON p.plate_code = LPAD(tv.sehir_kodu::text, 2, '0')
                JOIN brands b ON UPPER(b.name) = ${normalizedTuikBrandExpr}
                LEFT JOIN teknik_veri tk
                  ON ${normalizedTeknikBrandExpr} = ${normalizedTuikBrandExpr}
                 AND UPPER(COALESCE(tk.tuik_model_adi, '')) = UPPER(COALESCE(tv.tuik_model_adi, ''))
                WHERE MAKE_DATE(tv.tescil_yil, tv.tescil_ay, 1) >= (DATE_TRUNC('month', $1::date) - INTERVAL '23 months')
                GROUP BY p.id, b.id, CASE WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bah%' THEN 'bahce' ELSE 'tarla' END
            )
            SELECT * FROM base
        `, [toIsoDate(latestDate)]);

        const groupedFeatureMix = new Map();
        featureMixRes.rows.forEach(row => {
            const key = `${row.province_id}:${row.brand_id}:${row.feature_type}`;
            if (!groupedFeatureMix.has(key)) groupedFeatureMix.set(key, []);
            groupedFeatureMix.get(key).push({
                province_id: Number(row.province_id),
                brand_id: Number(row.brand_id),
                feature_type: row.feature_type,
                feature_value: String(row.feature_value || 'bilinmiyor'),
                units: Number(row.units || 0)
            });
        });

        const modelFeatureDemandRows = [];
        for (const items of groupedFeatureMix.values()) {
            const provinceId = items[0].province_id;
            const brandId = items[0].brand_id;
            const provinceMeta = provinceMetaMap.get(provinceId) || {};
            const normalizedRegion = regionKey(provinceMeta.region || '');
            const climateBase = climateMap.get(`${normalizedRegion}:reference_base`) || {};
            const totalUnits = items.reduce((sum, item) => sum + Number(item.units || 0), 0) || 1;
            const baseRows = items.map(item => ({
                province_id: provinceId,
                brand_id: brandId,
                feature_type: item.feature_type,
                feature_value: item.feature_value,
                demand_share_pct: Number((Number(item.units || 0) / totalUnits).toFixed(6)),
                demand_units: Number(item.units || 0)
            }));

            const context = {
                supportBoost: provinceMeta.has_support ? 0.02 : 0,
                climatePenalty: (Number(climateBase.rainfall_change_pct || 0) < -4 ? -0.012 : -0.004) + (Number(climateBase.temp_change_c || 0) > 1.1 ? -0.008 : 0)
            };

            const nextYearRows = adjustFeatureShareRows(items[0].feature_type, baseRows, context);
            const longTermRows = adjustFeatureShareRows(items[0].feature_type, nextYearRows, context);

            nextYearRows.forEach(item => modelFeatureDemandRows.push({
                forecast_run_id: forecastRunId,
                province_id: item.province_id,
                brand_id: item.brand_id,
                horizon_year: latestYear + 1,
                feature_type: item.feature_type,
                feature_value: item.feature_value,
                demand_share_pct: item.demand_share_pct,
                demand_units: Number(((baselineAnnualUnitsMap.get(`${item.province_id}:${item.brand_id}`) || 0) * item.demand_share_pct).toFixed(4)),
                evidence_json: JSON.stringify({ mode: 'baseline_share', reference_shift: false })
            }));

            longTermRows.forEach(item => modelFeatureDemandRows.push({
                forecast_run_id: forecastRunId,
                province_id: item.province_id,
                brand_id: item.brand_id,
                horizon_year: latestYear + 10,
                feature_type: item.feature_type,
                feature_value: item.feature_value,
                demand_share_pct: item.demand_share_pct,
                demand_units: Number((((forecastOutputRows.find(output => output.province_id === item.province_id && output.brand_id === item.brand_id)?.baseline_units || 0) * 12) * item.demand_share_pct).toFixed(4)),
                evidence_json: JSON.stringify({ mode: 'baseline_share', reference_shift: true })
            }));
        }

        await bulkInsertRows('forecast_feature_store', [
            'forecast_key', 'snapshot_date', 'province_id', 'brand_id', 'commodity_code',
            'feature_code', 'feature_value', 'feature_unit', 'feature_source', 'source_id', 'metadata_json'
        ], featureStoreRows, 500);

        await bulkInsertRows('forecast_outputs', [
            'forecast_run_id', 'period_year', 'period_month', 'province_id', 'brand_id', 'hp_range',
            'drive_type', 'cabin_type', 'category', 'predicted_units', 'confidence_low', 'confidence_high',
            'baseline_units', 'signal_summary'
        ], forecastOutputRows, 500);

        await bulkInsertRows('model_feature_demand', [
            'forecast_run_id', 'province_id', 'brand_id', 'horizon_year', 'feature_type', 'feature_value',
            'demand_share_pct', 'demand_units', 'evidence_json'
        ], modelFeatureDemandRows, 500);

        const totalPredicted = forecastOutputRows.reduce((sum, row) => sum + Number(row.predicted_units || 0), 0);
        await pool.query(`
            UPDATE forecast_runs
            SET
                run_status = 'completed',
                metrics_json = $2::jsonb,
                feature_snapshot_json = $3::jsonb,
                updated_at = NOW()
            WHERE id = $1
        `, [
            forecastRunId,
            JSON.stringify({
                output_row_count: forecastOutputRows.length,
                feature_row_count: featureStoreRows.length,
                feature_demand_row_count: modelFeatureDemandRows.length,
                total_predicted_units: Number(totalPredicted.toFixed(2))
            }),
            JSON.stringify({
                latest_period: toIsoDate(latestDate),
                commodity_signal_ratio: Number(commoditySignal.toFixed(4)),
                scenario_code: scenarioCode,
                reference_mode: true
            })
        ]);

        return {
            created: true,
            forecast_run_id: forecastRunId,
            forecast_key: forecastKey,
            latest_period: toIsoDate(latestDate),
            output_row_count: forecastOutputRows.length,
            feature_row_count: featureStoreRows.length,
            feature_demand_row_count: modelFeatureDemandRows.length,
            total_predicted_units: Number(totalPredicted.toFixed(2))
        };
    }

    async function getForecastExecutiveView(options = {}) {
        const requestedRunId = options.forecastRunId ? parseInt(options.forecastRunId, 10) : null;
        const requestedProvinceId = options.provinceId ? parseInt(options.provinceId, 10) : null;
        const requestedBrandId = options.brandId ? parseInt(options.brandId, 10) : null;
        const featureTypeLabels = {
            hp_range: 'HP koridoru',
            drive_type: 'Cekis mimarisi',
            cabin_type: 'Kabin yapisi',
            category: 'Kullanim alanı'
        };

        const runRes = requestedRunId
            ? await pool.query(`
                SELECT *
                FROM forecast_runs
                WHERE id = $1
                LIMIT 1
            `, [requestedRunId])
            : await pool.query(`
                SELECT *
                FROM forecast_runs
                WHERE run_status = 'completed'
                ORDER BY created_at DESC
                LIMIT 1
            `);

        const run = runRes.rows[0];
        if (!run) {
            return {
                run: null,
                overview: null,
                monthly_curve: [],
                top_provinces: [],
                feature_outlook: [],
                feature_shift: []
            };
        }

        const snapshot = run.feature_snapshot_json || {};
        const latestPeriodIso = snapshot.latest_period || toIsoDate(run.created_at);
        const next12EndIso = toIsoDate(addUtcMonths(latestPeriodIso, 12));

        const summaryParams = [run.id, next12EndIso];
        let outputFilterSql = '';
        if (requestedProvinceId) {
            summaryParams.push(requestedProvinceId);
            outputFilterSql += ` AND fo.province_id = $${summaryParams.length}`;
        }
        if (requestedBrandId) {
            summaryParams.push(requestedBrandId);
            outputFilterSql += ` AND fo.brand_id = $${summaryParams.length}`;
        }

        const monthlyParams = [run.id];
        let monthlyFilterSql = '';
        if (requestedProvinceId) {
            monthlyParams.push(requestedProvinceId);
            monthlyFilterSql += ` AND fo.province_id = $${monthlyParams.length}`;
        }
        if (requestedBrandId) {
            monthlyParams.push(requestedBrandId);
            monthlyFilterSql += ` AND fo.brand_id = $${monthlyParams.length}`;
        }

        const provinceParams = [run.id, next12EndIso, run.forecast_key];
        let provinceOutputFilterSql = '';
        let provinceFeatureFilterSql = '';
        if (requestedProvinceId) {
            provinceParams.push(requestedProvinceId);
            provinceOutputFilterSql += ` AND fo.province_id = $${provinceParams.length}`;
            provinceFeatureFilterSql += ` AND fs.province_id = $${provinceParams.length}`;
        }
        if (requestedBrandId) {
            provinceParams.push(requestedBrandId);
            provinceOutputFilterSql += ` AND fo.brand_id = $${provinceParams.length}`;
            provinceFeatureFilterSql += ` AND fs.brand_id = $${provinceParams.length}`;
        }

        const featureParams = [run.id];
        let featureFilterSql = '';
        if (requestedProvinceId) {
            featureParams.push(requestedProvinceId);
            featureFilterSql += ` AND mfd.province_id = $${featureParams.length}`;
        }
        if (requestedBrandId) {
            featureParams.push(requestedBrandId);
            featureFilterSql += ` AND mfd.brand_id = $${featureParams.length}`;
        }

        const [summaryRes, monthlyCurveRes, provinceRes, featureDemandRes] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(*)::int AS row_count,
                    COUNT(DISTINCT fo.province_id)::int AS province_count,
                    COUNT(DISTINCT fo.brand_id)::int AS brand_count,
                    SUM(fo.predicted_units)::decimal AS total_horizon_units,
                    SUM(CASE
                        WHEN MAKE_DATE(fo.period_year, fo.period_month, 1) <= $2::date THEN fo.predicted_units
                        ELSE 0
                    END)::decimal AS next_12m_units,
                    AVG(fo.predicted_units)::decimal AS avg_monthly_units
                FROM forecast_outputs fo
                WHERE fo.forecast_run_id = $1
                ${outputFilterSql}
            `, summaryParams),
            pool.query(`
                SELECT
                    fo.period_year,
                    fo.period_month,
                    SUM(fo.predicted_units)::decimal AS predicted_units_total,
                    SUM(fo.confidence_low)::decimal AS confidence_low_total,
                    SUM(fo.confidence_high)::decimal AS confidence_high_total
                FROM forecast_outputs fo
                WHERE fo.forecast_run_id = $1
                ${monthlyFilterSql}
                GROUP BY fo.period_year, fo.period_month
                ORDER BY fo.period_year, fo.period_month
                LIMIT 24
            `, monthlyParams),
            pool.query(`
                WITH province_forecast AS (
                    SELECT
                        fo.province_id,
                        p.name AS province_name,
                        p.region AS region_name,
                        EXISTS (
                            SELECT 1
                            FROM support_program_coverage spc
                            JOIN support_programs sp ON sp.id = spc.program_id
                            WHERE spc.province_id = fo.province_id
                              AND sp.status IN ('announced', 'active')
                        ) AS has_support,
                        SUM(CASE
                            WHEN MAKE_DATE(fo.period_year, fo.period_month, 1) <= $2::date THEN fo.predicted_units
                            ELSE 0
                        END)::decimal AS next_12m_units,
                        SUM(fo.predicted_units)::decimal AS total_horizon_units,
                        AVG(fo.predicted_units)::decimal AS avg_monthly_units
                    FROM forecast_outputs fo
                    LEFT JOIN provinces p ON p.id = fo.province_id
                    WHERE fo.forecast_run_id = $1
                    ${provinceOutputFilterSql}
                    GROUP BY fo.province_id, p.name, p.region
                ),
                province_observed AS (
                    SELECT
                        fs.province_id,
                        SUM(fs.feature_value)::decimal AS recent_12m_units
                    FROM forecast_feature_store fs
                    WHERE fs.forecast_key = $3
                      AND fs.feature_code = 'recent_12m_units'
                    ${provinceFeatureFilterSql}
                    GROUP BY fs.province_id
                )
                SELECT
                    pf.province_id,
                    pf.province_name,
                    pf.region_name,
                    pf.has_support,
                    pf.next_12m_units,
                    pf.total_horizon_units,
                    pf.avg_monthly_units,
                    po.recent_12m_units,
                    CASE
                        WHEN COALESCE(po.recent_12m_units, 0) > 0
                            THEN ((pf.next_12m_units - po.recent_12m_units) / po.recent_12m_units) * 100
                        ELSE NULL
                    END AS growth_pct
                FROM province_forecast pf
                LEFT JOIN province_observed po ON po.province_id = pf.province_id
                ORDER BY pf.next_12m_units DESC
            `, provinceParams),
            pool.query(`
                WITH raw AS (
                    SELECT
                        mfd.horizon_year,
                        mfd.feature_type,
                        mfd.feature_value,
                        SUM(mfd.demand_units)::decimal AS demand_units_total
                    FROM model_feature_demand mfd
                    WHERE mfd.forecast_run_id = $1
                    ${featureFilterSql}
                    GROUP BY mfd.horizon_year, mfd.feature_type, mfd.feature_value
                ),
                totals AS (
                    SELECT
                        horizon_year,
                        feature_type,
                        SUM(demand_units_total)::decimal AS type_total_units
                    FROM raw
                    GROUP BY horizon_year, feature_type
                )
                SELECT
                    raw.horizon_year,
                    raw.feature_type,
                    raw.feature_value,
                    raw.demand_units_total,
                    CASE
                        WHEN COALESCE(totals.type_total_units, 0) > 0
                            THEN (raw.demand_units_total / totals.type_total_units) * 100
                        ELSE 0
                    END AS demand_share_pct
                FROM raw
                JOIN totals
                  ON totals.horizon_year = raw.horizon_year
                 AND totals.feature_type = raw.feature_type
                ORDER BY raw.horizon_year, raw.feature_type, raw.demand_units_total DESC
            `, featureParams)
        ]);

        const monthlyCurve = monthlyCurveRes.rows.map(row => ({
            period_year: Number(row.period_year),
            period_month: Number(row.period_month),
            predicted_units_total: Number(row.predicted_units_total || 0),
            confidence_low_total: Number(row.confidence_low_total || 0),
            confidence_high_total: Number(row.confidence_high_total || 0)
        }));

        const topProvinceRows = provinceRes.rows.map(row => ({
            province_id: Number(row.province_id),
            province_name: row.province_name,
            region_name: row.region_name,
            has_support: Boolean(row.has_support),
            next_12m_units: Number(row.next_12m_units || 0),
            total_horizon_units: Number(row.total_horizon_units || 0),
            avg_monthly_units: Number(row.avg_monthly_units || 0),
            recent_12m_units: Number(row.recent_12m_units || 0),
            growth_pct: row.growth_pct == null ? null : Number(row.growth_pct)
        }));

        const featureOutlookRows = featureDemandRes.rows.map(row => ({
            horizon_year: Number(row.horizon_year),
            feature_type: row.feature_type,
            feature_label: featureTypeLabels[row.feature_type] || row.feature_type,
            feature_value: row.feature_value,
            demand_units_total: Number(row.demand_units_total || 0),
            demand_share_pct: Number(row.demand_share_pct || 0)
        }));

        const horizonYears = Array.from(new Set(featureOutlookRows.map(row => row.horizon_year))).sort((a, b) => a - b);
        const nextYear = horizonYears[0] || null;
        const longTermYear = horizonYears[horizonYears.length - 1] || null;

        const featureShift = Object.keys(featureTypeLabels).map(featureType => {
            const nextRows = featureOutlookRows.filter(row => row.feature_type === featureType && row.horizon_year === nextYear);
            const longRows = featureOutlookRows.filter(row => row.feature_type === featureType && row.horizon_year === longTermYear);
            const dominantNext = nextRows[0] || null;
            const dominantLong = longRows[0] || null;
            const valueUniverse = Array.from(new Set([
                ...nextRows.map(row => row.feature_value),
                ...longRows.map(row => row.feature_value)
            ]));

            const strongestGainer = valueUniverse.map(featureValue => {
                const nextItem = nextRows.find(row => row.feature_value === featureValue);
                const longItem = longRows.find(row => row.feature_value === featureValue);
                const nextShare = Number(nextItem?.demand_share_pct || 0);
                const longShare = Number(longItem?.demand_share_pct || 0);
                return {
                    feature_value: featureValue,
                    next_year_share_pct: nextShare,
                    long_term_share_pct: longShare,
                    delta_share_pct: Number((longShare - nextShare).toFixed(2))
                };
            }).sort((a, b) => b.delta_share_pct - a.delta_share_pct)[0] || null;

            return {
                feature_type: featureType,
                feature_label: featureTypeLabels[featureType],
                dominant_next_year: dominantNext,
                dominant_long_term: dominantLong,
                strongest_gainer: strongestGainer
            };
        }).filter(item => item.dominant_next_year || item.dominant_long_term);

        const overviewRow = summaryRes.rows[0] || {};
        const supportDrivenUnits = topProvinceRows
            .filter(row => row.has_support)
            .reduce((sum, row) => sum + Number(row.next_12m_units || 0), 0);

        return {
            run,
            overview: {
                row_count: Number(overviewRow.row_count || 0),
                province_count: Number(overviewRow.province_count || 0),
                brand_count: Number(overviewRow.brand_count || 0),
                next_12m_units: Number(overviewRow.next_12m_units || 0),
                total_horizon_units: Number(overviewRow.total_horizon_units || 0),
                avg_monthly_units: Number(overviewRow.avg_monthly_units || 0),
                latest_period: latestPeriodIso,
                next_12m_end: next12EndIso,
                scenario_code: run.scenario_code,
                forecast_horizon_months: Number(run.forecast_horizon_months || 0),
                model_family: run.model_family,
                reference_mode: Boolean(snapshot.reference_mode),
                commodity_signal_ratio: Number(snapshot.commodity_signal_ratio || 0),
                support_driven_units: Number(supportDrivenUnits.toFixed(2)),
                support_driven_share_pct: Number(overviewRow.next_12m_units || 0) > 0
                    ? Number(((supportDrivenUnits / Number(overviewRow.next_12m_units || 0)) * 100).toFixed(2))
                    : 0
            },
            monthly_curve: monthlyCurve,
            top_provinces: topProvinceRows.slice(0, 10),
            feature_outlook: featureOutlookRows,
            feature_shift: featureShift
        };
    }

    app.get('/api/meta/future-intelligence-readiness', authMiddleware, async (req, res) => {
        try {
            const layerDefinitions = [
                { key: 'intelligence_sources', label: 'Resmi kaynak katalogu', table: 'intelligence_sources', seeded: true },
                { key: 'support_programs', label: 'Destek programlari', table: 'support_programs', seeded: true },
                { key: 'support_application_windows', label: 'Cagri pencereleri', table: 'support_application_windows', seeded: true },
                { key: 'support_program_coverage', label: 'Destek kapsama katmani', table: 'support_program_coverage', seeded: true },
                { key: 'weather_data', label: 'Hava veri serisi', table: 'weather_data', seeded: false },
                { key: 'climate_analysis', label: 'Iklim gecmis serisi', table: 'climate_analysis', seeded: false },
                { key: 'soil_data', label: 'Toprak veri katmani', table: 'soil_data', seeded: false },
                { key: 'crop_data', label: 'Urun deseni katmani', table: 'crop_data', seeded: false },
                { key: 'commodity_prices', label: 'Emtia fiyat serisi', table: 'commodity_prices', seeded: false },
                { key: 'climate_projection_scenarios', label: 'Iklim projeksiyon senaryolari', table: 'climate_projection_scenarios', seeded: false },
                { key: 'province_risk_signals', label: 'Il risk sinyalleri', table: 'province_risk_signals', seeded: false },
                { key: 'forecast_runs', label: 'Forecast kosulari', table: 'forecast_runs', seeded: false },
                { key: 'forecast_feature_store', label: 'Forecast feature store', table: 'forecast_feature_store', seeded: false },
                { key: 'forecast_outputs', label: 'Forecast ciktilari', table: 'forecast_outputs', seeded: false },
                { key: 'model_feature_demand', label: 'Ozellik talep modeli ciktilari', table: 'model_feature_demand', seeded: false }
            ];

            const counts = await Promise.all(layerDefinitions.map(async layer => {
                const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${layer.table}`);
                return {
                    ...layer,
                    row_count: parseInt(result.rows[0]?.count || 0, 10)
                };
            }));

            const latestForecastRun = await pool.query(`
                SELECT forecast_key, model_family, scope_level, scenario_code, run_status, created_at
                FROM forecast_runs
                ORDER BY created_at DESC
                LIMIT 1
            `);

            const layers = counts.map(layer => ({
                key: layer.key,
                label: layer.label,
                row_count: layer.row_count,
                status: layer.row_count > 0 ? (layer.seeded ? 'seeded' : 'ready') : 'empty',
                note: layer.row_count > 0
                    ? (layer.seeded ? 'Cekirdek metadata ya da coverage tabakasi hazir.' : 'Gercek veri ile tahmin motorunu beslemeye hazir.')
                    : 'Bu katman henuz import veya model kosusu bekliyor.'
            }));

            res.json({
                generated_at: new Date().toISOString(),
                summary: {
                    total_layers: layers.length,
                    non_empty_layers: layers.filter(item => item.row_count > 0).length,
                    empty_layers: layers.filter(item => item.row_count === 0).length,
                    ready_layers: layers.filter(item => item.status === 'ready').length,
                    seeded_layers: layers.filter(item => item.status === 'seeded').length
                },
                latest_forecast_run: latestForecastRun.rows[0] || null,
                layers
            });
        } catch (err) {
            res.status(500).json({ error: 'Future intelligence readiness okunamadi', detail: errMsg(err) });
        }
    });

    app.get('/api/meta/future-intelligence-catalog', authMiddleware, async (req, res) => {
        try {
            const { commodityCatalog = [] } = require('./database/future-intelligence-seed');

            const [sourcesRes, programsRes] = await Promise.all([
                pool.query(`
                    SELECT
                        id, source_code, title, publisher, source_type, geography_scope,
                        official_url, publication_date, notes
                    FROM intelligence_sources
                    WHERE is_active = true
                    ORDER BY
                        CASE source_type
                            WHEN 'support' THEN 1
                            WHEN 'statistics' THEN 2
                            WHEN 'census' THEN 3
                            WHEN 'climate' THEN 4
                            WHEN 'strategy' THEN 5
                            ELSE 6
                        END,
                        title
                `),
                pool.query(`
                    SELECT
                        sp.id,
                        sp.program_code,
                        sp.authority_name,
                        sp.program_name,
                        sp.program_type,
                        sp.status,
                        sp.support_scope,
                        sp.support_mode,
                        sp.currency,
                        sp.min_grant_rate_pct,
                        sp.max_grant_rate_pct,
                        sp.official_url,
                        sp.notes,
                        src.title AS source_title,
                        COALESCE(cov.coverage_count, 0) AS coverage_count,
                        COALESCE(win.window_count, 0) AS window_count
                    FROM support_programs sp
                    LEFT JOIN intelligence_sources src ON sp.source_id = src.id
                    LEFT JOIN (
                        SELECT program_id, COUNT(*)::int AS coverage_count
                        FROM support_program_coverage
                        GROUP BY program_id
                    ) cov ON cov.program_id = sp.id
                    LEFT JOIN (
                        SELECT program_id, COUNT(*)::int AS window_count
                        FROM support_application_windows
                        GROUP BY program_id
                    ) win ON win.program_id = sp.id
                    ORDER BY sp.program_name
                `)
            ]);

            res.json({
                generated_at: new Date().toISOString(),
                sources: sourcesRes.rows,
                support_programs: programsRes.rows,
                tracked_commodities: commodityCatalog
            });
        } catch (err) {
            res.status(500).json({ error: 'Future intelligence catalog okunamadi', detail: errMsg(err) });
        }
    });

    app.post('/api/admin/future-intelligence/seed-reference-data', authMiddleware, adminOnly, async (req, res) => {
        try {
            await ensureReferenceMarketSignalsSeeded({ replaceExisting: Boolean(req.body?.replace_existing) });
            const [commodityCount, climateCount] = await Promise.all([
                pool.query(`SELECT COUNT(*)::int AS count FROM commodity_prices WHERE market_scope = 'reference-index'`),
                pool.query(`SELECT COUNT(*)::int AS count FROM climate_projection_scenarios WHERE scenario_code IN ('reference_base', 'reference_stress')`)
            ]);

            res.json({
                ok: true,
                commodity_reference_rows: parseInt(commodityCount.rows[0]?.count || 0, 10),
                climate_reference_rows: parseInt(climateCount.rows[0]?.count || 0, 10)
            });
        } catch (err) {
            res.status(500).json({ error: 'Reference market data seed edilemedi', detail: errMsg(err) });
        }
    });

    app.post('/api/admin/forecast/run-baseline', authMiddleware, adminOnly, async (req, res) => {
        try {
            const result = await runBaselineForecast({
                horizonMonths: req.body?.horizon_months || 24,
                scenarioCode: req.body?.scenario_code || 'base',
                createdByUserId: req.user.id
            });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Baseline forecast kosulamadi', detail: errMsg(err) });
        }
    });

    app.get('/api/forecast/runs', authMiddleware, requireFeature('ai_forecast'), async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    id,
                    forecast_key,
                    model_family,
                    scope_level,
                    scenario_code,
                    forecast_horizon_months,
                    run_status,
                    metrics_json,
                    feature_snapshot_json,
                    created_at
                FROM forecast_runs
                ORDER BY created_at DESC
                LIMIT 20
            `);
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Forecast run listesi okunamadi', detail: errMsg(err) });
        }
    });

    app.get('/api/forecast/latest', authMiddleware, requireFeature('ai_forecast'), async (req, res) => {
        try {
            const requestedRunId = req.query.forecast_run_id ? parseInt(req.query.forecast_run_id, 10) : null;
            const requestedProvinceId = req.query.province_id ? parseInt(req.query.province_id, 10) : null;
            const requestedBrandId = req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;

            const runRes = requestedRunId
                ? await pool.query(`
                    SELECT *
                    FROM forecast_runs
                    WHERE id = $1
                    LIMIT 1
                `, [requestedRunId])
                : await pool.query(`
                    SELECT *
                    FROM forecast_runs
                    WHERE run_status = 'completed'
                    ORDER BY created_at DESC
                    LIMIT 1
                `);

            const run = runRes.rows[0];
            if (!run) {
                return res.json({ run: null, summary: null, outputs: [], feature_demand: [] });
            }

            const params = [run.id];
            let filterSql = '';
            if (requestedProvinceId) {
                params.push(requestedProvinceId);
                filterSql += ` AND fo.province_id = $${params.length}`;
            }
            if (requestedBrandId) {
                params.push(requestedBrandId);
                filterSql += ` AND fo.brand_id = $${params.length}`;
            }

            const [summaryRes, outputsRes, featureDemandRes] = await Promise.all([
                pool.query(`
                    SELECT
                        COUNT(*)::int AS row_count,
                        SUM(predicted_units)::decimal AS predicted_units_total,
                        AVG(predicted_units)::decimal AS avg_monthly_units
                    FROM forecast_outputs fo
                    WHERE fo.forecast_run_id = $1
                    ${filterSql}
                `, params),
                pool.query(`
                    SELECT
                        fo.province_id,
                        p.name AS province_name,
                        fo.brand_id,
                        b.name AS brand_name,
                        SUM(fo.predicted_units)::decimal AS predicted_units_total,
                        AVG(fo.predicted_units)::decimal AS avg_monthly_units
                    FROM forecast_outputs fo
                    LEFT JOIN provinces p ON p.id = fo.province_id
                    LEFT JOIN brands b ON b.id = fo.brand_id
                    WHERE fo.forecast_run_id = $1
                    ${filterSql}
                    GROUP BY fo.province_id, p.name, fo.brand_id, b.name
                    ORDER BY predicted_units_total DESC
                    LIMIT 25
                `, params),
                pool.query(`
                    SELECT
                        mfd.province_id,
                        p.name AS province_name,
                        mfd.brand_id,
                        b.name AS brand_name,
                        mfd.horizon_year,
                        mfd.feature_type,
                        mfd.feature_value,
                        mfd.demand_share_pct,
                        mfd.demand_units
                    FROM model_feature_demand mfd
                    LEFT JOIN provinces p ON p.id = mfd.province_id
                    LEFT JOIN brands b ON b.id = mfd.brand_id
                    WHERE mfd.forecast_run_id = $1
                      AND COALESCE(mfd.demand_units, 0) > 0
                    ${requestedProvinceId ? ` AND mfd.province_id = ${requestedProvinceId}` : ''}
                    ${requestedBrandId ? ` AND mfd.brand_id = ${requestedBrandId}` : ''}
                    ORDER BY mfd.horizon_year, mfd.feature_type, mfd.demand_units DESC, mfd.demand_share_pct DESC
                    LIMIT 80
                `, [run.id])
            ]);

            res.json({
                run,
                summary: summaryRes.rows[0] || null,
                outputs: outputsRes.rows,
                feature_demand: featureDemandRes.rows
            });
        } catch (err) {
            res.status(500).json({ error: 'Latest forecast okunamadi', detail: errMsg(err) });
        }
    });

    app.get('/api/forecast/executive', authMiddleware, requireFeature('ai_forecast'), requireAiQuota(), async (req, res) => {
        try {
            const payload = await getForecastExecutiveView({
                forecastRunId: req.query.forecast_run_id,
                provinceId: req.query.province_id,
                brandId: req.query.brand_id
            });
            res.json(payload);
        } catch (err) {
            res.status(500).json({ error: 'Forecast executive ozeti okunamadi', detail: errMsg(err) });
        }
    });

    // initDB (server.js) seed fonksiyonlarını kullanır.
    return { ensureBrandPortalSeeded, ensureFutureIntelligenceSeeded, ensureReferenceMarketSignalsSeeded };
};
