'use strict';
// Marka hub'ındaki "executiveKpis" ve "storylineCards" metinleri.
// Anlatı, verinin yönüne göre seçilir: pazar daralıyorsa "daralan pazar" dili,
// pay düşüyorsa "pay kaybı" dili kullanılır. Saf fonksiyonlar; DB erişimi yok.

const toNum = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

// Türkçe ondalık (virgül) ile sayı: fmtNumTR(78.2, 1) -> "78,2"
function fmtNumTR(n, decimals = 0) {
    const v = toNum(n);
    if (v === null) return '-';
    return new Intl.NumberFormat('tr-TR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals
    }).format(v);
}

// Türkçe yüzde: fmtPctTR(33.58) -> "%33,58", fmtPctTR(-30.5, {signed:true}) -> "%-30,5",
// fmtPctTR(34.6, {signed:true}) -> "+%34,6". Pozitif işaret yüzde işaretinden önce gelir,
// negatif işaret yüzde işaretinden sonra (kullanıcı kopyası örnekleriyle birebir).
function fmtPctTR(n, { signed = false, decimals = 2 } = {}) {
    const v = toNum(n);
    if (v === null) return '-';
    const plus = signed && v > 0 ? '+' : '';
    const minus = v < 0 ? '-' : '';
    return `${plus}%${minus}${fmtNumTR(Math.abs(v), decimals)}`;
}

// İşaretli sayı: fmtSignedNumTR(-4.37, 2) -> "-4,37", fmtSignedNumTR(1.2, 1) -> "+1,2"
function fmtSignedNumTR(n, decimals = 2) {
    const v = toNum(n);
    if (v === null) return '-';
    const plus = v > 0 ? '+' : '';
    return `${plus}${fmtNumTR(v, decimals)}`;
}

// Puan farkı: fmtPpTR(-4.37) -> "-4,37 puan"
function fmtPpTR(n, decimals = 2) {
    const v = toNum(n);
    if (v === null) return '-';
    return `${fmtSignedNumTR(v, decimals)} puan`;
}

function buildPerformanceCard(input) {
    const { outperformancePp, marketYoy, brandYoy } = input;
    const outperf = toNum(outperformancePp);
    const market = toNum(marketYoy);
    const brand = toNum(brandYoy);

    if (outperf === null || market === null || brand === null) {
        return {
            eyebrow: 'Pazara göre performans',
            title: 'Pazara göre karşılaştırma hesaplanamadı',
            value: '-',
            note: 'Karşılaştırma için önceki dönem verisi bekleniyor.'
        };
    }

    let title;
    if (outperf >= 0 && market < 0) title = 'Daralan pazarda göreli olarak daha sağlam kaldı';
    else if (outperf >= 0) title = 'Büyüyen pazarın önünde ilerledi';
    else if (market < 0) title = 'Daralan pazarda pazarın gerisinde kaldı';
    else title = 'Büyüyen pazarda geride kaldı';

    return {
        eyebrow: outperf >= 0 ? 'Pazar direnci' : 'Pazara göre performans',
        title,
        value: fmtPpTR(outperf, 2),
        note: `Pazar ${fmtPctTR(market, { signed: true })} ${market < 0 ? 'daralırken' : 'büyürken'} marka ${fmtPctTR(brand, { signed: true })} hareket etti.`
    };
}

function buildShareCard(input) {
    const shareValue = fmtPctTR(input.shareValuePct, { decimals: 2 });
    const delta = toNum(input.shareDeltaPp);
    const prevYear = input.prevYear;

    if (delta === null) {
        return {
            eyebrow: 'Pay hareketi',
            title: 'Pay karşılaştırması hesaplanamadı',
            value: shareValue,
            note: 'Pay hareketi hesaplanamadı.'
        };
    }

    let eyebrow;
    let title;
    if (delta > 0) {
        eyebrow = 'Pay geri kazanımı';
        title = 'Tescil payı aynı dönemde yükseldi';
    } else if (delta < 0) {
        eyebrow = 'Pay kaybı';
        title = 'Tescil payı aynı dönemde geriledi';
    } else {
        eyebrow = 'Pay dengesi';
        title = 'Tescil payı korunuyor';
    }

    return {
        eyebrow,
        title,
        value: shareValue,
        note: `${prevYear} aynı döneme göre ${fmtSignedNumTR(delta, 2)} puanlık hareket.`
    };
}

function buildPortfolioCard(input) {
    const { topCategory, topDrive, topHp } = input;
    const eyebrow = 'Portföy ekseni';

    if (!topCategory) {
        return {
            eyebrow,
            title: 'Portföy kırılımı hesaplanamadı',
            value: '-',
            note: `${topDrive ? `${fmtPctTR(topDrive.share_pct, { decimals: 1 })} ${topDrive.label}` : '-'} çekiş profili, ${topHp ? `${topHp.label} lider segment` : 'HP profili bekleniyor'}.`
        };
    }

    const label = String(topCategory.label || '');
    const share = toNum(topCategory.share_pct) ?? 0;
    let title;
    if (/tarla/i.test(label) && share >= 60) title = 'Tarla gücü portföyün omurgasını oluşturuyor';
    else if (/bahçe|bahce/i.test(label) && share >= 60) title = 'Bahçe segmenti portföyün omurgasını oluşturuyor';
    else title = 'Tarla ve bahçe arasında dengeli bir portföy';

    return {
        eyebrow,
        title,
        value: `${fmtPctTR(share, { decimals: 1 })} ${label.toLocaleLowerCase('tr-TR')}`,
        note: `${topDrive ? `${fmtPctTR(topDrive.share_pct, { decimals: 1 })} ${topDrive.label}` : '-'} çekiş profili, ${topHp ? `${topHp.label} lider segment` : 'HP profili bekleniyor'}.`
    };
}

function buildRegionCard(input) {
    const top3 = toNum(input.top3SharePct) ?? 0;
    const { topRegionGrowth, weakestRegionGrowth } = input;
    const title = top3 >= 50
        ? 'Satışlar birkaç ilde yoğunlaşıyor'
        : 'Dağılım tek ile sıkışmayan yaygın bir saha izi üretiyor';

    let note = 'Bölgesel momentum hesaplanamadı.';
    if (topRegionGrowth) {
        const yoy = toNum(topRegionGrowth.yoy_pct) ?? 0;
        const lead = yoy > 0
            ? `${topRegionGrowth.region_name} ${fmtPctTR(yoy, { signed: true, decimals: 1 })} ile öne çıkıyor`
            : `${topRegionGrowth.region_name} ${fmtPctTR(yoy, { decimals: 1 })} ile en az gerileyen bölge`;
        note = `${lead}${weakestRegionGrowth ? `, zayıf halka ${weakestRegionGrowth.region_name}` : ''}.`;
    }

    return {
        eyebrow: 'Bölgesel denge',
        title,
        value: `Top 3 ${fmtPctTR(top3, { decimals: 1 })}`,
        note
    };
}

// input: { outperformancePp, marketYoy, brandYoy, shareValuePct, shareDeltaPp, prevYear,
//          topCategory, topDrive, topHp, top3SharePct, topRegionGrowth, weakestRegionGrowth }
function buildStorylineCards(input = {}) {
    return [
        buildPerformanceCard(input),
        buildShareCard(input),
        buildPortfolioCard(input),
        buildRegionCard(input)
    ];
}

module.exports = {
    buildStorylineCards,
    fmtPctTR,
    fmtNumTR,
    fmtSignedNumTR,
    fmtPpTR
};
