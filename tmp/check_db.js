const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:SIfQfFovhIovvIofHjCHQCOWJqBfVzUq@junction.proxy.rlwy.net:10839/railway' });

async function check() {
    try {
        console.log('--- USERS TABLOSU SÜTUNLARI ---');
        const res = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        `);
        if (res.rows.length === 0) {
            console.log('HATA: users tablosu bulunamadı!');
        } else {
            res.rows.forEach(c => console.log(`- ${c.column_name} (${c.data_type})`));
        }
    } catch (err) {
        console.error('Hata:', err.message);
    } finally {
        await pool.end();
    }
}
check();
