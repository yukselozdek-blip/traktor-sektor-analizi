'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isSafeSql } = require('../src/lib/sql-guard');

describe('isSafeSql', () => {
    it('allows simple SELECTs on allowed tables', () => {
        assert.equal(isSafeSql('SELECT brand_name, SUM(quantity) FROM sales_view GROUP BY brand_name ORDER BY 2 DESC LIMIT 10'), true);
        assert.equal(isSafeSql('SELECT * FROM sales_view LIMIT 5;'), true);
        assert.equal(isSafeSql("SELECT * FROM sales_view WHERE brand_name = 'John Deere' LIMIT 5"), true);
    });

    it('blocks write/DDL statements', () => {
        for (const q of ['DROP TABLE sales_data', 'DELETE FROM sales_data', "UPDATE sales_data SET quantity = 0",
            'INSERT INTO brands(name) VALUES (1)', 'TRUNCATE sales_data']) {
            assert.equal(isSafeSql(q), false, q);
        }
    });

    it('blocks multiple statements and comments', () => {
        assert.equal(isSafeSql('SELECT 1; DROP TABLE users'), false);
        assert.equal(isSafeSql('SELECT 1 FROM sales_view -- x'), false);
        assert.equal(isSafeSql('SELECT 1 /* x */ FROM sales_view'), false);
    });

    it('blocks sensitive tables, system schemas and dangerous functions', () => {
        for (const q of ['SELECT * FROM users', 'SELECT pg_sleep(10)', 'SELECT * FROM information_schema.tables',
            'SELECT * FROM pg_catalog.pg_tables', 'SELECT pg_read_file(1)', "SELECT set_config('a','b',false)",
            'SELECT * FROM sales_view s JOIN users u ON true']) {
            assert.equal(isSafeSql(q), false, q);
        }
    });

    it('rejects non-strings and empty input', () => {
        assert.equal(isSafeSql(null), false);
        assert.equal(isSafeSql('  '), false);
    });

    it('denetim bulgusu: fonksiyonla tablo okuma ve parantezli birleşim atlatmaları engellenir', () => {
        for (const q of [
            "SELECT query_to_xml('select email,password_hash from users',true,false,'')",
            "SELECT table_to_xml('users',true,false,'')",
            "SELECT database_to_xml(true,true,'')",
            'SELECT * FROM (whatsapp_phones CROSS JOIN brands b)',
            'SELECT * FROM (subscription_plans)',
            "SELECT repeat('a',1000000000)",
            'SELECT current_schema()',
            "SELECT regexp_replace(name,'a','b') FROM brands",
            'SELECT * FROM brands CROSS JOIN provinces',
            'SELECT 1 FROM brands a JOIN brands b ON true JOIN brands c ON true JOIN brands d ON true JOIN brands e ON true JOIN brands f ON true JOIN brands g ON true JOIN brands h ON true',
            "SELECT array_agg(name) FROM brands",
        ]) {
            assert.equal(isSafeSql(q), false, q);
        }
    });

    it('meşru analiz sorguları (pencere, tarih, cast, alt sorgu) hâlâ geçer', () => {
        for (const q of [
            'SELECT brand_name, SUM(quantity) AS total, ROUND(100.0 * SUM(quantity) / NULLIF(SUM(SUM(quantity)) OVER (), 0), 1) AS pay FROM sales_view WHERE year = 2025 GROUP BY brand_name ORDER BY total DESC LIMIT 10',
            'SELECT year, month, SUM(quantity) FROM sales_view GROUP BY 1,2 ORDER BY 1,2',
            "SELECT EXTRACT(YEAR FROM CURRENT_DATE) AS y, UPPER(brand_name) FROM brands",
            "SELECT brand_name, quantity::numeric(12,2), CAST(year AS varchar(4)) FROM sales_view LIMIT 5",
            'SELECT x.* FROM (SELECT brand_name, SUM(quantity) q FROM sales_view GROUP BY 1) x WHERE x.q > 10',
            'WITH t AS (SELECT brand_name, SUM(quantity) q FROM sales_view GROUP BY 1) SELECT * FROM t ORDER BY q DESC',
            "SELECT brand_name, ROW_NUMBER() OVER (PARTITION BY year ORDER BY quantity DESC) rn FROM sales_view",
            "SELECT COALESCE(b.name, 'x'), TRANSLATE(UPPER(b.name), 'İ', 'I') FROM brands b LEFT JOIN provinces p ON p.id = b.id",
            "SELECT * FROM sales_view WHERE brand_name IN ('A','B') AND (year = 2024 OR year = 2025)",
        ]) {
            assert.equal(isSafeSql(q), true, q);
        }
    });
    it('virgüllü (örtük) birleşimler sınırlıdır: Kartezyen çarpım DoS\'u', () => {
        for (const q of [
            'select * from sales_view a, sales_view b, sales_view c, sales_view d, sales_view e, sales_view f, sales_view g',
            'SELECT COUNT(*) FROM sales_view, brands, provinces, tuik_veri',
        ]) assert.equal(isSafeSql(q), false, q);
        for (const q of [
            'SELECT COUNT(*) FROM sales_view, brands, provinces',
            'SELECT COUNT(*) FROM sales_view s, brands b WHERE s.brand_id = b.id',
        ]) assert.equal(isSafeSql(q), true, q);
    });
});
