'use strict';
// isSafeSql is not exported from server.js, so its source (plus the constants it uses)
// is extracted from server.js text and evaluated in a vm sandbox. If server.js is
// refactored so the extraction fails, this test fails loudly (consider lib/sql-guard.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractBlock(startRe) {
    const m = startRe.exec(SRC);
    assert.ok(m, `server.js içinde bulunamadı: ${startRe}`);
    let i = SRC.indexOf('{', m.index), depth = 0, inStr = null, inRe = false;
    // Küme parantezi eşleştirme (string/regex literalleri basitçe atlanır)
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
        if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (c === '/' && /[=(,:!&|?{;]\s*$/.test(SRC.slice(Math.max(0, i - 6), i))) {
            // regex literal
            i++; while (SRC[i] !== '/' || SRC[i - 1] === '\\') { if (SRC[i] === '[') { while (SRC[i] !== ']') { if (SRC[i] === '\\') i++; i++; } } i++; }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return SRC.slice(m.index, i + 1);
    }
    throw new Error('Süslü parantez eşleşmedi');
}
function extractStatement(startRe) {
    const m = startRe.exec(SRC);
    assert.ok(m, `server.js içinde bulunamadı: ${startRe}`);
    const end = SRC.indexOf('\n', SRC.indexOf(';', m.index) );
    return SRC.slice(m.index, end);
}

describe('isSafeSql (extracted from server.js)', () => {
    let isSafeSql;
    before(() => {
        const code = [
            extractStatement(/const SQL_ALLOWED_TABLES = new Set\(\[/).replace(/;[\s\S]*$/, ';'),
            extractStatement(/const SQL_DENY_PATTERN = /),
            extractBlock(/function isSafeSql\(/),
            'this.isSafeSql = isSafeSql;'
        ];
        // SQL_ALLOWED_TABLES yayılmış birden çok satır olabilir: ']);' ile bitişe kadar al
        const a = SRC.indexOf('const SQL_ALLOWED_TABLES');
        code[0] = SRC.slice(a, SRC.indexOf(']);', a) + 3);
        const ctx = {};
        vm.createContext(ctx);
        vm.runInContext(code.join('\n'), ctx);
        isSafeSql = ctx.isSafeSql;
        assert.equal(typeof isSafeSql, 'function');
    });

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
