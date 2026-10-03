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
});
