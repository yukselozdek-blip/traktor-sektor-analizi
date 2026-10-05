'use strict';
// Yalnızca tanımsız değişken taraması: dosya bölme sırasında kaybolan yardımcıları yakalar.
const globals = require('globals');
module.exports = [
    { ignores: ['public/**', 'node_modules/**', 'tests/**', 'scripts/**', 'n8n-workflows/**', 'railway-services/**'] },
    {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
        rules: { 'no-undef': 'error' }
    }
];
