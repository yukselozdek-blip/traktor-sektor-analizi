'use strict';
// Veritabanı başlangıç/seed akışı (initDB), server.js'ten olduğu gibi taşındı.

module.exports = function createInitDB(ctx) {
    const { bcrypt, crypto, pool, ensureBrandPortalSeeded, ensureFutureIntelligenceSeeded, ensureReferenceMarketSignalsSeeded, ensureProvincesSeeded, SUPERUSER_EMAILS_LIST } = ctx;

    async function initDB() {
        try {
            // Yapısal şema: database/migrations/*.sql (idempotent, schema_migrations ile izlenir).
            // Hata olursa yüksek sesle loglanır, sonraki migration'lar uygulanmaz; sunucu yine de başlar.
            try {
                await require('../database/migrate').runMigrations(pool, { logger: console });
            } catch (migErr) {
                console.error('❌ DB MIGRATION HATASI (sunucu yine de başlatılıyor):', migErr.message);
            }

            // Temel verileri seed et (markalar, iller, planlar, admin)
            const { brands, provinces, subscriptionPlans } = require('../database/seed-data');
            const bcryptSeedLib = require('bcryptjs');
            const [brandCheck, provinceCheck, planCheck] = await Promise.all([
                pool.query('SELECT COUNT(*)::int AS count FROM brands'),
                pool.query('SELECT COUNT(*)::int AS count FROM provinces'),
                pool.query('SELECT COUNT(*)::int AS count FROM subscription_plans')
            ]);

            const brandCount = parseInt(brandCheck.rows[0]?.count || 0, 10);
            const provinceCount = parseInt(provinceCheck.rows[0]?.count || 0, 10);
            const planCount = parseInt(planCheck.rows[0]?.count || 0, 10);

            if (brandCount === 0 || provinceCount < provinces.length || planCount === 0) {
                console.log('🌱 Temel referans verileri kontrol edilip tamamlanıyor...');

                if (brandCount === 0) {
                    for (const brand of brands) {
                        await pool.query(`INSERT INTO brands (name, slug, primary_color, secondary_color, accent_color, text_color, country_of_origin, parent_company) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                            [brand.name, brand.slug, brand.primary_color, brand.secondary_color, brand.accent_color, brand.text_color, brand.country_of_origin, brand.parent_company]);
                    }
                }

                if (provinceCount < provinces.length) {
                    await ensureProvincesSeeded();
                }

                if (planCount === 0) {
                    for (const plan of subscriptionPlans) {
                        await pool.query(`INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, features, max_users, has_ai_insights, has_competitor_analysis, has_weather_data, has_export) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
                            [plan.name, plan.slug, plan.price_monthly, plan.price_yearly, plan.features, plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export]);
                    }
                }

                // NOT: admin@traktorsektoranalizi.com / admin2024 demo hesabı kaldırıldı.
                // Tek yönetici (superuser) yukselozdek@gmail.com — Google OAuth veya kayıt akışı üzerinden giriş yapar.
                console.log('✅ Temel referans verileri tamamlandı (demo admin hesabı oluşturulmadı)');
            }

            // ============================================
            // BILLING SCHEMA MIGRATION + PLAN UPSERT (her boot'ta idempotent)
            // 3 plan: Starter / Growth / Enterprise + kapsam limit, AI sorgu sayacı,
            // WhatsApp telefon yönetimi, makbuz/e-fatura tablosu
            // ============================================
            try {
                // Superuser: yukselozdek@gmail.com — her zaman admin + is_superuser
                await pool.query(`
                    UPDATE users SET role = 'admin', is_superuser = true
                    WHERE LOWER(email) = ANY($1::text[]) AND email_verified = true
                `, [SUPERUSER_EMAILS_LIST]);

                // Eski plan slug'larını gizle (basic/pro/elite + temel/profesyonel/kurumsal)
                await pool.query(`UPDATE subscription_plans SET is_active = false WHERE slug IN ('temel', 'profesyonel', 'kurumsal', 'basic', 'pro', 'elite')`);

                // 3 yeni plan (Starter/Growth/Enterprise) upsert
                for (const plan of subscriptionPlans) {
                    await pool.query(`
                        INSERT INTO subscription_plans
                            (name, slug, tier_rank, description, currency, price_monthly, price_yearly,
                             features, feature_keys, plan_limits, max_users,
                             has_ai_insights, has_competitor_analysis, has_weather_data, has_export, is_active)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,true)
                        ON CONFLICT (slug) DO UPDATE SET
                            name = EXCLUDED.name,
                            tier_rank = EXCLUDED.tier_rank,
                            description = EXCLUDED.description,
                            currency = EXCLUDED.currency,
                            price_monthly = EXCLUDED.price_monthly,
                            price_yearly = EXCLUDED.price_yearly,
                            features = EXCLUDED.features,
                            feature_keys = EXCLUDED.feature_keys,
                            plan_limits = EXCLUDED.plan_limits,
                            max_users = EXCLUDED.max_users,
                            has_ai_insights = EXCLUDED.has_ai_insights,
                            has_competitor_analysis = EXCLUDED.has_competitor_analysis,
                            has_weather_data = EXCLUDED.has_weather_data,
                            has_export = EXCLUDED.has_export,
                            is_active = true
                    `, [
                        plan.name, plan.slug, plan.tier_rank, plan.description, plan.currency,
                        plan.price_monthly, plan.price_yearly, plan.features, plan.feature_keys, plan.plan_limits,
                        plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export
                    ]);
                }
                console.log('✅ Billing şeması ve 3 plan (Starter/Growth/Enterprise) güncellendi');
            } catch (billingMigErr) {
                console.warn('⚠️ Billing migration uyarısı:', billingMigErr.message);
            }

            // ============================================
            // ESKİ DEMO ADMİN HESABI TEMİZLİĞİ
            // admin@traktorsektoranalizi.com / admin2024 kaldırıldı.
            // Sistem yetkisi yalnızca yukselozdek@gmail.com (superuser) üzerinden verilir;
            // diğer üyeler login.html üzerinden Google OAuth veya 4-adımlı kayıt akışıyla katılır.
            // FK kısıtları nedeniyle silmek yerine deaktif et + şifreyi rastgele yap → giriş yapamaz.
            // ============================================
            try {
                const oldAdmin = await pool.query(`SELECT id FROM users WHERE email = 'admin@traktorsektoranalizi.com'`);
                if (oldAdmin.rows.length > 0) {
                    const oldId = oldAdmin.rows[0].id;
                    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
                    await pool.query(
                        `UPDATE users
                           SET email = $1,
                               password_hash = $2,
                               is_active = false,
                               role = 'inactive',
                               is_superuser = false,
                               full_name = 'Devre Dışı Demo Hesap',
                               email_verified = false,
                               failed_login_count = 999,
                               locked_until = NOW() + INTERVAL '100 years'
                         WHERE id = $3`,
                        [`disabled_${oldId}@invalid.local`, randomHash, oldId]
                    );
                    console.log(`🧹 Eski demo admin hesabı (id=${oldId}) deaktif edildi ve giriş kilitlendi`);
                }
            } catch (cleanupErr) {
                console.warn('⚠️ Demo admin temizliği uyarısı:', cleanupErr.message);
            }

            // ============================================
            // MARKA İSİMLERİ NORMALİZASYONU
            // ============================================
            const brandNameMap = {
                'CASE IH': 'CASE',
                'DEUTZ-FAHR': 'DEUTZ',
                'KIOTI': 'KİOTİ'
            };
            for (const [oldName, newName] of Object.entries(brandNameMap)) {
                const oldBrand = (await pool.query('SELECT id FROM brands WHERE name = $1', [oldName])).rows[0];
                const newBrand = (await pool.query('SELECT id FROM brands WHERE name = $1', [newName])).rows[0];
                if (oldBrand && newBrand && oldBrand.id !== newBrand.id) {
                    // Her iki isim de var: tüm FK referanslarını yeni markaya taşı, eski kaydı sil
                    await pool.query('UPDATE sales_data SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                    await pool.query('UPDATE tractor_models SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                    await pool.query('UPDATE users SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]);
                    // Diğer olası FK referansları
                    try { await pool.query('UPDATE user_favorites SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]); } catch(e) {}
                    try { await pool.query('UPDATE brand_settings SET brand_id = $1 WHERE brand_id = $2', [newBrand.id, oldBrand.id]); } catch(e) {}
                    await pool.query('DELETE FROM brands WHERE id = $1', [oldBrand.id]);
                    console.log(`🔄 Marka birleştirildi: ${oldName} (id:${oldBrand.id}) → ${newName} (id:${newBrand.id})`);
                } else if (oldBrand && !newBrand) {
                    // Sadece eski isim var: yeniden adlandır
                    await pool.query('UPDATE brands SET name = $1 WHERE id = $2', [newName, oldBrand.id]);
                    console.log(`🔄 Marka ismi güncellendi: ${oldName} → ${newName}`);
                }
            }

            await ensureBrandPortalSeeded();
            console.log('Brand portal profilleri hazirlandi');
            await ensureFutureIntelligenceSeeded();
            console.log('Future intelligence kaynak ve destek cekirdegi hazirlandi');
            await ensureReferenceMarketSignalsSeeded();
            console.log('Reference market ve iklim sinyal katmani hazirlandi');

            // ============================================
            // TEKNİK VERİ → TRACTOR_MODELS OTOMATİK SYNC
            // Anayasa Kuralı: marka + tuik_model_adi eşleştirmesi
            // ============================================
            try {
                // Marka eşleştirme haritası (teknik_veri marka adı → brands tablosu adı)
                const brandAliasMap = {
                    'CASE IH': 'CASE', 'DEUTZ-FAHR': 'DEUTZ', 'KIOTI': 'KİOTİ'
                };

                // teknik_veri'den tüm modelleri al
                const teknikRows = await pool.query(`
                    SELECT tv.marka, tv.tuik_model_adi, tv.model, tv.fiyat_usd,
                           tv.motor_gucu_hp, tv.cekis_tipi, tv.koruma, tv.vites_sayisi, tv.kullanim_alani
                    FROM teknik_veri tv
                    WHERE tv.tuik_model_adi IS NOT NULL AND tv.tuik_model_adi != ''
                `);

                let syncCount = 0;
                let insertCount = 0;

                for (const tv of teknikRows.rows) {
                    const teknikMarka = tv.marka.trim().toUpperCase();
                    const resolvedBrand = brandAliasMap[teknikMarka] || teknikMarka;

                    // Brand ID bul
                    const brandRes = await pool.query('SELECT id FROM brands WHERE UPPER(name) = $1', [resolvedBrand]);
                    if (brandRes.rows.length === 0) continue;
                    const brandId = brandRes.rows[0].id;

                    const tuikModelAdi = tv.tuik_model_adi.trim();
                    const hp = parseFloat(tv.motor_gucu_hp) || null;
                    const hpRange = hp ? (hp <= 39 ? '1-39' : hp <= 49 ? '40-49' : hp <= 54 ? '50-54' : hp <= 59 ? '55-59' : hp <= 69 ? '60-69' : hp <= 79 ? '70-79' : hp <= 89 ? '80-89' : hp <= 99 ? '90-99' : hp <= 109 ? '100-109' : hp <= 119 ? '110-119' : '120+') : null;
                    const cabinType = String(tv.koruma || '').toLowerCase().includes('kabin') ? 'kabinli' : 'rollbar';
                    const driveType = String(tv.cekis_tipi || '') || '4WD';
                    const gearConfig = String(tv.vites_sayisi || '') || '12+12';
                    const category = String(tv.kullanim_alani || '').toLowerCase().includes('bahçe') ? 'bahce' : 'tarla';
                    const priceUsd = parseFloat(tv.fiyat_usd) || null;

                    // tractor_models'da tuik_model_adi ile eşleşen kayıt var mı?
                    const existing = await pool.query(
                        'SELECT id FROM tractor_models WHERE brand_id = $1 AND UPPER(model_name) = UPPER($2)',
                        [brandId, tuikModelAdi]
                    );

                    if (existing.rows.length > 0) {
                        // Varsa: price_usd ve teknik bilgileri güncelle
                        if (priceUsd && priceUsd > 0) {
                            await pool.query(
                                `UPDATE tractor_models SET price_usd = $1, horsepower = COALESCE($2, horsepower),
                                 hp_range = COALESCE($3, hp_range), cabin_type = $4, drive_type = $5,
                                 gear_config = $6, category = $7
                                 WHERE id = $8`,
                                [priceUsd, hp, hpRange, cabinType, driveType, gearConfig, category, existing.rows[0].id]
                            );
                            syncCount++;
                        }
                    } else {
                        if (!hp) continue;

                        // Yoksa: teknik_veri'den yeni model oluştur
                        await pool.query(
                            `INSERT INTO tractor_models (brand_id, model_name, horsepower, hp_range, category,
                             cabin_type, drive_type, gear_config, price_usd, is_current_model)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
                             ON CONFLICT DO NOTHING`,
                            [brandId, tuikModelAdi, hp, hpRange, category, cabinType, driveType, gearConfig, priceUsd]
                        );
                        insertCount++;
                    }
                }

                console.log(`💰 teknik_veri sync: ${syncCount} model güncellendi, ${insertCount} yeni model eklendi`);

                // Eski hardcoded modellere de numara bazlı fiyat eşleştirmeyi dene
                // (teknik_veri'den gelmeyen ama seed'den gelen modeller için)
                const numericSync = await pool.query(`
                    UPDATE tractor_models tm
                    SET price_usd = subq.fiyat_usd
                    FROM (
                        SELECT DISTINCT ON (tm2.id)
                               tm2.id as tm_id, tv2.fiyat_usd
                        FROM tractor_models tm2
                        JOIN brands b2 ON tm2.brand_id = b2.id
                        JOIN teknik_veri tv2 ON (UPPER(tv2.marka) = UPPER(b2.name)
                            OR (UPPER(tv2.marka) = 'CASE IH' AND UPPER(b2.name) = 'CASE')
                            OR (UPPER(tv2.marka) = 'DEUTZ-FAHR' AND UPPER(b2.name) = 'DEUTZ')
                            OR (UPPER(tv2.marka) = 'KIOTI' AND UPPER(b2.name) = 'KİOTİ'))
                        WHERE (tm2.price_usd IS NULL OR tm2.price_usd = 0)
                          AND tm2.is_current_model = true
                          AND tv2.fiyat_usd IS NOT NULL AND tv2.fiyat_usd > 0
                          AND LENGTH(regexp_replace(tm2.model_name, '[^0-9]', '', 'g')) >= 3
                          AND tv2.tuik_model_adi ILIKE '%' || regexp_replace(tm2.model_name, '[^0-9]', '', 'g') || '%'
                        ORDER BY tm2.id, tv2.fiyat_usd
                    ) subq
                    WHERE tm.id = subq.tm_id
                `);
                if (numericSync.rowCount > 0) console.log(`💰 ${numericSync.rowCount} eski model numarayla eşleştirildi`);

                // Hala price_usd boş olan modelleri logla
                const unsyncedModels = await pool.query(`
                    SELECT b.name as brand_name, tm.model_name
                    FROM tractor_models tm
                    JOIN brands b ON tm.brand_id = b.id
                    WHERE tm.is_current_model = true AND (tm.price_usd IS NULL OR tm.price_usd = 0)
                    ORDER BY b.name, tm.model_name
                    LIMIT 30
                `);
                if (unsyncedModels.rows.length > 0) {
                    console.log(`⚠️ price_usd boş olan modeller (${unsyncedModels.rows.length}):`);
                    unsyncedModels.rows.forEach(r => console.log(`   ${r.brand_name} / ${r.model_name}`));
                }

                console.log('✅ USD fiyat senkronizasyonu tamamlandı');
            } catch (priceErr) {
                console.error('USD fiyat senkronizasyon hatası:', priceErr.message);
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

    return initDB;
};
