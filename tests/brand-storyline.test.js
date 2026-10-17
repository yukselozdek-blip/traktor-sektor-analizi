'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildStorylineCards,
    fmtPctTR,
    fmtNumTR,
    fmtSignedNumTR,
    fmtPpTR
} = require('../src/lib/brand-storyline');

const base = {
    outperformancePp: 0,
    marketYoy: 0,
    brandYoy: 0,
    shareValuePct: 10,
    shareDeltaPp: 0,
    prevYear: 2025,
    topCategory: { label: 'Tarla', share_pct: 74.6 },
    topDrive: { label: '4WD', share_pct: 71.1 },
    topHp: { label: '60-69' },
    top3SharePct: 37.6,
    topRegionGrowth: { region_name: 'Konya', yoy_pct: 12.3 },
    weakestRegionGrowth: { region_name: 'Edirne', yoy_pct: -20 }
};

const card = (input, index) => buildStorylineCards({ ...base, ...input })[index];

test('fmtPctTR formats Turkish percentages', () => {
    assert.equal(fmtPctTR(33.58), '%33,58');
    assert.equal(fmtPctTR(-30.5, { signed: true }), '%-30,5');
    assert.equal(fmtPctTR(34.6, { signed: true }), '+%34,6');
    assert.equal(fmtPctTR(34.6), '%34,6');
    assert.equal(fmtPctTR(74.6, { decimals: 1 }), '%74,6');
    assert.equal(fmtPctTR(null), '-');
    assert.equal(fmtPctTR('abc'), '-');
});

test('fmtNumTR and signed helpers use decimal comma', () => {
    assert.equal(fmtNumTR(78.2, 1), '78,2');
    assert.equal(fmtNumTR(116.9, 1), '116,9');
    assert.equal(fmtNumTR(1234.5, 1), '1.234,5');
    assert.equal(fmtNumTR(undefined, 1), '-');
    assert.equal(fmtSignedNumTR(-4.37, 2), '-4,37');
    assert.equal(fmtSignedNumTR(1.2, 1), '+1,2');
    assert.equal(fmtPpTR(-4.37), '-4,37 puan');
    assert.equal(fmtPpTR(null), '-');
});

test('card 1: outperforming a shrinking market', () => {
    const c = card({ outperformancePp: 4.4, marketYoy: -30.5, brandYoy: -26.1 }, 0);
    assert.equal(c.eyebrow, 'Pazar direnci');
    assert.equal(c.title, 'Daralan pazarda göreli olarak daha sağlam kaldı');
    assert.equal(c.value, '+4,4 puan');
    assert.equal(c.note, 'Pazar %-30,5 daralırken marka %-26,1 hareket etti.');
});

test('card 1: outperforming a growing market', () => {
    const c = card({ outperformancePp: 2, marketYoy: 10, brandYoy: 12 }, 0);
    assert.equal(c.title, 'Büyüyen pazarın önünde ilerledi');
    assert.equal(c.note, 'Pazar +%10 büyürken marka +%12 hareket etti.');
});

test('card 1: underperforming a shrinking market (NEW HOLLAND case)', () => {
    const c = card({ outperformancePp: -8, marketYoy: -30.5, brandYoy: -38.5 }, 0);
    assert.equal(c.eyebrow, 'Pazara göre performans');
    assert.equal(c.title, 'Daralan pazarda pazarın gerisinde kaldı');
    assert.equal(c.value, '-8 puan');
    assert.equal(c.note, 'Pazar %-30,5 daralırken marka %-38,5 hareket etti.');
});

test('card 1: underperforming a growing market', () => {
    const c = card({ outperformancePp: -3.2, marketYoy: 5, brandYoy: 1.8 }, 0);
    assert.equal(c.title, 'Büyüyen pazarda geride kaldı');
    assert.equal(c.note, 'Pazar +%5 büyürken marka +%1,8 hareket etti.');
});

test('card 1: missing comparison falls back', () => {
    const c = card({ outperformancePp: null, marketYoy: null, brandYoy: null }, 0);
    assert.equal(c.value, '-');
    assert.equal(c.note, 'Karşılaştırma için önceki dönem verisi bekleniyor.');
    assert.ok(!/daralan|büyüyen/i.test(c.title));
});

test('card 2: share gained, lost, unchanged, unknown', () => {
    const up = card({ shareDeltaPp: 1.25, shareValuePct: 20 }, 1);
    assert.equal(up.eyebrow, 'Pay geri kazanımı');
    assert.equal(up.title, 'Tescil payı aynı dönemde yükseldi');
    assert.equal(up.value, '%20');
    assert.equal(up.note, '2025 aynı döneme göre +1,25 puanlık hareket.');

    const down = card({ shareDeltaPp: -4.37, shareValuePct: 33.58 }, 1);
    assert.equal(down.eyebrow, 'Pay kaybı');
    assert.equal(down.title, 'Tescil payı aynı dönemde geriledi');
    assert.equal(down.value, '%33,58');
    assert.equal(down.note, '2025 aynı döneme göre -4,37 puanlık hareket.');

    const flat = card({ shareDeltaPp: 0 }, 1);
    assert.equal(flat.eyebrow, 'Pay dengesi');
    assert.equal(flat.title, 'Tescil payı korunuyor');

    const unknown = card({ shareDeltaPp: null, shareValuePct: null }, 1);
    assert.equal(unknown.value, '-');
    assert.equal(unknown.note, 'Pay hareketi hesaplanamadı.');
    assert.ok(!/yükseldi|geriledi/.test(unknown.title));
});

test('card 3: portfolio axis depends on dominant category', () => {
    const tarla = card({}, 2);
    assert.equal(tarla.title, 'Tarla gücü portföyün omurgasını oluşturuyor');
    assert.equal(tarla.value, '%74,6 tarla');
    assert.equal(tarla.note, '%71,1 4WD çekiş profili, 60-69 lider segment.');

    const bahce = card({ topCategory: { label: 'Bahçe', share_pct: 62 } }, 2);
    assert.equal(bahce.title, 'Bahçe segmenti portföyün omurgasını oluşturuyor');
    assert.equal(bahce.value, '%62 bahçe');

    const bahceAscii = card({ topCategory: { label: 'bahce', share_pct: 61 } }, 2);
    assert.equal(bahceAscii.title, 'Bahçe segmenti portföyün omurgasını oluşturuyor');

    const lowShare = card({ topCategory: { label: 'Tarla', share_pct: 55 } }, 2);
    assert.equal(lowShare.title, 'Tarla ve bahçe arasında dengeli bir portföy');
});

test('card 3: missing category keeps structure with dash values', () => {
    const c = card({ topCategory: null }, 2);
    assert.equal(c.value, '-');
    assert.equal(c.note, '%71,1 4WD çekiş profili, 60-69 lider segment.');
});

test('card 4: concentration vs spread and region growth note', () => {
    const concentrated = card({ top3SharePct: 52.3 }, 3);
    assert.equal(concentrated.title, 'Satışlar birkaç ilde yoğunlaşıyor');
    assert.equal(concentrated.value, 'Top 3 %52,3');
    assert.equal(concentrated.note, 'Konya +%12,3 ile öne çıkıyor, zayıf halka Edirne.');

    const spread = card({ top3SharePct: 30 }, 3);
    assert.equal(spread.title, 'Dağılım tek ile sıkışmayan yaygın bir saha izi üretiyor');

    const declining = card({
        topRegionGrowth: { region_name: 'Ege', yoy_pct: -5.5 },
        weakestRegionGrowth: null
    }, 3);
    assert.equal(declining.note, 'Ege %-5,5 ile en az gerileyen bölge.');

    const none = card({ topRegionGrowth: null, weakestRegionGrowth: null }, 3);
    assert.equal(none.note, 'Bölgesel momentum hesaplanamadı.');
});

test('buildStorylineCards returns four cards with the expected shape', () => {
    const cards = buildStorylineCards(base);
    assert.equal(cards.length, 4);
    for (const c of cards) {
        assert.deepEqual(Object.keys(c).sort(), ['eyebrow', 'note', 'title', 'value']);
    }
});
