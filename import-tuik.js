const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

// TUIK_EXCEL_PATH: yalnızca testler/operasyon için sunucu ortamından geçersiz kılma (kullanıcı girdisi değildir)
const EXCEL_PATH = process.env.TUIK_EXCEL_PATH || path.join(__dirname, 'data', 'TuikRapor.xlsx');
const BATCH_SIZE = 1000;

const TUIK_COLUMNS = ['Marka', 'TuikModelAdi', 'TescilYil', 'TescilAy', 'SehirKodu', 'SehirAdi',
    'ModelYili', 'MotorHacmiCC', 'Renk', 'SatisAdet'];
const TEKNIK_COLUMNS = ['Marka', 'Model', 'TuikModelAdi', 'FiyatUSD', 'EmisyonSeviyesi', 'CekisTipi',
    'Koruma', 'VitesSayisi', 'Mensei', 'KullanimAlani', 'MotorMarka', 'SilindirSayisi',
    'MotorGucuHP', 'MotorDevriRPM', 'MaksimumTork', 'DepoHacmiLT', 'HidrolikKaldirma', 'Agirlik',
    'DingilMesafesi', 'Uzunluk', 'Yukseklik', 'Genislik', 'ModelYillari'];

// Sayfanın ilk satırındaki (başlık) sütun adlarını döndürür
function readHeaders(sheet) {
    const headers = new Set();
    if (!sheet || !sheet['!ref']) return headers;
    const range = xlsx.utils.decode_range(sheet['!ref']);
    for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[xlsx.utils.encode_cell({ r: range.s.r, c })];
        if (cell && cell.v !== undefined && cell.v !== null) headers.add(String(cell.v).trim());
    }
    return headers;
}

function assertColumns(sheet, name, required) {
    const headers = readHeaders(sheet);
    const missing = required.filter(c => !headers.has(c));
    if (missing.length) {
        throw new Error(`${name} sayfasında zorunlu sütun(lar) eksik: ${missing.join(', ')}`);
    }
}

// Çoklu satır INSERT (unnest ile, parametreli). cols: [{name, type, get(row)}]
async function batchInsert(client, table, cols, rows, extraSql) {
    const names = cols.map(c => c.name).join(', ');
    const unnestArgs = cols.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
    const sql = `INSERT INTO ${table} (${names}) SELECT * FROM unnest(${unnestArgs})${extraSql || ''}`;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        await client.query(sql, cols.map(c => chunk.map(r => {
            const v = c.get(r);
            return v === undefined ? null : v;
        })));
    }
}

async function importExcel(poolOrClient) {
    const started = Date.now();

    // ---- 1. Çalışma kitabını DB'ye dokunmadan oku ve doğrula ----
    if (!fs.existsSync(EXCEL_PATH)) {
        throw new Error(`Excel dosyası bulunamadı: ${EXCEL_PATH}`);
    }

    console.log('📦 Excel dosyası okunuyor...');
    const workbook = xlsx.readFile(EXCEL_PATH);

    const tuikSheet = workbook.Sheets['TuikVeri'];
    const teknikSheet = workbook.Sheets['TeknikVeri'];
    if (!tuikSheet || !teknikSheet) {
        throw new Error('TuikVeri veya TeknikVeri sayfası bulunamadı.');
    }
    assertColumns(tuikSheet, 'TuikVeri', TUIK_COLUMNS);
    assertColumns(teknikSheet, 'TeknikVeri', TEKNIK_COLUMNS);

    const tuikData = xlsx.utils.sheet_to_json(tuikSheet);
    const teknikData = xlsx.utils.sheet_to_json(teknikSheet);

    if (tuikData.length === 0) throw new Error('TuikVeri sayfasında hiç kayıt yok.');
    if (teknikData.length === 0) throw new Error('TeknikVeri sayfasında hiç kayıt yok.');

    console.log(`📊 TuikVeri: ${tuikData.length} kayıt okundu.`);
    console.log(`⚙️ TeknikVeri: ${teknikData.length} kayıt okundu.`);

    // ---- 2. Satırları bellekte hazırla (DB gerekmez) ----
    const teknikRows = teknikData.map(row => ({
        marka: row['Marka'], model: row['Model'], tuikModelAdi: row['TuikModelAdi'],
        fiyatUsd: parseFloat(row['FiyatUSD']) || null, emisyon: row['EmisyonSeviyesi'],
        cekis: row['CekisTipi'], koruma: row['Koruma'], vites: row['VitesSayisi'],
        mensei: row['Mensei'], kullanim: row['KullanimAlani'], motorMarka: row['MotorMarka'],
        silindir: parseInt(row['SilindirSayisi']) || null,
        hp: parseFloat(row['MotorGucuHP']) || null, rpm: parseInt(row['MotorDevriRPM']) || null,
        tork: parseFloat(row['MaksimumTork']) || null, depo: parseFloat(row['DepoHacmiLT']) || null,
        hidrolik: parseFloat(row['HidrolikKaldirma']) || null, agirlik: parseFloat(row['Agirlik']) || null,
        dingil: parseInt(row['DingilMesafesi']) || null, uzunluk: parseInt(row['Uzunluk']) || null,
        yukseklik: parseInt(row['Yukseklik']) || null, genislik: parseInt(row['Genislik']) || null,
        modelYillari: row['ModelYillari']
    }));

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

    // Geçerli TuikVeri satırları
    const tuikRows = [];
    let skippedBadDate = 0;
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
        // Geçersiz ay/yıl (örn. ay=13) veritabanında MAKE_DATE(...) kullanan rotaları ('date field value out of range') 500'e düşürür
        if (tescilAy < 1 || tescilAy > 12 || tescilYil < 1990 || tescilYil > 2100) { skippedBadDate++; continue; }

        tuikRows.push({
            row, tescilYil, tescilAy, satisAdet, marka, sehirAdi, sehirKodu, modelYili, tuikModelAdi
        });
    }
    if (skippedBadDate > 0) console.warn(`⚠️ Geçersiz ay/yıl nedeniyle ${skippedBadDate} TuikVeri satırı atlandı.`);
    if (tuikRows.length === 0) {
        throw new Error('TuikVeri sayfasında geçerli (yıl, ay, adet > 0, marka dolu) satır bulunamadı.');
    }

    // ---- 3. Tek transaction: şema + temizle + yükle + sales_data üret ----
    const ownPool = !poolOrClient;
    const pool = ownPool ? new Pool({ connectionString: process.env.DATABASE_URL }) : poolOrClient;
    const isClient = !ownPool && typeof pool.release === 'function';
    const client = isClient ? pool : await pool.connect();

    try {
        await client.query('BEGIN');
        // Eşzamanlı iki import çalışmasını engelle (transaction bitince kilit kalkar)
        await client.query('SELECT pg_advisory_xact_lock(724001)');

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

        // ALTER TABLE (IF NOT EXISTS olsa bile) ACCESS EXCLUSIVE kilidi alır ve kilit transaction sonuna
        // kadar (tüm içe aktarma boyunca) tutulur: bu sürede TÜM okuma istekleri bekler, bağlantı havuzu
        // dolar ve /api/brands, /api/provinces, /api/sales/* 500 verir. Bu yüzden yalnızca gerçekten
        // gerekliyse çalıştır.
        const hasModelYear = await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sales_data' AND column_name = 'model_year'`);
        if (hasModelYear.rowCount === 0) {
            await client.query(`ALTER TABLE sales_data ADD COLUMN IF NOT EXISTS model_year INTEGER;`);
        }

        // Excel'de aynı ay/marka için birden fazla satır olabileceğinden orijinal davranış:
        // sales_data üzerindeki UNIQUE kısıtlamalarını kaldır (artık transaction içinde;
        // hata olursa geri alınır). Şemada sales_data için UNIQUE kısıtı yoktur.
        await client.query(`
            DO $$ 
            DECLARE 
                r RECORD;
            BEGIN
                FOR r IN (SELECT conname FROM pg_constraint con 
                          JOIN pg_class rel ON rel.oid = con.conrelid 
                          WHERE rel.relname = 'sales_data' AND contype = 'u') 
                LOOP
                    EXECUTE 'ALTER TABLE sales_data DROP CONSTRAINT ' || quote_ident(r.conname);
                END LOOP;
            END $$;
        `);

        console.log('🗑️ Eski veriler temizleniyor (transaction içinde)...');
        // TRUNCATE ACCESS EXCLUSIVE kilit alır ve içe aktarma bitene kadar tüm okumaları bloklar (canlıda
        // dakikalarca 'Sunucu hatası'). DELETE yalnızca satır kilidi alır; okuyucular commit'e kadar eski
        // veriyi görmeye devam eder. Bu tablolara yabancı anahtar yok (CASCADE gereksiz).
        await client.query('DELETE FROM sales_data');
        await client.query('DELETE FROM tuik_veri');
        await client.query('DELETE FROM teknik_veri');

        // TeknikVeri
        console.log('📥 TeknikVeri Excel verileri SQL e yazılıyor...');
        await batchInsert(client, 'teknik_veri', [
            { name: 'marka', type: 'text', get: r => r.marka },
            { name: 'model', type: 'text', get: r => r.model },
            { name: 'tuik_model_adi', type: 'text', get: r => r.tuikModelAdi },
            { name: 'fiyat_usd', type: 'numeric', get: r => r.fiyatUsd },
            { name: 'emisyon_seviyesi', type: 'text', get: r => r.emisyon },
            { name: 'cekis_tipi', type: 'text', get: r => r.cekis },
            { name: 'koruma', type: 'text', get: r => r.koruma },
            { name: 'vites_sayisi', type: 'text', get: r => r.vites },
            { name: 'mensei', type: 'text', get: r => r.mensei },
            { name: 'kullanim_alani', type: 'text', get: r => r.kullanim },
            { name: 'motor_marka', type: 'text', get: r => r.motorMarka },
            { name: 'silindir_sayisi', type: 'integer', get: r => r.silindir },
            { name: 'motor_gucu_hp', type: 'numeric', get: r => r.hp },
            { name: 'motor_devri_rpm', type: 'integer', get: r => r.rpm },
            { name: 'maksimum_tork', type: 'numeric', get: r => r.tork },
            { name: 'depo_hacmi_lt', type: 'numeric', get: r => r.depo },
            { name: 'hidrolik_kaldirma', type: 'numeric', get: r => r.hidrolik },
            { name: 'agirlik', type: 'numeric', get: r => r.agirlik },
            { name: 'dingil_mesafesi', type: 'integer', get: r => r.dingil },
            { name: 'uzunluk', type: 'integer', get: r => r.uzunluk },
            { name: 'yukseklik', type: 'integer', get: r => r.yukseklik },
            { name: 'genislik', type: 'integer', get: r => r.genislik },
            { name: 'model_yillari', type: 'text', get: r => r.modelYillari }
        ], teknikRows);

        // Marka / il önbellekleri
        const brandCache = {};
        const brandsRes = await client.query('SELECT id, name FROM brands');
        brandsRes.rows.forEach(b => { brandCache[b.name.toUpperCase()] = b.id; });

        const provCache = {};
        const provRes = await client.query('SELECT id, name, plate_code FROM provinces');
        provRes.rows.forEach(p => {
            provCache[p.name.toUpperCase()] = p.id;
            provCache[p.plate_code] = p.id;
        });

        console.log('📥 TuikVeri (Satışlar) SQL e işleniyor ve Dashboard için eşleştiriliyor...');
        const unmappedBrands = new Set();
        const salesBucket = {};

        for (const t of tuikRows) {
            const { row, tescilYil, tescilAy, satisAdet, marka, sehirAdi, sehirKodu, modelYili, tuikModelAdi } = t;

            let brandId = brandCache[marka.toUpperCase()];
            if (!brandId) {
                const slug = marka.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const insertB = await client.query(`INSERT INTO brands (name, slug) VALUES ($1, $2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [marka, slug]);
                brandId = insertB.rows[0].id;
                brandCache[marka.toUpperCase()] = brandId;
                unmappedBrands.add(marka);
            }

            let provinceId = provCache[sehirAdi.toUpperCase()];
            if (!provinceId && sehirKodu) {
                const pCode = sehirKodu.toString().padStart(2, '0');
                provinceId = provCache[pCode];
            }

            const teknik = teknikMap[tuikModelAdi.toUpperCase()];
            let hpRange = null;
            let cabinType = 'rollbar';
            let driveType = '4WD';
            let gearConfig = '12+12';
            let category = 'tarla';

            if (teknik) {
                hpRange = getHpRange(parseFloat(teknik['MotorGucuHP']));
                cabinType = String(teknik['Koruma'] || '').toLowerCase().includes('kabin') ? 'kabinli' : 'rollbar';
                driveType = String(teknik['CekisTipi'] || '') || '4WD';
                gearConfig = String(teknik['VitesSayisi'] || '') || '12+12';
                category = String(teknik['KullanimAlani'] || '').toLowerCase().includes('bahçe') ? 'bahce' : 'tarla';
            }

            const bucketKey = `${brandId}-${provinceId || 0}-${tescilYil}-${tescilAy}-${category}-${cabinType}-${driveType}-${hpRange || 'N/A'}-${gearConfig}-${modelYili || 0}`;

            if (!salesBucket[bucketKey]) {
                salesBucket[bucketKey] = {
                    brandId, provinceId, year: tescilYil, month: tescilAy,
                    quantity: 0, category, cabinType, driveType, hpRange, gearConfig, modelYear: modelYili
                };
            }
            salesBucket[bucketKey].quantity += satisAdet;
            t.row = row;
        }

        // tuik_veri ham veri
        await batchInsert(client, 'tuik_veri', [
            { name: 'marka', type: 'text', get: t => t.marka },
            { name: 'tuik_model_adi', type: 'text', get: t => t.tuikModelAdi },
            { name: 'tescil_yil', type: 'integer', get: t => t.tescilYil },
            { name: 'tescil_ay', type: 'integer', get: t => t.tescilAy },
            { name: 'sehir_kodu', type: 'integer', get: t => t.sehirKodu || null },
            { name: 'sehir_adi', type: 'text', get: t => t.sehirAdi },
            { name: 'model_yili', type: 'integer', get: t => t.modelYili || null },
            { name: 'motor_hacmi_cc', type: 'text', get: t => String(t.row['MotorHacmiCC'] || '') },
            { name: 'renk', type: 'text', get: t => String(t.row['Renk'] || '') },
            { name: 'satis_adet', type: 'integer', get: t => t.satisAdet }
        ], tuikRows);

        const salesRows = Object.values(salesBucket);
        console.log(`📥 Toplam ${salesRows.length} farklı veri grubu sales_data'ya aktarılıyor...`);

        const salesCols = [
            { name: 'brand_id', type: 'integer', get: s => s.brandId },
            { name: 'province_id', type: 'integer', get: s => s.provinceId || null },
            { name: 'year', type: 'integer', get: s => s.year },
            { name: 'month', type: 'integer', get: s => s.month },
            { name: 'quantity', type: 'integer', get: s => s.quantity },
            { name: 'category', type: 'text', get: s => s.category },
            { name: 'cabin_type', type: 'text', get: s => s.cabinType },
            { name: 'drive_type', type: 'text', get: s => s.driveType },
            { name: 'hp_range', type: 'text', get: s => s.hpRange },
            { name: 'gear_config', type: 'text', get: s => s.gearConfig },
            { name: 'model_year', type: 'integer', get: s => s.modelYear || null }
        ];
        // data_source sabit değer
        const names = salesCols.map(c => c.name).join(', ');
        const unnestArgs = salesCols.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
        const salesSql = `INSERT INTO sales_data (${names}, data_source) SELECT u.*, 'TuikRapor_Excel' FROM unnest(${unnestArgs}) AS u`;
        for (let i = 0; i < salesRows.length; i += BATCH_SIZE) {
            const chunk = salesRows.slice(i, i + BATCH_SIZE);
            await client.query(salesSql, salesCols.map(c => chunk.map(s => c.get(s))));
        }

        await client.query('COMMIT');
        // Toplu yükleme sonrası planlayıcı istatistiklerini tazele (kilit almaz; hata içe aktarmayı bozmaz)
        try { await client.query('ANALYZE tuik_veri'); await client.query('ANALYZE teknik_veri'); await client.query('ANALYZE sales_data'); }
        catch (e) { console.warn('ANALYZE atlandı:', e.message); }

        const result = {
            tuik: tuikRows.length,
            teknik: teknikRows.length,
            sales: salesRows.length,
            ms: Date.now() - started
        };
        console.log('✅ BÜTÜN EXCEL VERİLERİ BAŞARIYLA YÜKLENDİ!');
        console.log(`📊 tuik_veri: ${result.tuik}, teknik_veri: ${result.teknik}, sales_data: ${result.sales} kayıt (${result.ms} ms).`);
        if (unmappedBrands.size > 0) console.log('⚠️ Yeni Tanimlanan Markalar:', Array.from(unmappedBrands));

        // Geriye dönük uyumluluk: eski dönüş alanları
        return Object.assign({ success: true, count: result.sales }, result);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* bağlantı kopmuş olabilir */ }
        console.error('HATA OLUŞTU (işlem geri alındı, eski veriler korundu):', e.message);
        throw e;
    } finally {
        if (!isClient) client.release();
        if (ownPool) await pool.end();
    }
}

module.exports = { importExcel };

if (require.main === module) {
    importExcel()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Import başarısız:', err.message);
            process.exit(1);
        });
}
