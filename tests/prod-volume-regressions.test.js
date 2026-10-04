'use strict';
// Canlı (gerçek veri hacmi) hatalarının küçük fixture'larla tekrarlanabilir regresyon testleri:
//  - Uzun süreli tablo kilidi (içe aktarma TRUNCATE/ALTER) sırasında açılış listeleri (/api/brands, /api/provinces) düşmemeli
//  - İçe aktarma okuyucuları bloklayan ACCESS EXCLUSIVE kilit tutmamalı
//  - Geçersiz tescil ayı (13) model-bölge analizini 500'e düşürmemeli
//  - shared-memo: eşzamanlı çağrı paylaşımı, hata önbelleğe alınmaması, staleOnError
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const xlsx = require('xlsx');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');
const { memoShared } = require('../src/lib/shared-memo');

describe('shared-memo', () => {
    it('eşzamanlı çağrılar tek hesaplamayı paylaşır; TTL içinde önbellekten döner', async () => {
        let calls = 0;
        const loader = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return calls; };
        const [a, b] = await Promise.all([memoShared('t1', 1000, loader), memoShared('t1', 1000, loader)]);
        assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
        assert.equal(await memoShared('t1', 1000, loader), 1);
        assert.equal(calls, 1);
    });
    it('hata önbelleğe alınmaz; staleOnError süresi geçmiş son iyi değeri döndürür', async () => {
        let fail = false, calls = 0;
        const loader = async () => { calls++; if (fail) throw new Error('db kilitli'); return 'iyi'; };
        assert.equal(await memoShared('t2', 20, loader, { staleOnError: true }), 'iyi');
        await new Promise(r => setTimeout(r, 40));
        fail = true;
        assert.equal(await memoShared('t2', 20, loader, { staleOnError: true }), 'iyi', 'eski değer sunulmalı');
        // staleOnError yoksa hata yayılır ve başarısızlık saklanmaz
        await assert.rejects(memoShared('t3', 20, loader), /db kilitli/);
        fail = false;
        assert.equal(await memoShared('t3', 20, loader), 'iyi');
        assert.ok(calls >= 4);
    });
    it('staleAfterMs: yükleyici takılırsa beklemeden eski değer döner', async () => {
        let slow = false;
        const loader = async () => { if (slow) await new Promise(r => setTimeout(r, 400)); return slow ? 'yeni' : 'eski'; };
        assert.equal(await memoShared('t4', 10, loader, { staleOnError: true, staleAfterMs: 50 }), 'eski');
        await new Promise(r => setTimeout(r, 30));
        slow = true;
        const t = Date.now();
        assert.equal(await memoShared('t4', 10, loader, { staleOnError: true, staleAfterMs: 50 }), 'eski');
        assert.ok(Date.now() - t < 300, 'yükleyici beklenmemeli');
    });
});

describe('canlı veri hacmi regresyonları (DB)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin;
    before(async () => {
        s = await startServer({ env: { PG_POOL_MAX: '3', PG_CONNECT_TIMEOUT_MS: '2500', REF_CACHE_TTL_MS: '100', RESPONSE_CACHE_TTL_MS: '0', MODEL_REGION_CATALOG_TTL_MS: '0' } });
        admin = await s.createUserWithToken({ role: 'admin' });
        await s.pool.query(`
            INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet)
            SELECT b.name, 'REG MODEL', 2025, m.month, p.id, p.name, 2025, 4
            FROM (SELECT name FROM brands ORDER BY id LIMIT 2) b, (SELECT id, name FROM provinces ORDER BY id LIMIT 5) p, generate_series(1, 4) m(month)`);
    });
    after(async () => { if (s) await s.stop(); });

    it('tuik_veri uzun süre kilitliyken (içe aktarma) marka/il açılış listeleri 200 döner ve havuz tükense de düşmez', async () => {
        // Isıt: son iyi değer önbelleğe girsin (ve kullanıcı kimlik durumu önbelleğe alınsın)
        const b0 = await s.api('GET', '/api/brands', { token: admin.token });
        const p0 = await s.api('GET', '/api/provinces?t=1', { token: admin.token });
        assert.equal(b0.status, 200, b0.text); assert.equal(p0.status, 200, p0.text);
        await new Promise(r => setTimeout(r, 150)); // REF TTL (100 ms) dolsun

        const locker = await s.pool.connect();
        const heavy = [];
        try {
            await locker.query('BEGIN');
            await locker.query('LOCK TABLE tuik_veri IN ACCESS EXCLUSIVE MODE'); // TRUNCATE/ALTER TABLE'ın tuttuğu kilit
            // Sayfa açılışındaki ağır istekler kilitte bekleyip bağlantı havuzunu (max 3) doldurur
            for (let i = 0; i < 5; i++) heavy.push(s.api('GET', `/api/sales/model-region?x=${i}`, { token: admin.token }));
            await new Promise(r => setTimeout(r, 400));
            const t = Date.now();
            const [b, p] = await Promise.all([
                s.api('GET', '/api/brands', { token: admin.token }),
                s.api('GET', '/api/provinces?t=2', { token: admin.token })
            ]);
            assert.equal(b.status, 200, 'brands: ' + b.text);
            assert.equal(p.status, 200, 'provinces: ' + p.text);
            assert.ok(Array.isArray(b.json) && b.json.length > 0);
            assert.ok(Array.isArray(p.json) && p.json.length >= 81);
            assert.ok(Date.now() - t < 2400, 'bağlantı zaman aşımı (2,5 sn) beklenmemeli: ' + (Date.now() - t) + ' ms');
        } finally {
            await locker.query('ROLLBACK').catch(() => {});
            locker.release();
            await Promise.all(heavy);
        }
    });

    it('geçersiz tescil ayı (13) model-bölge analizini 500\'e düşürmez (MAKE_DATE: date field value out of range)', async () => {
        await s.pool.query(`INSERT INTO tuik_veri (marka, tuik_model_adi, tescil_yil, tescil_ay, sehir_kodu, sehir_adi, model_yili, satis_adet)
                            SELECT name, 'REG MODEL', 2025, 13, 1, 'Adana', 2025, 9 FROM brands ORDER BY id LIMIT 1`);
        try {
            const r = await s.api('GET', '/api/sales/model-region', { token: admin.token });
            assert.equal(r.status, 200, r.text);
            assert.ok(r.json.focus, 'odak verisi üretilmeli');
            assert.equal(r.json.meta.max_month <= 12, true);
        } finally {
            await s.pool.query('DELETE FROM tuik_veri WHERE tescil_ay = 13');
        }
    });

    it('içe aktarma (importExcel) okuyucuları bloklayan ACCESS EXCLUSIVE kilit tutmaz', async () => {
        const tuik = [['Marka', 'TuikModelAdi', 'TescilYil', 'TescilAy', 'SehirKodu', 'SehirAdi', 'ModelYili', 'MotorHacmiCC', 'Renk', 'SatisAdet']];
        const brandRes = await s.pool.query('SELECT name FROM brands ORDER BY id LIMIT 1');
        const bname = brandRes.rows[0].name;
        for (let m = 1; m <= 6; m++) tuik.push([bname, 'IMP 100', 2025, m, 1, 'Adana', 2025, '3000', 'Kirmizi', 3 + m]);
        tuik.push([bname, 'BOZUK AY', 2025, 13, 1, 'Adana', 2025, '3000', 'Kirmizi', 5]); // atlanmalı
        const teknikHeader = ['Marka', 'Model', 'TuikModelAdi', 'FiyatUSD', 'EmisyonSeviyesi', 'CekisTipi', 'Koruma', 'VitesSayisi', 'Mensei', 'KullanimAlani', 'MotorMarka', 'SilindirSayisi',
            'MotorGucuHP', 'MotorDevriRPM', 'MaksimumTork', 'DepoHacmiLT', 'HidrolikKaldirma', 'Agirlik', 'DingilMesafesi', 'Uzunluk', 'Yukseklik', 'Genislik', 'ModelYillari'];
        const teknik = [teknikHeader, [bname, 'Imp 100', 'IMP 100', 20000, 'Stage 3', '4WD', 'Kabin', '12+12', 'TR', 'Tarla', 'X', 4, 100, 2200, 400, 100, 3000, 4000, 2300, 4000, 2500, 2000, '2025']];
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(tuik), 'TuikVeri');
        xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(teknik), 'TeknikVeri');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tuik-')), 'mini.xlsx');
        xlsx.writeFile(wb, file);

        // import-tuik.js EXCEL_PATH'i modül yüklenirken okur: ayrı süreçte çalıştır, ana süreçten kilidi gözle
        const { spawn } = require('node:child_process');
        const probe = `
          const { Pool } = require('pg');
          const { importExcel } = require('./import-tuik.js');
          (async () => {
            const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
            const client = await pool.connect();
            const orig = client.query.bind(client);
            let probed = null;
            client.query = async (sql, ...rest) => {
              // Veri yükleme aşamasında (DELETE sonrası, COMMIT öncesi) bağımsız bir bağlantıdan okumayı dene
              if (typeof sql === 'string' && sql.includes('INSERT INTO tuik_veri') && probed === null) {
                const other = await pool.connect();
                try {
                  await other.query('BEGIN');
                  await other.query("SET LOCAL lock_timeout = '1500ms'");
                  await other.query('SELECT COUNT(*) FROM sales_data');
                  await other.query('SELECT COUNT(*) FROM tuik_veri');
                  await other.query('SELECT COUNT(*) FROM teknik_veri');
                  await other.query('COMMIT');
                  probed = 'ok';
                } catch (e) { probed = 'BLOKE: ' + e.message; try { await other.query('ROLLBACK'); } catch (_) {} }
                finally { other.release(); }
              }
              return orig(sql, ...rest);
            };
            const r = await importExcel(client);
            console.log('RESULT ' + JSON.stringify({ probed, tuik: r.tuik }));
            client.release(); await pool.end();
          })().catch(e => { console.log('ERR ' + e.message); process.exit(1); });`;
        const out = await new Promise((resolve, reject) => {
            const c = spawn(process.execPath, ['-e', probe], {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, DATABASE_URL: s.pool.options.connectionString, TUIK_EXCEL_PATH: file }
            });
            let buf = '';
            c.stdout.on('data', d => { buf += d; }); c.stderr.on('data', d => { buf += d; });
            c.on('exit', () => resolve(buf)); c.on('error', reject);
            setTimeout(() => { c.kill(); reject(new Error('import zaman aşımı:\n' + buf)); }, 60000).unref();
        });
        const m = /RESULT (.*)/.exec(out);
        assert.ok(m, 'import çıktısı beklenmedi:\n' + out.slice(-1500));
        const res = JSON.parse(m[1]);
        assert.equal(res.probed, 'ok', 'okuma isteği içe aktarma sırasında bloklandı: ' + res.probed);
        assert.equal(res.tuik, 6, 'geçersiz ay satırı atlanmalı');
        const cnt = await s.pool.query(`SELECT COUNT(*)::int AS n FROM tuik_veri WHERE tescil_ay = 13`);
        assert.equal(cnt.rows[0].n, 0);
    });
});
