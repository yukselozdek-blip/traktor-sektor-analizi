const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { brands, provinces, subscriptionPlans } = require('./seed-data');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://traktor:traktor2024secure@localhost:5432/traktorsektordb'
});

async function seed() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        console.log('🌱 Seeding başlatılıyor...');

        // 1. Markaları ekle
        console.log('📌 Markalar ekleniyor...');
        for (const brand of brands) {
            await client.query(`
                INSERT INTO brands (name, slug, primary_color, secondary_color, accent_color, text_color, country_of_origin, parent_company)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (slug) DO NOTHING
            `, [brand.name, brand.slug, brand.primary_color, brand.secondary_color, brand.accent_color, brand.text_color, brand.country_of_origin, brand.parent_company]);
        }
        console.log(`  ✅ ${brands.length} marka eklendi`);

        // 2. İlleri ekle
        console.log('📌 İller ekleniyor...');
        for (const prov of provinces) {
            await client.query(`
                INSERT INTO provinces (name, plate_code, region, latitude, longitude, population)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (plate_code) DO NOTHING
            `, [prov.name, prov.plate_code, prov.region, prov.lat, prov.lng, prov.pop]);
        }
        console.log(`  ✅ ${provinces.length} il eklendi`);

        // 3. Abonelik planları ekle
        console.log('📌 Abonelik planları ekleniyor...');
        for (const plan of subscriptionPlans) {
            await client.query(`
                INSERT INTO subscription_plans (name, slug, price_monthly, price_yearly, features, max_users, has_ai_insights, has_competitor_analysis, has_weather_data, has_export)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (slug) DO NOTHING
            `, [plan.name, plan.slug, plan.price_monthly, plan.price_yearly, plan.features, plan.max_users, plan.has_ai_insights, plan.has_competitor_analysis, plan.has_weather_data, plan.has_export]);
        }
        console.log(`  ✅ ${subscriptionPlans.length} abonelik planı eklendi`);

        // 4. (Kaldırıldı) admin@traktorsektoranalizi.com / admin2024 demo hesabı.
        //    Tek superuser yukselozdek@gmail.com — sisteme login.html üzerinden Google OAuth
        //    veya 4-adımlı kayıt akışıyla giriş yapar. Demo şifre seed'i artık kullanılmıyor.
        console.log('📌 Demo admin hesabı kaldırıldı; superuser yukselozdek@gmail.com login akışı üzerinden tanımlanır.');

        // 5. Her marka için demo kullanıcı oluştur
        console.log('📌 Marka demo kullanıcıları oluşturuluyor...');
        const demoHash = await bcrypt.hash('demo2024', 10);
        const brandRows = await client.query('SELECT id, name, slug FROM brands ORDER BY id');
        for (const brand of brandRows.rows) {
            await client.query(`
                INSERT INTO users (email, password_hash, full_name, role, brand_id, company_name)
                VALUES ($1, $2, $3, 'brand_user', $4, $5)
                ON CONFLICT (email) DO NOTHING
            `, [
                `demo@${brand.slug}.com`,
                demoHash,
                `${brand.name} Demo Kullanıcı`,
                brand.id,
                `${brand.name} Yetkili Bayii`
            ]);
        }
        console.log(`  ✅ ${brandRows.rows.length} demo kullanıcı eklendi`);

        // 6. Örnek satış verileri oluştur (2020-2025)
        console.log('📌 Örnek satış verileri oluşturuluyor...');
        const provRows = await client.query('SELECT id FROM provinces ORDER BY id');
        const categories = ['tarla', 'bahce'];
        const cabinTypes = ['kabinli', 'rollbar'];
        const driveTypes = ['2WD', '4WD'];
        const hpRanges = ['0-50', '51-75', '76-100', '101-150', '150+'];

        let salesCount = 0;
        for (const brand of brandRows.rows) {
            // Her marka için bazı illerde satış verisi oluştur
            const selectedProvinces = provRows.rows
                .sort(() => Math.random() - 0.5)
                .slice(0, 30 + Math.floor(Math.random() * 40));

            for (const prov of selectedProvinces) {
                for (let year = 2020; year <= 2025; year++) {
                    for (let month = 1; month <= 12; month++) {
                        if (year === 2025 && month > 3) continue; // 2025 sadece ilk 3 ay

                        const cat = categories[Math.floor(Math.random() * categories.length)];
                        const cabin = cabinTypes[Math.floor(Math.random() * cabinTypes.length)];
                        const drive = driveTypes[Math.floor(Math.random() * driveTypes.length)];
                        const hp = hpRanges[Math.floor(Math.random() * hpRanges.length)];
                        const qty = Math.floor(Math.random() * 15) + 1;

                        await client.query(`
                            INSERT INTO sales_data (brand_id, province_id, year, month, quantity, category, cabin_type, drive_type, hp_range)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                            ON CONFLICT DO NOTHING
                        `, [brand.id, prov.id, year, month, qty, cat, cabin, drive, hp]);
                        salesCount++;
                    }
                }
            }
        }
        console.log(`  ✅ ~${salesCount} satış kaydı oluşturuldu`);

        await client.query('COMMIT');
        console.log('\n🎉 Seed işlemi başarıyla tamamlandı!');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Seed hatası:', err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch(err => {
    console.error(err);
    process.exit(1);
});
