const xlsx = require('xlsx');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function importExcel() {
    const filePath = './data/TuikRapor.xlsx';
    if (!fs.existsSync(filePath)) {
        console.error('HATA: Excel dosyası bulunamadı:', filePath);
        return { success: false, message: 'Dosya bulunamadı' };
    }

    console.log('📦 Excel dosyası okunuyor...');
    const workbook = xlsx.readFile(filePath);
    
    const tuikSheet = workbook.Sheets['TuikVeri'];
    const teknikSheet = workbook.Sheets['TeknikVeri'];
    
    if (!tuikSheet || !teknikSheet) {
        console.error('HATA: TuikVeri veya TeknikVeri sayfası bulunamadı.');
        process.exit(1);
    }

    const tuikData = xlsx.utils.sheet_to_json(tuikSheet);
    const teknikData = xlsx.utils.sheet_to_json(teknikSheet);

    console.log(`📊 TuikVeri: ${tuikData.length} kayıt okundu.`);
    console.log(`⚙️ TeknikVeri: ${teknikData.length} kayıt okundu.`);

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        console.log('🏗️ Veritabanı tabloları güncelleniyor (tuik_veri, teknik_veri eklenecek)...');
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS tuik_veri (
                id SERIAL PRIMARY KEY,
                marka VARCHAR(200),
                tuik_model_adi VARCHAR(200),
                tescil_yil INTEGER,
                tescil_ay INTEGER,
                sehir_kodu INTEGER,
                sehir_adi VARCHAR(200),
                model_yili INTEGER,
                motor_hacmi_cc VARCHAR(50),
                renk VARCHAR(100),
                satis_adet INTEGER
            );
            
            CREATE TABLE IF NOT EXISTS teknik_veri (
                id SERIAL PRIMARY KEY,
                marka VARCHAR(200),
                model VARCHAR(200),
                tuik_model_adi VARCHAR(200),
                fiyat_usd DECIMAL(12,2),
                emisyon_seviyesi VARCHAR(100),
                cekis_tipi VARCHAR(100),
                koruma VARCHAR(100),
                vites_sayisi VARCHAR(100),
                mensei VARCHAR(100),
                kullanim_alani VARCHAR(100),
                motor_marka VARCHAR(100),
                silindir_sayisi INTEGER,
                motor_gucu_hp DECIMAL(10,2),
                motor_devri_rpm INTEGER,
                maksimum_tork DECIMAL(10,2),
                depo_hacmi_lt DECIMAL(10,2),
                hidrolik_kaldirma DECIMAL(10,2),
                agirlik DECIMAL(10,2),
                dingil_mesafesi INTEGER,
                uzunluk INTEGER,
                yukseklik INTEGER,
                genislik INTEGER,
                model_yillari VARCHAR(200)
            );
        `);

        // Temizle
        await client.query('TRUNCATE tuik_veri RESTART IDENTITY CASCADE');
        await client.query('TRUNCATE teknik_veri RESTART IDENTITY CASCADE');
        
        // sales_data tablosuna model_year ve diğer özellikleri taşıyan sütunlar ekleyelim (TarmakBir uyumluluğu)
        await client.query(`ALTER TABLE sales_data ADD COLUMN IF NOT EXISTS model_year INTEGER;`);

        // Eski rastgele sahte verileri sil
        console.log('🗑️ Eski sahte sales_data verileri temizleniyor...');
        await client.query('DELETE FROM sales_data');

        // 2. TeknikVeri Excel'den DB'ye aktarımı
        console.log('📥 TeknikVeri Excel verileri SQL e yazılıyor...');
        for (const row of teknikData) {
            await client.query(`
                INSERT INTO teknik_veri (
                    marka, model, tuik_model_adi, fiyat_usd, emisyon_seviyesi, cekis_tipi,
                    koruma, vites_sayisi, mensei, kullanim_alani, motor_marka, silindir_sayisi,
                    motor_gucu_hp, motor_devri_rpm, maksimum_tork, depo_hacmi_lt, hidrolik_kaldirma,
                    agirlik, dingil_mesafesi, uzunluk, yukseklik, genislik, model_yillari
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
            `, [
                row['Marka'], row['Model'], row['TuikModelAdi'],
                parseFloat(row['FiyatUSD']) || null, row['EmisyonSeviyesi'], row['CekisTipi'],
                row['Koruma'], row['VitesSayisi'], row['Mensei'], row['KullanimAlani'],
                row['MotorMarka'], parseInt(row['SilindirSayisi']) || null,
                parseFloat(row['MotorGucuHP']) || null, parseInt(row['MotorDevriRPM']) || null,
                parseFloat(row['MaksimumTork']) || null, parseFloat(row['DepoHacmiLT']) || null,
                parseFloat(row['HidrolikKaldirma']) || null, parseFloat(row['Agirlik']) || null,
                parseInt(row['DingilMesafesi']) || null, parseInt(row['Uzunluk']) || null,
                parseInt(row['Yukseklik']) || null, parseInt(row['Genislik']) || null,
                row['ModelYillari']
            ]);
        }

        // 3. Markaları Normalize Et
        let brandCache = {};
        const brandsRes = await client.query('SELECT id, name FROM brands');
        brandsRes.rows.forEach(b => { brandCache[b.name.toUpperCase()] = b.id; });

        // 4. İlleri Normalize Et
        let provCache = {};
        const provRes = await client.query('SELECT id, name, plate_code FROM provinces');
        provRes.rows.forEach(p => { 
            provCache[p.name.toUpperCase()] = p.id; 
            provCache[p.plate_code] = p.id;
        });

        // HP Segment Helper (uygulamada filtreler için)
        const getHpRange = (hp) => {
            if (!hp) return null;
            if (hp <= 39) return '1-39';
            if (hp <= 49) return '40-49';
            if (hp <= 54) return '50-54';
            if (hp <= 59) return '55-59';
            if (hp <= 69) return '60-69';
            if (hp <= 79) return '70-79';
            if (hp <= 89) return '80-89';
            if (hp <= 99) return '90-99';
            if (hp <= 109) return '100-109';
            if (hp <= 119) return '110-119';
            return '120+';
        };

        const teknikMap = {};
        for (const t of teknikData) {
            if (t['TuikModelAdi']) {
                teknikMap[String(t['TuikModelAdi']).toUpperCase()] = t;
            }
        }

        // 5. TuikVeri Insert (Ham Veri + Dashboard Mapping)
        console.log('📥 TuikVeri (Satışlar) SQL e işleniyor ve Dashboard için eşleştiriliyor...');
        
        let processedSales = 0;
        let unmappedBrands = new Set();
        
        // UNIQUE yapısını model_year'ı içerecek şekilde geçici olarak drop edip yeniden yapalım
        await client.query('ALTER TABLE sales_data DROP CONSTRAINT IF EXISTS sales_data_brand_id_province_id_year_month_category_cabi_key');

        for (const row of tuikData) {
            const tescilYil = parseInt(row['TescilYil']);
            const tescilAy = parseInt(row['TescilAy']);
            const satisAdet = parseInt(row['SatisAdet']) || 0;
            const marka = String(row['Marka']).trim();
            const sehirAdi = String(row['SehirAdi']).trim();
            const sehirKodu = parseInt(row['SehirKodu']);
            const modelYili = parseInt(row['ModelYili']);
            const tuikModelAdi = String(row['TuikModelAdi'] || '').trim();

            if (!tescilYil || !tescilAy || isNaN(satisAdet) || satisAdet <= 0 || !marka) continue;

            // 5a. Tam İstenilen Şekilde `tuik_veri` Tablosuna Aktarım
            await client.query(`
                INSERT INTO tuik_veri (
                    marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu,
                    sehir_adi, model_yili, motor_hacmi_cc, renk, satis_adet
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [
                marka, tuikModelAdi, tescilYil, tescilAy, sehirKodu || null,
                sehirAdi, modelYili || null, String(row['MotorHacmiCC'] || ''), String(row['Renk'] || ''), satisAdet
            ]);

            // 5b. Platformun Çalışması İçin `sales_data` Tablosuna Eşleştirme (Mapping)
            let brandId = brandCache[marka.toUpperCase()];
            if (!brandId) {
                const slug = marka.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const insertB = await client.query(`INSERT INTO brands (name, slug) VALUES ($1, $2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [marka, slug]);
                brandId = insertB.rows[0].id;
                brandCache[marka.toUpperCase()] = brandId;
                unmappedBrands.add(marka);
            }

            // Plaka veya Sehir adi ile İlleri bulalım
            let provinceId = provCache[sehirAdi.toUpperCase()];
            if (!provinceId && sehirKodu) {
                let pCode = sehirKodu.toString().padStart(2, '0');
                provinceId = provCache[pCode];
            }

            const teknik = teknikMap[tuikModelAdi.toUpperCase()];
            let hpRange = null;
            let cabinType = null;
            let driveType = null;
            let gearConfig = null;
            let category = null;

            if (teknik) {
                hpRange = getHpRange(parseFloat(teknik['MotorGucuHP']));
                cabinType = String(teknik['Koruma'] || '').toLowerCase().includes('kabin') ? 'kabinli' : 'rollbar';
                driveType = String(teknik['CekisTipi'] || '');
                gearConfig = String(teknik['VitesSayisi'] || '');
                category = String(teknik['KullanimAlani'] || '').toLowerCase().includes('bahçe') ? 'bahce' : 'tarla';
            }

            try {
                // Programın TarmakBir ve diğer sekmelerinin gerçek veri göstermesi için
                await client.query(`
                    INSERT INTO sales_data (
                        brand_id, province_id, year, month, quantity, 
                        category, cabin_type, drive_type, hp_range, gear_config, model_year, data_source
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'TuikRapor_Excel')
                `, [
                    brandId, provinceId || null, tescilYil, tescilAy, satisAdet,
                    category, cabinType, driveType, hpRange, gearConfig, modelYili || null
                ]);
                processedSales++;
            } catch (err) {
                console.error("Sales DB insert error:", err.message);
            }
        }

        await client.query('COMMIT');
        console.log('✅ BÜTÜN EXCEL VERİLERİ BAŞARIYLA YÜKLENDİ!');
        console.log(`📊 Yeni Tablolar (tuik_veri, teknik_veri) birebir istendiği gibi oluşturuldu.`);
        console.log(`📊 Toplam ${processedSales} satış kaydı Dashboard platformunu beslemek için sales_data tablosuna map edildi.`);
        if (unmappedBrands.size > 0) console.log('⚠️ Yeni Tanimlanan Markalar:', Array.from(unmappedBrands));
        
        return { success: true, count: processedSales };
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('HATA OLUŞTU:', e);
        return { success: false, message: e.message };
    } finally {
        client.release();
    }
}

module.exports = { importExcel };
