// ============================================
// TRAKTÖR SEKTÖR ANALİZİ - MAIN APPLICATION
// ============================================

let currentUser = null;
let currentPage = 'dashboard';
let selectedYear = 2025; // Varsayılan: veri bulunan en son yıl
let charts = {};
let allBrands = [];
let allProvinces = [];

// ============================================
// INITIALIZATION
// ============================================
async function init() {
    const token = localStorage.getItem('auth_token');
    if (!token) { window.location.href = '/login.html'; return; }

    try {
        currentUser = await API.me();
        if (!currentUser) { API.logout(); return; }

        localStorage.setItem('user_data', JSON.stringify(currentUser));
        applyBrandTheme(currentUser.brand);
        updateUserUI();

        // Pre-load common data
        [allBrands, allProvinces] = await Promise.all([
            API.getBrands(),
            API.getProvinces()
        ]);

        navigateTo('dashboard');
    } catch (err) {
        console.error('Init error:', err);
        API.logout();
    }
}

// ============================================
// BRAND THEMING
// ============================================
function applyBrandTheme(brand) {
    if (!brand) return;
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', brand.primary_color);
    root.style.setProperty('--brand-secondary', brand.secondary_color);
    root.style.setProperty('--brand-accent', brand.accent_color || brand.primary_color);
    root.style.setProperty('--brand-text', brand.text_color || '#ffffff');

    document.getElementById('brandTitle').textContent = brand.name;
    document.getElementById('brandSubtitle').textContent = 'Sektör Analizi';

    if (brand.logo_url) {
        document.getElementById('brandLogo').innerHTML = `<img src="${brand.logo_url}" alt="${brand.name}">`;
    }
}

function updateUserUI() {
    if (!currentUser) return;
    document.getElementById('userName').textContent = currentUser.full_name;
    document.getElementById('userRole').textContent = currentUser.role === 'admin' ? 'Yönetici' : currentUser.company_name || 'Marka Kullanıcısı';
    document.getElementById('userAvatar').textContent = currentUser.full_name?.charAt(0) || 'U';
}

// ============================================
// NAVIGATION
// ============================================
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.menu-item[data-page="${page}"]`)?.classList.add('active');

    const pageContent = document.getElementById('pageContent');
    pageContent.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p>Yükleniyor...</p></div>';

    // Destroy old charts and map
    Object.values(charts).forEach(c => c.destroy?.());
    charts = {};
    if (leafletMap) { leafletMap.remove(); leafletMap = null; geoJsonLayer = null; }
    if (mapFullInstance) { mapFullInstance.remove(); mapFullInstance = null; mapFullGeoJson = null; }

    const titles = {
        dashboard: ['Dashboard', 'Genel Bakış'],
        historical: ['Tarihsel Gelişim', 'Traktör Pazarı Yıllık Analiz'],
        'total-market': ['Toplam Pazar', 'Yıllık Aylık Karşılaştırma'],
        'brand-summary': ['Marka', 'Tüm Markalar Özet Tablosu'],
        'distributor': ['Distribütör', 'Distribütör Bazlı Pazar Analizi'],
        'hp-segment': ['HP Segment', 'Beygir Gücü Segment Dağılımı'],
        'hp-top': ['Top 10 HP&Marka', 'HP Segmentlerinde En Çok Satan Markalar'],
        'hp-top-il': ['Top 10 HP&İl', 'HP Segmentlerinde En Çok Satıldığı İller'],
        'hp-top-model': ['Top 10 HP&Model', 'HP Segmentlerinde En Çok Satan Marka/Model'],
        'hp-top-il-cat': ['Top 10 HP&İl Seg.', 'HP Segmentlerinde En Çok Satıldığı İller (Bahçe/Tarla)'],
        'obt-hp': ['OBT HP', 'Bahçe/Tarla HP Segment Analizi'],
        'brand-hp': ['Marka HP Detay', 'Marka Bazlı HP Segment Analizi'],
        'hp-brand-matrix': ['HP Marka Matris', 'HP Segment Bazlı Marka Dağılımı'],
        'prov-top-brand': ['Top 10 İl&Marka', 'İl Bazında En Çok Satan Markalar'],
        'map-full': ['Harita 1', 'İl Bazlı Filtreleme'],
        map: ['Türkiye Haritası', 'İl Bazlı Satış Dağılımı'],
        sales: ['Satış Analizi', 'Detaylı Satış Verileri'],
        competitors: ['Rakip Analizi', 'Çok Boyutlu Karşılaştırma'],
        models: ['Model Karşılaştırma', 'Teknik Özellik Analizi'],
        province: ['İl Analizi', 'Toprak, İklim ve Ekin Verileri'],
        weather: ['Hava & İklim', 'Hava Durumu ve 10 Yıllık İklim Analizi'],
        'ai-insights': ['AI Öngörüler', 'Yapay Zeka Destekli Analizler'],
        subscription: ['Abonelik', 'Plan ve Ödeme Yönetimi'],
        settings: ['Ayarlar', 'Hesap Ayarları']
    };

    const [title, subtitle] = titles[page] || ['', ''];
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageSubtitle').textContent = subtitle;

    const loaders = {
        dashboard: loadDashboard,
        historical: loadHistoricalPage,
        'total-market': loadTotalMarketPage,
        'brand-summary': loadBrandSummaryPage,
        'distributor': loadDistributorPage,
        'hp-segment': loadHpSegmentPage,
        'hp-top': loadHpTopPage,
        'hp-top-il': loadHpTopIlPage,
        'hp-top-model': loadHpTopModelPage,
        'hp-top-il-cat': loadHpTopIlCatPage,
        'obt-hp': loadObtHpPage,
        'brand-hp': loadBrandHpPage,
        'hp-brand-matrix': loadHpBrandMatrixPage,
        'prov-top-brand': loadProvTopBrandPage,
        'map-full': loadMapFullPage,
        map: loadMapPage,
        sales: loadSalesPage,
        competitors: loadCompetitorsPage,
        models: loadModelsPage,
        province: loadProvincePage,
        weather: loadWeatherPage,
        'ai-insights': loadAIInsightsPage,
        subscription: loadSubscriptionPage,
        settings: loadSettingsPage
    };

    (loaders[page] || (() => {}))();
    if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

function onYearChange() {
    selectedYear = parseInt(document.getElementById('yearFilter').value);
    navigateTo(currentPage);
}

function refreshData() {
    API.clearCache();
    navigateTo(currentPage);
}

// ============================================
// HISTORICAL PAGE - Tarihsel Gelişim
// ============================================
async function loadHistoricalPage() {
    try {
        // Admin ise seçilen markayı kullan, değilse kendi markası
        const brandId = historicalSelectedBrandId || currentUser?.brand_id;
        const historical = await API.getSalesHistorical(brandId);
        const { data, max_year, max_month, compare_months, pct_diff_market, pct_diff_brand } = historical;

        const fullYears = data.filter(d => !d.is_partial);
        const partials = data.filter(d => d.is_partial).sort((a, b) => a.year - b.year);
        // Marka adını allBrands listesinden bul
        const selectedBrand = allBrands.find(b => b.id === brandId);
        const brandName = selectedBrand?.name || currentUser?.brand?.name || 'Seçili Marka';
        const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim();

        // Tüm labels: tam yıllar + kısmi yıllar
        const allLabels = [...fullYears.map(d => d.label), ...partials.map(d => d.label)];
        const allMarket = [...fullYears.map(d => d.total_market), ...partials.map(d => d.total_market)];
        const allBrand = [...fullYears.map(d => d.brand_sales), ...partials.map(d => d.brand_sales)];
        const allShare = [...fullYears.map(d => d.brand_share_pct), ...partials.map(d => d.brand_share_pct)];

        const content = document.getElementById('pageContent');

        // Format % diff with arrow
        function fmtDiff(val) {
            if (val == null) return '-';
            const cls = val >= 0 ? 'color:#22c55e' : 'color:#ef4444';
            const arrow = val >= 0 ? '▲' : '▼';
            return `<span style="${cls};font-weight:700">${arrow} %${Math.abs(val).toFixed(1)}</span>`;
        }

        content.innerHTML = `
            <div class="filter-bar" style="align-items:center">
                <div style="flex:1">
                    <h3 style="margin:0;font-size:16px">Traktör Pazarı Tarihsel Gelişimi</h3>
                    <span style="font-size:12px;color:var(--text-muted)">Son 12 yıl + dönemsel karşılaştırma</span>
                </div>
                ${currentUser?.role === 'admin' ? `
                    <select id="histBrandFilter" onchange="reloadHistorical()" style="min-width:200px">
                        ${allBrands.map(b => `<option value="${b.id}" ${b.id === brandId ? 'selected' : ''}>${b.name}</option>`).join('')}
                    </select>
                ` : ''}
            </div>

            <!-- Özet Kartları -->
            <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(168,85,247,0.15);color:#a855f7"><i class="fas fa-chart-line"></i></div>
                    <div class="stat-value">${formatNumber(partials[1]?.total_market || 0)}</div>
                    <div class="stat-label">${partials[1]?.label || max_year} TOPLAM PAZAR</div>
                    <div class="stat-change">${fmtDiff(pct_diff_market)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(59,130,246,0.15);color:${brandColor}"><i class="fas fa-tractor"></i></div>
                    <div class="stat-value">${formatNumber(partials[1]?.brand_sales || 0)}</div>
                    <div class="stat-label">${partials[1]?.label || max_year} ${brandName}</div>
                    <div class="stat-change">${fmtDiff(pct_diff_brand)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(34,197,94,0.15);color:#22c55e"><i class="fas fa-percentage"></i></div>
                    <div class="stat-value">%${partials[1]?.brand_share_pct || 0}</div>
                    <div class="stat-label">${brandName} PAZAR PAYI</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(245,158,11,0.15);color:#f59e0b"><i class="fas fa-exchange-alt"></i></div>
                    <div class="stat-value">${compare_months} Ay</div>
                    <div class="stat-label">KARŞILAŞTIRMA DÖNEMİ</div>
                </div>
            </div>

            <!-- Ana Grafik -->
            <div class="card">
                <div class="card-header">
                    <h3><i class="fas fa-chart-area"></i> Traktör Pazarı Tarihsel Gelişimi (${fullYears[0]?.year || ''} - ${max_year})</h3>
                </div>
                <div class="card-body">
                    <div class="chart-container" style="height:420px"><canvas id="historicalChart"></canvas></div>
                </div>
            </div>

            <!-- Veri Tablosu -->
            <div class="card">
                <div class="card-header">
                    <h3><i class="fas fa-table"></i> Yıllık Veri Tablosu</h3>
                </div>
                <div class="card-body" style="overflow-x:auto">
                    <table class="data-table" id="historicalTable">
                        <thead>
                            <tr>
                                <th style="position:sticky;left:0;background:var(--bg-card);z-index:1"></th>
                                ${fullYears.map(d => `<th style="text-align:center">${d.year}</th>`).join('')}
                                <th style="text-align:center;border-left:2px solid var(--brand-primary)">${partials[0]?.label || ''}</th>
                                <th style="text-align:center">${partials[1]?.label || ''}</th>
                                <th style="text-align:center;font-weight:700;color:var(--brand-accent)">% FARK</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style="position:sticky;left:0;background:var(--bg-card);font-weight:700;white-space:nowrap">Toplam Pazar</td>
                                ${fullYears.map(d => `<td style="text-align:right">${formatNumber(d.total_market)}</td>`).join('')}
                                <td style="text-align:right;border-left:2px solid var(--brand-primary);font-weight:600">${formatNumber(partials[0]?.total_market)}</td>
                                <td style="text-align:right;font-weight:600">${formatNumber(partials[1]?.total_market)}</td>
                                <td style="text-align:right">${fmtDiff(pct_diff_market)}</td>
                            </tr>
                            <tr style="background:rgba(59,130,246,0.05)">
                                <td style="position:sticky;left:0;background:rgba(30,41,59,0.95);font-weight:700;color:${brandColor};white-space:nowrap">${brandName}</td>
                                ${fullYears.map(d => `<td style="text-align:right">${formatNumber(d.brand_sales)}</td>`).join('')}
                                <td style="text-align:right;border-left:2px solid var(--brand-primary);font-weight:600">${formatNumber(partials[0]?.brand_sales)}</td>
                                <td style="text-align:right;font-weight:600">${formatNumber(partials[1]?.brand_sales)}</td>
                                <td style="text-align:right">${fmtDiff(pct_diff_brand)}</td>
                            </tr>
                            <tr>
                                <td style="position:sticky;left:0;background:var(--bg-card);font-weight:700;white-space:nowrap">${brandName} Pazar Payı</td>
                                ${fullYears.map(d => `<td style="text-align:right">%${d.brand_share_pct}</td>`).join('')}
                                <td style="text-align:right;border-left:2px solid var(--brand-primary);font-weight:600">%${partials[0]?.brand_share_pct || 0}</td>
                                <td style="text-align:right;font-weight:600">%${partials[1]?.brand_share_pct || 0}</td>
                                <td style="text-align:right">${(() => {
                                    if (partials.length < 2) return '-';
                                    const diff = partials[1].brand_share_pct - partials[0].brand_share_pct;
                                    const cls = diff >= 0 ? 'color:#22c55e' : 'color:#ef4444';
                                    return `<span style="${cls};font-weight:700">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}p</span>`;
                                })()}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // ===== CHART =====
        const ctx = document.getElementById('historicalChart');
        const isPartialBorder = allLabels.map((_, i) => i >= fullYears.length);

        charts.historical = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: allLabels,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Toplam Pazar',
                        data: allMarket,
                        backgroundColor: allLabels.map((_, i) =>
                            isPartialBorder[i] ? 'rgba(168,85,247,0.7)' : 'rgba(139,92,246,0.6)'
                        ),
                        borderColor: allLabels.map((_, i) =>
                            isPartialBorder[i] ? '#a855f7' : '#8b5cf6'
                        ),
                        borderWidth: 1,
                        borderRadius: 4,
                        yAxisID: 'y',
                        order: 2
                    },
                    {
                        type: 'line',
                        label: `${brandName} Pazar Payı (%)`,
                        data: allShare,
                        borderColor: brandColor,
                        backgroundColor: brandColor + '20',
                        borderWidth: 3,
                        pointBackgroundColor: brandColor,
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        pointRadius: 5,
                        pointHoverRadius: 8,
                        tension: 0.3,
                        fill: false,
                        yAxisID: 'y1',
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 11, weight: '500' },
                            maxRotation: 45,
                            minRotation: 0
                        }
                    },
                    y: {
                        position: 'left',
                        title: { display: true, text: 'Pazar (Adet)', color: '#94a3b8', font: { size: 12 } },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 11 },
                            callback: v => v >= 1000 ? (v/1000).toFixed(0) + '.000' : v
                        }
                    },
                    y1: {
                        position: 'right',
                        title: { display: true, text: `${brandName} Pazar Payı (%)`, color: brandColor, font: { size: 12 } },
                        grid: { drawOnChartArea: false },
                        ticks: {
                            color: brandColor,
                            font: { size: 11 },
                            callback: v => '%' + v.toFixed(1)
                        },
                        min: 0
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#94a3b8', padding: 16, font: { size: 12 }, usePointStyle: true, pointStyle: 'rectRounded' }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15,23,42,0.95)',
                        titleColor: '#f1f5f9',
                        bodyColor: '#94a3b8',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 14,
                        cornerRadius: 10,
                        callbacks: {
                            label: function(ctx) {
                                if (ctx.dataset.yAxisID === 'y1') {
                                    return `${ctx.dataset.label}: %${ctx.parsed.y.toFixed(1)}`;
                                }
                                return `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)} adet`;
                            }
                        }
                    }
                }
            }
        });

    } catch (err) {
        showError(err);
    }
}

let historicalSelectedBrandId = null;

async function reloadHistorical() {
    historicalSelectedBrandId = parseInt(document.getElementById('histBrandFilter')?.value) || null;
    API.clearCache();
    Object.values(charts).forEach(c => c.destroy?.());
    charts = {};
    loadHistoricalPage();
}

// ============================================
// MARKA (BRAND SUMMARY) PAGE
// ============================================
async function loadBrandSummaryPage() {
    try {
        const summary = await API.getBrandSummary();
        if (!summary) return;

        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        const { years, brands, totals, max_month, max_year, prev_year } = summary;

        // Header row
        let header = '<th>#</th><th>MARKA</th><th></th>';
        years.forEach(y => { header += `<th>${y}</th>`; });
        for (let m = 1; m <= max_month; m++) { header += `<th>${monthNames[m - 1]}</th>`; }
        header += `<th>${prev_year} İLK ${max_month} AY</th>`;
        header += `<th>${max_year} İLK ${max_month} AY</th>`;
        header += '<th>% FARK</th>';

        // Brand rows
        let bodyRows = '';
        brands.forEach((brand, idx) => {
            const rank = idx + 1;
            // Adet row
            let adetRow = `<td class="bs-rank" rowspan="2">${rank}</td>`;
            adetRow += `<td class="bs-brand" rowspan="2">${brand.name}</td>`;
            adetRow += '<td class="bs-type">Adet</td>';
            years.forEach(y => {
                adetRow += `<td>${(brand.yearly[y] || 0).toLocaleString('tr-TR')}</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                adetRow += `<td>${(brand.months[m] || 0).toLocaleString('tr-TR')}</td>`;
            }
            adetRow += `<td class="bs-partial">${brand.prev_partial.toLocaleString('tr-TR')}</td>`;
            adetRow += `<td class="bs-partial">${brand.curr_partial.toLocaleString('tr-TR')}</td>`;
            const brandDelta = brand.prev_partial > 0 ? ((brand.curr_partial - brand.prev_partial) * 100 / brand.prev_partial).toFixed(1) : '-';
            const brandDeltaClass = brandDelta !== '-' && parseFloat(brandDelta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
            adetRow += `<td class="bs-partial ${brandDeltaClass}">${brandDelta !== '-' ? '%' + brandDelta : '-'}</td>`;

            // % row (pazar payı)
            let pctRow = '<td class="bs-type">%</td>';
            years.forEach(y => {
                const share = totals.yearly[y] > 0 ? ((brand.yearly[y] || 0) * 100 / totals.yearly[y]).toFixed(1) : '0.0';
                pctRow += `<td class="bs-pct">${share}%</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const share = totals.months[m] > 0 ? ((brand.months[m] || 0) * 100 / totals.months[m]).toFixed(1) : '0.0';
                pctRow += `<td class="bs-pct">${share}%</td>`;
            }
            const prevShare = totals.prev_partial > 0 ? ((brand.prev_partial) * 100 / totals.prev_partial).toFixed(1) : '0.0';
            const currShare = totals.curr_partial > 0 ? ((brand.curr_partial) * 100 / totals.curr_partial).toFixed(1) : '0.0';
            pctRow += `<td class="bs-partial bs-pct">${prevShare}%</td>`;
            pctRow += `<td class="bs-partial bs-pct">${currShare}%</td>`;
            pctRow += '<td></td>';

            bodyRows += `<tr class="bs-row-adet">${adetRow}</tr><tr class="bs-row-pct">${pctRow}</tr>`;
        });

        // TOPLAM row
        let totalAdet = '<td class="bs-rank"></td><td class="bs-brand bs-total-label">TOPLAM</td><td class="bs-type">Adet</td>';
        years.forEach(y => {
            totalAdet += `<td class="bs-total-val">${(totals.yearly[y] || 0).toLocaleString('tr-TR')}</td>`;
        });
        for (let m = 1; m <= max_month; m++) {
            totalAdet += `<td class="bs-total-val">${(totals.months[m] || 0).toLocaleString('tr-TR')}</td>`;
        }
        totalAdet += `<td class="bs-total-val bs-partial">${totals.prev_partial.toLocaleString('tr-TR')}</td>`;
        totalAdet += `<td class="bs-total-val bs-partial">${totals.curr_partial.toLocaleString('tr-TR')}</td>`;
        const totalDelta = totals.prev_partial > 0 ? ((totals.curr_partial - totals.prev_partial) * 100 / totals.prev_partial).toFixed(1) : '-';
        const totalDeltaClass = totalDelta !== '-' && parseFloat(totalDelta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
        totalAdet += `<td class="bs-total-val bs-partial ${totalDeltaClass}">${totalDelta !== '-' ? '%' + totalDelta : '-'}</td>`;
        bodyRows += `<tr class="bs-row-total">${totalAdet}</tr>`;

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Marka Bazlı Pazar Analizi</h2>
                        <p>${years[0]} - ${max_year} yılları arası · İlk ${max_month} ay karşılaştırması</p>
                    </div>
                </div>
                <div class="chart-card" style="padding:16px; overflow-x:auto;">
                    <table class="bs-table">
                        <thead><tr>${header}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOP 10 HP & MARKA PAGE
// ============================================
async function loadHpTopPage() {
    try {
        const data = await API.getHpTopBrands();
        if (!data) return;

        const { year, max_month, segments } = data;
        const monthNames = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
        const periodLabel = `${monthNames[max_month - 1].toUpperCase()} ${year}`;

        // Her segment için kart oluştur
        let cards = '';
        segments.forEach(seg => {
            if (seg.total === 0) return;
            let rows = '';
            seg.brands.forEach((b, i) => {
                rows += `
                    <tr>
                        <td class="ht-brand">${b.brand}</td>
                        <td class="ht-sales">${b.sales.toLocaleString('tr-TR')}</td>
                        <td class="ht-share">${b.share}%</td>
                    </tr>`;
            });

            cards += `
                <div class="ht-card">
                    <div class="ht-card-header">
                        <span class="ht-hp-label">(${seg.hp_range})</span>
                    </div>
                    <table class="ht-table">
                        <thead><tr><th>Marka</th><th>Adet</th><th>%</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><td class="ht-total-label">Marka Toplam</td><td class="ht-total-val">${seg.total.toLocaleString('tr-TR')}</td><td></td></tr></tfoot>
                    </table>
                </div>
            `;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="ht-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>HP SEGMENTLERİNDE EN ÇOK SATAN İLK 10 MARKA</h2>
                        <p>${periodLabel} (Y.B)*</p>
                    </div>
                </div>
                <div class="ht-grid">${cards}</div>
                <p style="color:#64748b;font-size:11px;margin-top:16px;">*Y.B : Yılbaşından beri (İlk ${max_month} ay)</p>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOP 10 HP & MODEL PAGE
// ============================================
async function loadHpTopModelPage() {
    try {
        const data = await API.getHpTopModels();
        if (!data) return;

        const { year, max_month, categories } = data;
        const monthNames = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
        const periodLabel = `${monthNames[max_month - 1]} ${year}`;

        const catLabels = { 'bahce': 'Bahçe', 'tarla': 'Tarla' };
        const catColors = { 'bahce': '#dc2626', 'tarla': '#2563eb' };

        function buildCatRow(catKey, segments) {
            let cards = '';
            segments.forEach(seg => {
                let rows = '';
                seg.items.forEach(item => {
                    rows += `<tr>
                        <td class="ht-brand">${item.brand}</td>
                        <td class="ht-sales">${item.sales.toLocaleString('tr-TR')}</td>
                        <td class="ht-share">${item.share}%</td>
                    </tr>`;
                });
                cards += `
                    <div class="ht-card htm-card">
                        <div class="ht-card-header"><span class="ht-hp-label">${seg.hp_range}</span></div>
                        <table class="ht-table">
                            <thead><tr><th>Marka/Model</th><th>Adet</th><th>%</th></tr></thead>
                            <tbody>${rows}</tbody>
                            <tfoot><tr><td class="ht-total-label">Segment Toplam</td><td class="ht-total-val">${seg.total.toLocaleString('tr-TR')}</td><td></td></tr></tfoot>
                        </table>
                    </div>
                `;
            });
            return cards;
        }

        let html = '';
        for (const [catKey, segments] of Object.entries(categories)) {
            const label = catLabels[catKey] || catKey;
            const color = catColors[catKey] || '#64748b';
            html += `
                <div class="htm-cat-section">
                    <div class="htm-cat-header">
                        <div class="htm-cat-label" style="background:${color}">${label}</div>
                    </div>
                    <div class="htm-cat-content">
                        <div class="ht-grid htm-grid">${buildCatRow(catKey, segments)}</div>
                    </div>
                </div>
            `;
        }

        document.getElementById('pageContent').innerHTML = `
            <div class="ht-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>EN ÇOK SATAN İLK 10 MARKA/MODEL (HP SEGMENTİ BAZINDA)</h2>
                        <p>${periodLabel} (Y.B)*</p>
                    </div>
                </div>
                ${html}
                <p style="color:#64748b;font-size:11px;margin-top:16px;">*Y.B : Yılbaşından beri (İlk ${max_month} ay)</p>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// OBT HP PAGE
// ============================================
async function loadObtHpPage() {
    try {
        const data = await API.getObtHp();
        if (!data) return;

        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        const { years, categories, max_month, max_year, prev_year } = data;
        const catLabels = { 'bahce': 'Bahçe', 'tarla': 'Tarla' };
        const catColors = { 'bahce': '#dc2626', 'tarla': '#2563eb' };

        function cell(val, total) {
            const pct = total > 0 ? (val * 100 / total).toFixed(1) : '0.0';
            return `<td><div class="obt-cell"><span class="obt-adet">${val.toLocaleString('tr-TR')}</span><span class="obt-pct">${pct}%</span></div></td>`;
        }

        function buildTable(catKey, catData) {
            const { segments, total } = catData;
            const color = catColors[catKey];
            const label = catLabels[catKey];

            // Header
            let header = `<th class="obt-cat-th" style="background:${color}">${label}</th>`;
            years.forEach(y => { header += `<th>${y}</th>`; });
            for (let m = 1; m <= max_month; m++) { header += `<th>${monthNames[m - 1]}</th>`; }
            header += `<th>${prev_year} İLK ${max_month} AY</th><th>${max_year} İLK ${max_month} AY</th>`;

            // Category total row
            let totalRow = `<td class="obt-label obt-total-row">${label} Toplam</td>`;
            years.forEach(y => { totalRow += cell(total.yearly[y] || 0, total.yearly[y] || 0); });
            for (let m = 1; m <= max_month; m++) { totalRow += cell(total.months[m] || 0, total.months[m] || 0); }
            totalRow += cell(total.prev_partial, total.prev_partial);
            totalRow += cell(total.curr_partial, total.curr_partial);

            // Segment rows
            let segRows = '';
            segments.forEach(seg => {
                let row = `<td class="obt-label">${seg.hp}</td>`;
                years.forEach(y => { row += cell(seg.yearly[y] || 0, total.yearly[y] || 0); });
                for (let m = 1; m <= max_month; m++) { row += cell(seg.months[m] || 0, total.months[m] || 0); }
                row += cell(seg.prev_partial, total.prev_partial);
                row += cell(seg.curr_partial, total.curr_partial);
                segRows += `<tr>${row}</tr>`;
            });

            return `
                <table class="obt-table">
                    <thead><tr>${header}</tr></thead>
                    <tbody>
                        <tr class="obt-total-tr">${totalRow}</tr>
                        ${segRows}
                    </tbody>
                </table>
            `;
        }

        let html = '';
        for (const [catKey, catData] of Object.entries(categories)) {
            html += `<div class="chart-card" style="padding:16px;overflow-x:auto;margin-bottom:20px;">${buildTable(catKey, catData)}</div>`;
        }

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Bahçe / Tarla HP Segment Analizi</h2>
                        <p>${years[0]} - ${max_year} · İlk ${max_month} ay karşılaştırması · Adet + Pazar Payı</p>
                    </div>
                </div>
                ${html}
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// BRAND HP DETAIL PAGE
// ============================================
async function loadBrandHpPage() {
    try {
        const brands = await API.getBrands();
        const brandId = window._brandHpSelectedBrand || (brands && brands[0] ? brands[0].id : '');
        window._brandHpSelectedBrand = brandId;
        const data = await API.getBrandHpDetail(brandId);
        if (!data) return;

        const { brand_name, years, max_year, max_month, prev_year, segments } = data;
        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

        let brandOpts = '';
        if (brands) brands.forEach(b => {
            brandOpts += `<option value="${b.id}" ${b.id === brandId ? 'selected' : ''}>${b.name}</option>`;
        });

        const totalMarket = segments[0]; // Toplam Pazar

        // Header
        let header = `<th class="bhp-label-th">&nbsp;</th>`;
        years.forEach(y => { header += `<th>${y}</th>`; });
        for (let m = 1; m <= max_month; m++) { header += `<th>${monthNames[m - 1]}</th>`; }
        header += `<th>${prev_year} İLK ${max_month} AY</th>`;
        header += `<th>${max_year} İLK ${max_month} AY</th>`;
        header += `<th>Seg.<br>Ağırlık %</th>`;
        header += `<th>${brand_name}<br>${max_year} P.Payı</th>`;
        header += `<th>${brand_name}<br>${prev_year} P.Payı</th>`;
        header += `<th>P.Payı<br>Değişim</th>`;

        // Build rows
        let rows = '';
        segments.forEach((seg, idx) => {
            const isTotal = idx === 0;

            // Row 1: Market total (HP label row)
            let r1 = `<td class="bhp-hp-label ${isTotal ? 'bhp-total-label' : ''}">${seg.hp}${!isTotal ? ' HP' : ''}</td>`;
            years.forEach(y => { r1 += `<td class="bhp-market">${(seg.market.yearly[y] || 0).toLocaleString('tr-TR')}</td>`; });
            for (let m = 1; m <= max_month; m++) { r1 += `<td class="bhp-market">${(seg.market.months[m] || 0).toLocaleString('tr-TR')}</td>`; }
            r1 += `<td class="bhp-market bhp-partial">${seg.market.prev_partial.toLocaleString('tr-TR')}</td>`;
            r1 += `<td class="bhp-market bhp-partial">${seg.market.curr_partial.toLocaleString('tr-TR')}</td>`;
            // Segment weight
            const segWeight = isTotal ? '' : (totalMarket.market.curr_partial > 0 ? (seg.market.curr_partial / totalMarket.market.curr_partial * 100).toFixed(1) + '%' : '-');
            r1 += `<td class="bhp-weight">${segWeight}</td>`;
            // Brand share current/prev
            const bsCurr = seg.market.curr_partial > 0 ? (seg.brand.curr_partial / seg.market.curr_partial * 100).toFixed(1) : '0.0';
            const bsPrev = seg.market.prev_partial > 0 ? (seg.brand.prev_partial / seg.market.prev_partial * 100).toFixed(1) : '0.0';
            const bsChange = (parseFloat(bsCurr) - parseFloat(bsPrev)).toFixed(1);
            r1 += `<td class="bhp-share">${bsCurr}%</td>`;
            r1 += `<td class="bhp-share">${bsPrev}%</td>`;
            r1 += `<td class="bhp-change ${parseFloat(bsChange) >= 0 ? 'bhp-up' : 'bhp-down'}">${parseFloat(bsChange) >= 0 ? '' : ''}${bsChange}%</td>`;
            rows += `<tr class="bhp-market-row ${isTotal ? 'bhp-total-group' : ''}">${r1}</tr>`;

            // Row 2: Brand Adet
            let r2 = `<td class="bhp-row-label">${brand_name} Adet</td>`;
            years.forEach(y => { r2 += `<td class="bhp-brand">${(seg.brand.yearly[y] || 0).toLocaleString('tr-TR')}</td>`; });
            for (let m = 1; m <= max_month; m++) { r2 += `<td class="bhp-brand">${(seg.brand.months[m] || 0).toLocaleString('tr-TR')}</td>`; }
            r2 += `<td class="bhp-brand bhp-partial">${seg.brand.prev_partial.toLocaleString('tr-TR')}</td>`;
            r2 += `<td class="bhp-brand bhp-partial">${seg.brand.curr_partial.toLocaleString('tr-TR')}</td>`;
            r2 += `<td></td><td></td><td></td><td></td>`;
            rows += `<tr class="bhp-brand-row ${isTotal ? 'bhp-total-group' : ''}">${r2}</tr>`;

            // Row 3: Brand %
            let r3 = `<td class="bhp-row-label">${brand_name} %</td>`;
            years.forEach(y => {
                const pct = (seg.market.yearly[y] || 0) > 0 ? ((seg.brand.yearly[y] || 0) / seg.market.yearly[y] * 100).toFixed(1) : '0.0';
                r3 += `<td class="bhp-pct">${pct}%</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const pct = (seg.market.months[m] || 0) > 0 ? ((seg.brand.months[m] || 0) / seg.market.months[m] * 100).toFixed(1) : '0.0';
                r3 += `<td class="bhp-pct">${pct}%</td>`;
            }
            const prevPct = seg.market.prev_partial > 0 ? (seg.brand.prev_partial / seg.market.prev_partial * 100).toFixed(1) : '0.0';
            const currPct = seg.market.curr_partial > 0 ? (seg.brand.curr_partial / seg.market.curr_partial * 100).toFixed(1) : '0.0';
            r3 += `<td class="bhp-pct">${prevPct}%</td>`;
            r3 += `<td class="bhp-pct">${currPct}%</td>`;
            r3 += `<td></td><td></td><td></td><td></td>`;
            rows += `<tr class="bhp-pct-row ${isTotal ? 'bhp-total-group' : ''}">${r3}</tr>`;

            // Spacer row between segments
            if (!isTotal) {
                const colCount = 1 + years.length + max_month + 6;
                rows += `<tr class="bhp-spacer"><td colspan="${colCount}"></td></tr>`;
            }
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Marka HP Segment Analizi</h2>
                        <p>${years[0]} - ${max_year} · İlk ${max_month} ay karşılaştırması</p>
                    </div>
                    <div>
                        <select class="tm-brand-select" onchange="window._brandHpSelectedBrand=this.value; loadBrandHpPage();">
                            ${brandOpts}
                        </select>
                    </div>
                </div>
                <div class="chart-card" style="padding:16px;overflow-x:auto;">
                    <table class="bhp-table">
                        <thead><tr>${header}</tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// HP BRAND MATRIX PAGE
// ============================================
async function loadHpBrandMatrixPage() {
    try {
        const data = await API.getHpBrandMatrix();
        if (!data) return;

        const { years, max_year, max_month, prev_year, segments, total_market } = data;
        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

        function cell(val, total) {
            const pct = total > 0 ? (val * 100 / total).toFixed(1) : '0.0';
            if (val === 0) return `<td class="hbm-cell-empty"></td>`;
            return `<td><div class="obt-cell"><span class="obt-adet">${val.toLocaleString('tr-TR')}</span><span class="obt-pct">${pct}%</span></div></td>`;
        }

        let sectionsHtml = '';

        segments.forEach(seg => {
            const { hp, total: segTotal, brands } = seg;

            // Header row
            let header = `<th class="hbm-label-th">${hp} HP</th>`;
            years.forEach(y => { header += `<th>${y}</th>`; });
            for (let m = 1; m <= max_month; m++) { header += `<th>${monthNames[m - 1]}</th>`; }
            header += `<th>${prev_year} İLK ${max_month} AY</th>`;
            header += `<th>${max_year} İLK ${max_month} AY</th>`;

            // Brand rows
            let rows = '';
            brands.forEach(brand => {
                // Skip brands with no sales at all in this segment
                const hasAnySales = Object.values(brand.yearly).some(v => v > 0) || brand.prev_partial > 0 || brand.curr_partial > 0;
                if (!hasAnySales) return;

                let row = `<td class="hbm-brand-label">${brand.name}</td>`;
                years.forEach(y => { row += cell(brand.yearly[y] || 0, segTotal.yearly[y] || 0); });
                for (let m = 1; m <= max_month; m++) { row += cell(brand.months[m] || 0, segTotal.months[m] || 0); }
                row += cell(brand.prev_partial, segTotal.prev_partial);
                row += cell(brand.curr_partial, segTotal.curr_partial);
                rows += `<tr class="hbm-brand-row">${row}</tr>`;
            });

            // TOPLAM row
            let totalRow = `<td class="hbm-total-label">TOPLAM</td>`;
            years.forEach(y => {
                const v = segTotal.yearly[y] || 0;
                totalRow += `<td class="hbm-total-val">${v.toLocaleString('tr-TR')}</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const v = segTotal.months[m] || 0;
                totalRow += `<td class="hbm-total-val">${v.toLocaleString('tr-TR')}</td>`;
            }
            totalRow += `<td class="hbm-total-val">${segTotal.prev_partial.toLocaleString('tr-TR')}</td>`;
            totalRow += `<td class="hbm-total-val">${segTotal.curr_partial.toLocaleString('tr-TR')}</td>`;

            // TOPLAM PAZAR İÇİNDE % row
            let mktRow = `<td class="hbm-mkt-label">PAZAR İÇİNDE %</td>`;
            years.forEach(y => {
                const pct = (total_market.yearly[y] || 0) > 0 ? ((segTotal.yearly[y] || 0) / total_market.yearly[y] * 100).toFixed(1) : '0.0';
                mktRow += `<td class="hbm-mkt-pct">${pct}%</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const pct = (total_market.months[m] || 0) > 0 ? ((segTotal.months[m] || 0) / total_market.months[m] * 100).toFixed(1) : '0.0';
                mktRow += `<td class="hbm-mkt-pct">${pct}%</td>`;
            }
            const prevMktPct = total_market.prev_partial > 0 ? (segTotal.prev_partial / total_market.prev_partial * 100).toFixed(1) : '0.0';
            const currMktPct = total_market.curr_partial > 0 ? (segTotal.curr_partial / total_market.curr_partial * 100).toFixed(1) : '0.0';
            mktRow += `<td class="hbm-mkt-pct">${prevMktPct}%</td>`;
            mktRow += `<td class="hbm-mkt-pct">${currMktPct}%</td>`;

            sectionsHtml += `
                <div class="chart-card hbm-section">
                    <table class="hbm-table">
                        <thead><tr>${header}</tr></thead>
                        <tbody>
                            ${rows}
                            <tr class="hbm-total-row">${totalRow}</tr>
                            <tr class="hbm-mkt-row">${mktRow}</tr>
                        </tbody>
                    </table>
                </div>
            `;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>HP Segment - Marka Dağılımı</h2>
                        <p>${years[0]} - ${max_year} · İlk ${max_month} ay · Adet + Pazar Payı</p>
                    </div>
                </div>
                ${sectionsHtml}
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOP 10 İL & MARKA PAGE
// ============================================
async function loadProvTopBrandPage() {
    try {
        const data = await API.getProvinceTopBrands(selectedYear);
        if (!data) return;

        const { year, max_month, provinces } = data;
        const monthNames = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
        const periodLabel = `${monthNames[max_month - 1].toUpperCase()} ${year}`;

        let cards = '';
        provinces.forEach(prov => {
            if (prov.total === 0) return;
            let rows = '';
            prov.brands.forEach(b => {
                rows += `<tr>
                    <td class="ht-brand">${b.brand}</td>
                    <td class="ht-sales">${b.sales.toLocaleString('tr-TR')}</td>
                    <td class="ht-share">${b.share}%</td>
                </tr>`;
            });

            cards += `
                <div class="ht-card">
                    <div class="ht-card-header" style="background:rgba(34,197,94,0.15);">
                        <span class="ht-hp-label" style="color:#4ade80;">${prov.province}</span>
                    </div>
                    <table class="ht-table">
                        <thead><tr><th>Marka</th><th>Adet</th><th>%</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><td class="ht-total-label">İl Toplam</td><td class="ht-total-val">${prov.total.toLocaleString('tr-TR')}</td><td></td></tr></tfoot>
                    </table>
                </div>
            `;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="ht-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>EN ÇOK SATAN İLK 10 MARKA (İL BAZINDA)</h2>
                        <p>${periodLabel} (Y.B)*</p>
                    </div>
                </div>
                <div class="ht-grid">${cards}</div>
                <p style="color:#64748b;font-size:11px;margin-top:16px;">*Y.B : Yılbaşından beri (İlk ${max_month} ay)</p>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOP 10 HP & İL (BAHÇE/TARLA) PAGE
// ============================================
async function loadHpTopIlCatPage() {
    try {
        const data = await API.getHpTopProvincesCat();
        if (!data) return;

        const { year, max_month, categories } = data;
        const monthNames = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
        const periodLabel = `${monthNames[max_month - 1]} ${year}`;

        const catLabels = { 'bahce': 'Bahçe', 'tarla': 'Tarla' };
        const catColors = { 'bahce': '#dc2626', 'tarla': '#2563eb' };

        function buildCatRow(segments) {
            let cards = '';
            segments.forEach(seg => {
                let rows = '';
                seg.items.forEach(item => {
                    rows += `<tr>
                        <td class="ht-brand">${item.province}</td>
                        <td class="ht-sales">${item.sales.toLocaleString('tr-TR')}</td>
                        <td class="ht-share">${item.share}%</td>
                    </tr>`;
                });
                cards += `
                    <div class="ht-card htm-card">
                        <div class="ht-card-header"><span class="ht-hp-label">${seg.hp_range}</span></div>
                        <table class="ht-table">
                            <thead><tr><th>İl</th><th>Adet</th><th>%</th></tr></thead>
                            <tbody>${rows}</tbody>
                            <tfoot><tr><td class="ht-total-label">Segment Toplam</td><td class="ht-total-val">${seg.total.toLocaleString('tr-TR')}</td><td></td></tr></tfoot>
                        </table>
                    </div>
                `;
            });
            return cards;
        }

        let html = '';
        for (const [catKey, segments] of Object.entries(categories)) {
            const label = catLabels[catKey] || catKey;
            const color = catColors[catKey] || '#64748b';
            html += `
                <div class="htm-cat-section">
                    <div class="htm-cat-header">
                        <div class="htm-cat-label" style="background:${color}">${label}</div>
                    </div>
                    <div class="htm-cat-content">
                        <div class="ht-grid htm-grid">${buildCatRow(segments)}</div>
                    </div>
                </div>
            `;
        }

        document.getElementById('pageContent').innerHTML = `
            <div class="ht-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>EN ÇOK SATAN İLK 10 İL (HP SEGMENTİ BAZINDA)</h2>
                        <p>${periodLabel} (Y.B)*</p>
                    </div>
                </div>
                ${html}
                <p style="color:#64748b;font-size:11px;margin-top:16px;">*Y.B : Yılbaşından beri (İlk ${max_month} ay)</p>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOP 10 HP & İL PAGE
// ============================================
async function loadHpTopIlPage() {
    try {
        const data = await API.getHpTopProvinces();
        if (!data) return;

        const { year, max_month, segments } = data;
        const monthNames = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
        const periodLabel = `${monthNames[max_month - 1].toUpperCase()} ${year}`;

        let cards = '';
        segments.forEach(seg => {
            if (seg.total === 0) return;
            let rows = '';
            seg.provinces.forEach(p => {
                rows += `
                    <tr>
                        <td class="ht-brand">${p.province}</td>
                        <td class="ht-sales">${p.sales.toLocaleString('tr-TR')}</td>
                        <td class="ht-share">${p.share}%</td>
                    </tr>`;
            });

            cards += `
                <div class="ht-card">
                    <div class="ht-card-header">
                        <span class="ht-hp-label">(${seg.hp_range})</span>
                    </div>
                    <table class="ht-table">
                        <thead><tr><th>İl</th><th>Adet</th><th>%</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><td class="ht-total-label">İl Toplam</td><td class="ht-total-val">${seg.total.toLocaleString('tr-TR')}</td><td></td></tr></tfoot>
                    </table>
                </div>
            `;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="ht-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>HP SEGMENTLERİNİN EN ÇOK SATILDIĞI İLK 10 İL</h2>
                        <p>${periodLabel} (Y.B)*</p>
                    </div>
                </div>
                <div class="ht-grid">${cards}</div>
                <p style="color:#64748b;font-size:11px;margin-top:16px;">*Y.B : Yılbaşından beri (İlk ${max_month} ay)</p>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// HARİTA 1 - TAM EKRAN FİLTRELİ HARİTA
// ============================================
let mapFullInstance = null;
let mapFullGeoJson = null;

async function loadMapFullPage() {
    const hpSegments = ['1-39', '40-49', '50-54', '55-59', '60-69', '70-79', '80-89', '90-99', '100-109', '110-119', '120+'];
    const gearConfigs = ['8+2', '8+8', '12+12', '16+16', '32+32', 'CVT'];

    const brandOpts = allBrands.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    const hpOpts = hpSegments.map(h => `<option value="${h}">${h} HP</option>`).join('');
    const gearOpts = gearConfigs.map(g => `<option value="${g}">${g}</option>`).join('');

    document.getElementById('pageContent').innerHTML = `
        <div class="mf-container">
            <div class="mf-filters">
                <select id="mfBrand" onchange="updateMapFull()">
                    <option value="">Tüm Markalar</option>${brandOpts}
                </select>
                <select id="mfCabin" onchange="updateMapFull()">
                    <option value="">Tüm Kabin</option>
                    <option value="kabinli">Kabinli</option>
                    <option value="rollbar">Rollbar</option>
                </select>
                <select id="mfDrive" onchange="updateMapFull()">
                    <option value="">Tüm Çekiş</option>
                    <option value="2WD">2WD</option>
                    <option value="4WD">4WD</option>
                </select>
                <select id="mfGear" onchange="updateMapFull()">
                    <option value="">Tüm Şanzıman</option>${gearOpts}
                </select>
                <select id="mfHp" onchange="updateMapFull()">
                    <option value="">Tüm HP</option>${hpOpts}
                </select>
            </div>
            <div class="mf-map-wrap">
                <div id="mapFullContainer"></div>
                <div class="mf-legend">
                    <span><i style="background:#1e40af"></i>Yüksek</span>
                    <span><i style="background:#3b82f6"></i>Orta-Yüksek</span>
                    <span><i style="background:#60a5fa"></i>Orta</span>
                    <span><i style="background:#93c5fd"></i>Düşük</span>
                    <span><i style="background:#1e293b"></i>Satış Yok</span>
                </div>
            </div>
        </div>
    `;

    // Harita oluştur
    if (mapFullInstance) { mapFullInstance.remove(); mapFullInstance = null; }
    mapFullInstance = L.map('mapFullContainer', {
        center: [39.0, 35.5],
        zoom: 6.5,
        minZoom: 5,
        maxZoom: 10,
        zoomControl: true,
        attributionControl: false
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19
    }).addTo(mapFullInstance);

    // İlk yükleme
    await updateMapFull();
}

async function updateMapFull() {
    const brandId = document.getElementById('mfBrand')?.value || '';
    const filters = {
        cabin_type: document.getElementById('mfCabin')?.value || '',
        drive_type: document.getElementById('mfDrive')?.value || '',
        hp_range: document.getElementById('mfHp')?.value || '',
        gear_config: document.getElementById('mfGear')?.value || ''
    };

    const salesData = await API.getSalesByProvince(selectedYear, brandId, filters);
    await renderMapFullGeoJSON(salesData);
}

async function renderMapFullGeoJSON(salesData) {
    try {
        const response = await fetch('https://raw.githubusercontent.com/cihadturhan/tr-geojson/master/geo/tr-cities-utf8.json');
        const geoData = await response.json();

        const provinceSales = {};
        (salesData || []).forEach(s => {
            const name = s.province_name;
            if (!provinceSales[name]) provinceSales[name] = { total: 0, brands: {} };
            provinceSales[name].total += parseInt(s.total_sales);
            if (s.brand_name) {
                if (!provinceSales[name].brands[s.brand_name]) provinceSales[name].brands[s.brand_name] = 0;
                provinceSales[name].brands[s.brand_name] += parseInt(s.total_sales);
            }
        });

        const allTotals = Object.values(provinceSales).map(p => p.total);
        const maxSales = Math.max(...allTotals, 1);

        const nameMap = {
            'Afyon': 'Afyonkarahisar', 'Elâzığ': 'Elazığ', 'Içel': 'Mersin',
            'Kahramanmaras': 'Kahramanmaraş', 'Kirikkale': 'Kırıkkale', 'Kirklareli': 'Kırklareli',
            'Kirsehir': 'Kırşehir', 'Nevsehir': 'Nevşehir', 'Nigde': 'Niğde',
            'Sanliurfa': 'Şanlıurfa', 'Sirnak': 'Şırnak', 'K. Maras': 'Kahramanmaraş'
        };

        function getColor(sales) {
            if (!sales || sales === 0) return '#1e293b';
            const ratio = sales / maxSales;
            if (ratio > 0.7) return '#1e40af';
            if (ratio > 0.4) return '#3b82f6';
            if (ratio > 0.2) return '#60a5fa';
            return '#93c5fd';
        }

        if (mapFullGeoJson) mapFullInstance.removeLayer(mapFullGeoJson);

        mapFullGeoJson = L.geoJSON(geoData, {
            style: function(feature) {
                const name = feature.properties.name || feature.properties.Name;
                const dbName = nameMap[name] || name;
                const sales = provinceSales[dbName]?.total || 0;
                return { fillColor: getColor(sales), weight: 1, opacity: 1, color: '#334155', fillOpacity: 0.85 };
            },
            onEachFeature: function(feature, layer) {
                const name = feature.properties.name || feature.properties.Name;
                const dbName = nameMap[name] || name;
                const data = provinceSales[dbName];
                const sales = data?.total || 0;
                const prov = allProvinces.find(p => p.name === dbName);

                const topBrands = data ? Object.entries(data.brands).sort((a,b) => b[1]-a[1]).slice(0,5) : [];
                layer.bindTooltip(`
                    <div style="font-size:13px;min-width:200px">
                        <strong style="font-size:14px">${dbName}</strong> ${prov ? `(${prov.plate_code})` : ''}<br>
                        <span style="color:#94a3b8">${prov?.region || ''}</span>
                        <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0">
                        <div style="display:flex;justify-content:space-between"><span>Toplam Satış:</span><strong>${formatNumber(sales)}</strong></div>
                        ${topBrands.length > 0 ? `
                            <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0">
                            <div style="font-size:11px;color:#94a3b8">En Çok Satan:</div>
                            ${topBrands.map((b,i) => `<div style="display:flex;justify-content:space-between;font-size:11px"><span>${i+1}. ${b[0]}</span><span>${formatNumber(b[1])}</span></div>`).join('')}
                        ` : ''}
                    </div>
                `, { sticky: true, className: 'map-tooltip' });

                layer.on('mouseover', function() { this.setStyle({ weight: 3, color: '#60a5fa', fillOpacity: 1 }); this.bringToFront(); });
                layer.on('mouseout', function() { mapFullGeoJson.resetStyle(this); });
            }
        }).addTo(mapFullInstance);

        mapFullInstance.fitBounds(mapFullGeoJson.getBounds(), { padding: [5, 5] });

    } catch (err) {
        console.error('MapFull GeoJSON error:', err);
    }
}

// ============================================
// HP SEGMENT PAGE
// ============================================
async function loadHpSegmentPage() {
    try {
        const data = await API.getHpSummary();
        if (!data) return;

        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        const { years, segments, totals, max_month, max_year, prev_year } = data;
        const hpLabels = { '1-39': '1-39', '40-49': '40-49', '50-54': '50-54', '55-59': '55-59', '60-69': '60-69', '70-79': '70-79', '80-89': '80-89', '90-99': '90-99', '100-109': '100-109', '110-119': '110-119', '120+': '120-120+' };
        const hpColors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#2980b9', '#c0392b', '#27ae60', '#8e44ad'];

        // ---- ADET TABLOSU ----
        let adetHeader = '<th>#</th><th>Adet</th>';
        years.forEach(y => { adetHeader += `<th>${y}</th>`; });
        for (let m = 1; m <= max_month; m++) { adetHeader += `<th>${monthNames[m - 1]}</th>`; }
        adetHeader += `<th>${prev_year} İLK ${max_month} AY</th><th>${max_year} İLK ${max_month} AY</th><th>% FARK</th>`;

        let adetRows = '';
        segments.forEach((seg, idx) => {
            let row = `<td class="bs-rank">${idx + 1}</td><td class="bs-brand">${hpLabels[seg.name] || seg.name}</td>`;
            years.forEach(y => { row += `<td>${(seg.yearly[y] || 0).toLocaleString('tr-TR')}</td>`; });
            for (let m = 1; m <= max_month; m++) { row += `<td>${(seg.months[m] || 0).toLocaleString('tr-TR')}</td>`; }
            row += `<td class="bs-partial">${seg.prev_partial.toLocaleString('tr-TR')}</td>`;
            row += `<td class="bs-partial">${seg.curr_partial.toLocaleString('tr-TR')}</td>`;
            const delta = seg.prev_partial > 0 ? ((seg.curr_partial - seg.prev_partial) * 100 / seg.prev_partial).toFixed(1) : '-';
            const dc = delta !== '-' && parseFloat(delta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
            row += `<td class="bs-partial ${dc}">${delta !== '-' ? '%' + delta : '-'}</td>`;
            adetRows += `<tr class="bs-row-adet">${row}</tr>`;
        });
        // TOPLAM
        let totalRow = '<td class="bs-rank"></td><td class="bs-brand bs-total-label">TOPLAM</td>';
        years.forEach(y => { totalRow += `<td class="bs-total-val">${(totals.yearly[y] || 0).toLocaleString('tr-TR')}</td>`; });
        for (let m = 1; m <= max_month; m++) { totalRow += `<td class="bs-total-val">${(totals.months[m] || 0).toLocaleString('tr-TR')}</td>`; }
        totalRow += `<td class="bs-total-val bs-partial">${totals.prev_partial.toLocaleString('tr-TR')}</td>`;
        totalRow += `<td class="bs-total-val bs-partial">${totals.curr_partial.toLocaleString('tr-TR')}</td>`;
        const tDelta = totals.prev_partial > 0 ? ((totals.curr_partial - totals.prev_partial) * 100 / totals.prev_partial).toFixed(1) : '-';
        const tdc = tDelta !== '-' && parseFloat(tDelta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
        totalRow += `<td class="bs-total-val bs-partial ${tdc}">${tDelta !== '-' ? '%' + tDelta : '-'}</td>`;
        adetRows += `<tr class="bs-row-total">${totalRow}</tr>`;

        // ---- % TABLOSU ----
        let pctHeader = '<th>#</th><th>%</th>';
        years.forEach(y => { pctHeader += `<th>${y}</th>`; });
        for (let m = 1; m <= max_month; m++) { pctHeader += `<th>${monthNames[m - 1]}</th>`; }
        pctHeader += `<th>${prev_year} İLK ${max_month} AY</th><th>${max_year} İLK ${max_month} AY</th><th></th>`;

        let pctRows = '';
        segments.forEach((seg, idx) => {
            let row = `<td class="bs-rank">${idx + 1}</td><td class="bs-brand">${hpLabels[seg.name] || seg.name}</td>`;
            years.forEach(y => {
                const pct = totals.yearly[y] > 0 ? ((seg.yearly[y] || 0) * 100 / totals.yearly[y]).toFixed(1) : '0.0';
                row += `<td class="bs-pct">${pct}%</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const pct = totals.months[m] > 0 ? ((seg.months[m] || 0) * 100 / totals.months[m]).toFixed(1) : '0.0';
                row += `<td class="bs-pct">${pct}%</td>`;
            }
            const prevPct = totals.prev_partial > 0 ? (seg.prev_partial * 100 / totals.prev_partial).toFixed(1) : '0.0';
            const currPct = totals.curr_partial > 0 ? (seg.curr_partial * 100 / totals.curr_partial).toFixed(1) : '0.0';
            row += `<td class="bs-partial bs-pct">${prevPct}%</td><td class="bs-partial bs-pct">${currPct}%</td><td></td>`;
            pctRows += `<tr class="bs-row-pct">${row}</tr>`;
        });
        // TOPLAM %
        let totalPctRow = '<td class="bs-rank"></td><td class="bs-brand bs-total-label">TOPLAM</td>';
        years.forEach(() => { totalPctRow += '<td class="bs-total-val">100%</td>'; });
        for (let m = 1; m <= max_month; m++) { totalPctRow += '<td class="bs-total-val">100%</td>'; }
        totalPctRow += '<td class="bs-total-val bs-partial">100%</td><td class="bs-total-val bs-partial">100%</td><td></td>';
        pctRows += `<tr class="bs-row-total">${totalPctRow}</tr>`;

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Segment Dağılımı - HP Bazlı Analiz</h2>
                        <p>${years[0]} - ${max_year} yılları arası · İlk ${max_month} ay karşılaştırması</p>
                    </div>
                </div>
                <div class="chart-card" style="padding:16px; overflow-x:auto; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 12px;font-size:15px;">Adet Bazlı</h3>
                    <table class="bs-table">
                        <thead><tr>${adetHeader}</tr></thead>
                        <tbody>${adetRows}</tbody>
                    </table>
                </div>
                <div class="chart-card" style="padding:16px; overflow-x:auto; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 12px;font-size:15px;">Yüzde Bazlı</h3>
                    <table class="bs-table">
                        <thead><tr>${pctHeader}</tr></thead>
                        <tbody>${pctRows}</tbody>
                    </table>
                </div>
                <div class="chart-card" style="padding:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;text-align:center;">Segment Dağılımı - ${max_year} İLK ${max_month} AY</h3>
                    <div style="position:relative;height:400px;max-width:600px;margin:0 auto;">
                        <canvas id="hpPieChart"></canvas>
                    </div>
                </div>
            </div>
        `;

        // Pie Chart
        const ctx = document.getElementById('hpPieChart').getContext('2d');
        const pieData = segments.map(s => s.curr_partial);
        const pieLabels = segments.map(s => hpLabels[s.name] || s.name);
        charts.hpPie = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: pieLabels,
                datasets: [{
                    data: pieData,
                    backgroundColor: hpColors,
                    borderColor: '#0f172a',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: '#f1f5f9', font: { size: 12, family: 'Inter' }, padding: 16 }
                    },
                    tooltip: {
                        backgroundColor: '#1e293b',
                        titleColor: '#f1f5f9',
                        bodyColor: '#94a3b8',
                        borderColor: '#334155',
                        borderWidth: 1,
                        callbacks: {
                            label: function(ctx) {
                                const val = ctx.raw;
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? (val * 100 / total).toFixed(1) : 0;
                                return `${ctx.label}: ${val.toLocaleString('tr-TR')} adet (${pct}%)`;
                            }
                        }
                    },
                    datalabels: false
                }
            },
            plugins: [{
                id: 'pieLabels',
                afterDraw(chart) {
                    const { ctx, data } = chart;
                    const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                    chart.getDatasetMeta(0).data.forEach((arc, i) => {
                        const val = data.datasets[0].data[i];
                        const pct = total > 0 ? (val * 100 / total).toFixed(1) : 0;
                        const { x, y } = arc.tooltipPosition();
                        ctx.save();
                        ctx.fillStyle = '#fff';
                        ctx.font = 'bold 11px Inter';
                        ctx.textAlign = 'center';
                        ctx.fillText(`${val.toLocaleString('tr-TR')}`, x, y - 6);
                        ctx.fillText(`${pct}%`, x, y + 8);
                        ctx.restore();
                    });
                }
            }]
        });

    } catch (err) {
        showError(err);
    }
}

// ============================================
// DİSTRİBÜTÖR PAGE
// ============================================
async function loadDistributorPage() {
    try {
        const summary = await API.getDistributorSummary();
        if (!summary) return;

        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        const { years, brands, totals, max_month, max_year, prev_year } = summary;

        // Header
        let header = '<th>#</th><th>DİSTRİBÜTÖR</th><th></th>';
        years.forEach(y => { header += `<th>${y}</th>`; });
        for (let m = 1; m <= max_month; m++) { header += `<th>${monthNames[m - 1]}</th>`; }
        header += `<th>${prev_year} İLK ${max_month} AY</th>`;
        header += `<th>${max_year} İLK ${max_month} AY</th>`;
        header += '<th>% FARK</th>';

        // Rows
        let bodyRows = '';
        brands.forEach((brand, idx) => {
            const rank = idx + 1;
            // İsim satırları (alt şirket bilgisi)
            const nameParts = brand.name.split('\n');
            const mainName = nameParts[0];
            const subName = nameParts[1] || '';
            const nameHtml = subName
                ? `<span class="bs-main-name">${mainName}</span><br><span class="bs-sub-name">${subName}</span>`
                : mainName;

            // Adet row
            let adetRow = `<td class="bs-rank" rowspan="2">${rank}</td>`;
            adetRow += `<td class="bs-brand" rowspan="2">${nameHtml}</td>`;
            adetRow += '<td class="bs-type">Adet</td>';
            years.forEach(y => {
                adetRow += `<td>${(brand.yearly[y] || 0).toLocaleString('tr-TR')}</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                adetRow += `<td>${(brand.months[m] || 0).toLocaleString('tr-TR')}</td>`;
            }
            adetRow += `<td class="bs-partial">${brand.prev_partial.toLocaleString('tr-TR')}</td>`;
            adetRow += `<td class="bs-partial">${brand.curr_partial.toLocaleString('tr-TR')}</td>`;
            const delta = brand.prev_partial > 0 ? ((brand.curr_partial - brand.prev_partial) * 100 / brand.prev_partial).toFixed(1) : '-';
            const deltaClass = delta !== '-' && parseFloat(delta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
            adetRow += `<td class="bs-partial ${deltaClass}">${delta !== '-' ? '%' + delta : '-'}</td>`;

            // % row
            let pctRow = '<td class="bs-type">%</td>';
            years.forEach(y => {
                const share = totals.yearly[y] > 0 ? ((brand.yearly[y] || 0) * 100 / totals.yearly[y]).toFixed(1) : '0.0';
                pctRow += `<td class="bs-pct">${share}%</td>`;
            });
            for (let m = 1; m <= max_month; m++) {
                const share = totals.months[m] > 0 ? ((brand.months[m] || 0) * 100 / totals.months[m]).toFixed(1) : '0.0';
                pctRow += `<td class="bs-pct">${share}%</td>`;
            }
            const prevShare = totals.prev_partial > 0 ? (brand.prev_partial * 100 / totals.prev_partial).toFixed(1) : '0.0';
            const currShare = totals.curr_partial > 0 ? (brand.curr_partial * 100 / totals.curr_partial).toFixed(1) : '0.0';
            pctRow += `<td class="bs-partial bs-pct">${prevShare}%</td>`;
            pctRow += `<td class="bs-partial bs-pct">${currShare}%</td>`;
            pctRow += '<td></td>';

            bodyRows += `<tr class="bs-row-adet">${adetRow}</tr><tr class="bs-row-pct">${pctRow}</tr>`;
        });

        // TOPLAM
        let totalRow = '<td class="bs-rank"></td><td class="bs-brand bs-total-label">TOPLAM</td><td class="bs-type">Adet</td>';
        years.forEach(y => {
            totalRow += `<td class="bs-total-val">${(totals.yearly[y] || 0).toLocaleString('tr-TR')}</td>`;
        });
        for (let m = 1; m <= max_month; m++) {
            totalRow += `<td class="bs-total-val">${(totals.months[m] || 0).toLocaleString('tr-TR')}</td>`;
        }
        totalRow += `<td class="bs-total-val bs-partial">${totals.prev_partial.toLocaleString('tr-TR')}</td>`;
        totalRow += `<td class="bs-total-val bs-partial">${totals.curr_partial.toLocaleString('tr-TR')}</td>`;
        const tDelta = totals.prev_partial > 0 ? ((totals.curr_partial - totals.prev_partial) * 100 / totals.prev_partial).toFixed(1) : '-';
        const tDeltaClass = tDelta !== '-' && parseFloat(tDelta) >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
        totalRow += `<td class="bs-total-val bs-partial ${tDeltaClass}">${tDelta !== '-' ? '%' + tDelta : '-'}</td>`;
        bodyRows += `<tr class="bs-row-total">${totalRow}</tr>`;

        document.getElementById('pageContent').innerHTML = `
            <div class="bs-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Distribütör Bazlı Pazar Analizi</h2>
                        <p>${years[0]} - ${max_year} yılları arası · İlk ${max_month} ay karşılaştırması</p>
                    </div>
                </div>
                <div class="chart-card" style="padding:16px; overflow-x:auto;">
                    <table class="bs-table">
                        <thead><tr>${header}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TOPLAM PAZAR PAGE
// ============================================
let tmSelectedBrandId = null;

async function reloadTotalMarket() {
    tmSelectedBrandId = parseInt(document.getElementById('tmBrandFilter')?.value) || null;
    API.clearCache();
    Object.values(charts).forEach(c => c.destroy?.());
    charts = {};
    loadTotalMarketPage();
}

async function loadTotalMarketPage() {
    try {
        const [brands, data] = await Promise.all([
            API.getBrands(),
            API.getTotalMarket(tmSelectedBrandId)
        ]);
        if (!data) return;

        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
        const prevYear = data.prev_year;
        const currYear = data.curr_year;
        const maxMonth = data.max_month;
        const brandName = data.brand_name || 'Marka Seçiniz';

        // Brand selector options
        let brandOptions = '<option value="">-- Marka Seçin --</option>';
        (brands || []).forEach(b => {
            brandOptions += `<option value="${b.id}" ${b.id === tmSelectedBrandId ? 'selected' : ''}>${b.name}</option>`;
        });

        // ---- TOPLAM PAZAR TABLOSU ----
        let tHeaderCells = '<th></th>';
        let tPrevCells = `<td class="tm-year-label">${prevYear}</td>`;
        let tCurrCells = `<td class="tm-year-label">${currYear}</td>`;
        let tDeltaCells = '<td class="tm-year-label">Δ%</td>';

        data.months.forEach(m => {
            tHeaderCells += `<th>${monthNames[m.month - 1]}</th>`;
            tPrevCells += `<td>${m.total_prev.toLocaleString('tr-TR')}</td>`;
            tCurrCells += `<td>${m.total_curr.toLocaleString('tr-TR')}</td>`;
            const dc = m.total_delta >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
            tDeltaCells += `<td class="${dc}">${m.total_delta !== null ? '%' + m.total_delta.toLocaleString('tr-TR') : '-'}</td>`;
        });
        tHeaderCells += `<th>İLK ${maxMonth} AY</th>`;
        tPrevCells += `<td class="tm-total">${data.total_prev.toLocaleString('tr-TR')}</td>`;
        tCurrCells += `<td class="tm-total">${data.total_curr.toLocaleString('tr-TR')}</td>`;
        const tdcT = data.total_delta >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
        tDeltaCells += `<td class="tm-total ${tdcT}">${data.total_delta !== null ? '%' + data.total_delta.toLocaleString('tr-TR') : '-'}</td>`;

        // ---- MARKA TABLOSU ----
        let brandTableHtml = '';
        if (tmSelectedBrandId && data.brand_name) {
            let bHeaderCells = '<th></th>';
            let bPrevCells = `<td class="tm-year-label">${prevYear}</td>`;
            let bCurrCells = `<td class="tm-year-label">${currYear}</td>`;
            let bDeltaCells = '<td class="tm-year-label">Δ%</td>';
            let bSharePrevCells = `<td class="tm-year-label">${brandName} Pazar Payı</td>`;

            data.months.forEach(m => {
                bHeaderCells += `<th>${monthNames[m.month - 1]}</th>`;
                bPrevCells += `<td>${m.brand_prev.toLocaleString('tr-TR')}</td>`;
                bCurrCells += `<td>${m.brand_curr.toLocaleString('tr-TR')}</td>`;
                const dc = m.brand_delta >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
                bDeltaCells += `<td class="${dc}">${m.brand_delta !== null ? '%' + m.brand_delta.toLocaleString('tr-TR') : '-'}</td>`;
                // Pazar payı
                const sharePrev = m.total_curr > 0 ? (m.brand_curr * 100 / m.total_curr).toFixed(1) : '0.0';
                bSharePrevCells += `<td>%${sharePrev}</td>`;
            });
            bHeaderCells += `<th>İLK ${maxMonth} AY</th>`;
            bPrevCells += `<td class="tm-total">${data.brand_prev.toLocaleString('tr-TR')}</td>`;
            bCurrCells += `<td class="tm-total">${data.brand_curr.toLocaleString('tr-TR')}</td>`;
            const bdcT = data.brand_delta >= 0 ? 'tm-delta-pos' : 'tm-delta-neg';
            bDeltaCells += `<td class="tm-total ${bdcT}">${data.brand_delta !== null ? '%' + data.brand_delta.toLocaleString('tr-TR') : '-'}</td>`;
            const totalShare = data.total_curr > 0 ? (data.brand_curr * 100 / data.total_curr).toFixed(1) : '0.0';
            bSharePrevCells += `<td class="tm-total">%${totalShare}</td>`;

            brandTableHtml = `
                <div class="chart-card" style="padding:24px; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;">${brandName} Aylık Karşılaştırma (${prevYear} - ${currYear})</h3>
                    <div style="position:relative;height:350px;"><canvas id="brandMarketChart"></canvas></div>
                </div>
                <div class="chart-card tm-table-card" style="padding:24px; overflow-x:auto; margin-bottom:24px;">
                    <table class="tm-table">
                        <thead><tr>${bHeaderCells}</tr></thead>
                        <tbody>
                            <tr class="tm-row-prev">${bPrevCells}</tr>
                            <tr class="tm-row-curr">${bCurrCells}</tr>
                            <tr class="tm-row-delta">${bDeltaCells}</tr>
                            <tr class="tm-row-share">${bSharePrevCells}</tr>
                        </tbody>
                    </table>
                </div>
            `;
        }

        document.getElementById('pageContent').innerHTML = `
            <div class="tm-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Toplam Traktör Pazarı (${prevYear} - ${currYear})</h2>
                        <p>İlk ${maxMonth} ay karşılaştırması</p>
                    </div>
                    <select id="tmBrandFilter" class="year-select" onchange="reloadTotalMarket()" style="min-width:200px;">
                        ${brandOptions}
                    </select>
                </div>
                <div class="chart-card" style="padding:24px; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;">Toplam Pazar Aylık Karşılaştırma</h3>
                    <div style="position:relative;height:350px;"><canvas id="totalMarketChart"></canvas></div>
                </div>
                <div class="chart-card tm-table-card" style="padding:24px; overflow-x:auto; margin-bottom:24px;">
                    <table class="tm-table">
                        <thead><tr>${tHeaderCells}</tr></thead>
                        <tbody>
                            <tr class="tm-row-prev">${tPrevCells}</tr>
                            <tr class="tm-row-curr">${tCurrCells}</tr>
                            <tr class="tm-row-delta">${tDeltaCells}</tr>
                        </tbody>
                    </table>
                </div>
                ${brandTableHtml}
            </div>
        `;

        // Toplam Pazar Chart
        const ctx1 = document.getElementById('totalMarketChart').getContext('2d');
        charts.totalMarket = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: data.months.map(m => monthNames[m.month - 1]),
                datasets: [
                    {
                        label: prevYear.toString(),
                        data: data.months.map(m => m.total_prev),
                        backgroundColor: '#1e3a5f',
                        borderColor: '#1e3a5f',
                        borderWidth: 1,
                        borderRadius: 4
                    },
                    {
                        label: currYear.toString(),
                        data: data.months.map(m => m.total_curr),
                        backgroundColor: '#2e7d32',
                        borderColor: '#2e7d32',
                        borderWidth: 1,
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: '#f1f5f9', font: { size: 13, family: 'Inter' }, usePointStyle: true, padding: 20 }
                    },
                    tooltip: {
                        backgroundColor: '#1e293b',
                        titleColor: '#f1f5f9',
                        bodyColor: '#94a3b8',
                        borderColor: '#334155',
                        borderWidth: 1,
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString('tr-TR')} adet`
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
                    y: {
                        beginAtZero: true,
                        ticks: { color: '#94a3b8', callback: v => v.toLocaleString('tr-TR') },
                        grid: { color: 'rgba(148,163,184,0.1)' },
                        title: { display: true, text: 'Pazar (Adet)', color: '#94a3b8' }
                    }
                }
            }
        });

        // Marka Chart
        if (tmSelectedBrandId && data.brand_name) {
            const ctx2 = document.getElementById('brandMarketChart').getContext('2d');
            charts.brandMarket = new Chart(ctx2, {
                type: 'bar',
                data: {
                    labels: data.months.map(m => monthNames[m.month - 1]),
                    datasets: [
                        {
                            label: `${brandName} ${prevYear}`,
                            data: data.months.map(m => m.brand_prev),
                            backgroundColor: '#1e3a5f',
                            borderColor: '#1e3a5f',
                            borderWidth: 1,
                            borderRadius: 4
                        },
                        {
                            label: `${brandName} ${currYear}`,
                            data: data.months.map(m => m.brand_curr),
                            backgroundColor: '#2e7d32',
                            borderColor: '#2e7d32',
                            borderWidth: 1,
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'top',
                            labels: { color: '#f1f5f9', font: { size: 13, family: 'Inter' }, usePointStyle: true, padding: 20 }
                        },
                        tooltip: {
                            backgroundColor: '#1e293b',
                            titleColor: '#f1f5f9',
                            bodyColor: '#94a3b8',
                            borderColor: '#334155',
                            borderWidth: 1,
                            callbacks: {
                                label: ctx => `${ctx.dataset.label}: ${ctx.raw.toLocaleString('tr-TR')} adet`
                            }
                        }
                    },
                    scales: {
                        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
                        y: {
                            beginAtZero: true,
                            ticks: { color: '#94a3b8', callback: v => v.toLocaleString('tr-TR') },
                            grid: { color: 'rgba(148,163,184,0.1)' },
                            title: { display: true, text: 'Adet', color: '#94a3b8' }
                        }
                    }
                }
            });
        }

    } catch (err) {
        showError(err);
    }
}

// ============================================
// DASHBOARD PAGE
// ============================================
async function loadDashboard() {
    try {
        const [dashboard, marketShare, summary] = await Promise.all([
            API.getDashboard(selectedYear),
            API.getMarketShare(selectedYear),
            API.getSalesSummary(selectedYear)
        ]);

        const brandId = currentUser?.brand_id;
        const brandData = brandId ? summary?.find(s => s.slug === currentUser?.brand?.slug) : null;

        const content = document.getElementById('pageContent');
        content.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(59,130,246,0.15);color:#3b82f6"><i class="fas fa-chart-line"></i></div>
                    <div class="stat-value">${formatNumber(dashboard.total_market_sales)}</div>
                    <div class="stat-label">Toplam Pazar Satışı (${selectedYear})</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(34,197,94,0.15);color:#22c55e"><i class="fas fa-tractor"></i></div>
                    <div class="stat-value">${formatNumber(dashboard.brand_sales)}</div>
                    <div class="stat-label">${brandId ? 'Marka Satışı' : 'Toplam Satış'}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(245,158,11,0.15);color:#f59e0b"><i class="fas fa-map-marker-alt"></i></div>
                    <div class="stat-value">${dashboard.active_provinces}</div>
                    <div class="stat-label">Aktif İl</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(168,85,247,0.15);color:#a855f7"><i class="fas fa-percentage"></i></div>
                    <div class="stat-value">${dashboard.market_share != null ? '%' + dashboard.market_share : '-'}</div>
                    <div class="stat-label">Pazar Payı</div>
                </div>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header"><h3>Aylık Satış Trendi</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="monthlyChart"></canvas></div></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Pazar Payı Dağılımı</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="marketShareChart"></canvas></div></div>
                </div>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header"><h3>En Çok Satan İller (Top 10)</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="topProvincesChart"></canvas></div></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Marka Sıralaması</h3></div>
                    <div class="card-body">
                        <table class="data-table">
                            <thead><tr><th>#</th><th>Marka</th><th>Satış</th><th>Pazar Payı</th></tr></thead>
                            <tbody id="brandRankingTable"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        // Monthly Trend Chart
        const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
        const trendData = dashboard.monthly_trend || [];
        charts.monthly = new Chart(document.getElementById('monthlyChart'), {
            type: 'line',
            data: {
                labels: months,
                datasets: [{
                    label: 'Satış',
                    data: months.map((_, i) => {
                        const m = trendData.find(t => t.month === i + 1);
                        return m ? parseInt(m.total) : 0;
                    }),
                    borderColor: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
                    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() + '20',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    borderWidth: 2
                }]
            },
            options: chartOptions('Adet')
        });

        // Market Share Pie Chart
        const topBrands = (marketShare || []).slice(0, 10);
        charts.marketShare = new Chart(document.getElementById('marketShareChart'), {
            type: 'doughnut',
            data: {
                labels: topBrands.map(b => b.brand_name),
                datasets: [{
                    data: topBrands.map(b => parseFloat(b.market_share_pct || 0)),
                    backgroundColor: topBrands.map(b => b.primary_color),
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#94a3b8', padding: 12, font: { size: 11 } } },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: %${ctx.parsed}` } }
                }
            }
        });

        // Top Provinces Chart
        const topProv = dashboard.top_provinces || [];
        charts.topProvinces = new Chart(document.getElementById('topProvincesChart'), {
            type: 'bar',
            data: {
                labels: topProv.map(p => p.name),
                datasets: [{
                    label: 'Satış',
                    data: topProv.map(p => parseInt(p.total)),
                    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() + '80',
                    borderColor: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: { ...chartOptions('Adet'), indexAxis: 'y' }
        });

        // Brand Ranking Table
        const tbody = document.getElementById('brandRankingTable');
        (summary || []).forEach((b, i) => {
            const isMyBrand = b.slug === currentUser?.brand?.slug;
            tbody.innerHTML += `
                <tr style="${isMyBrand ? 'background:rgba(59,130,246,0.1)' : ''}">
                    <td><div class="rank" style="background:${b.primary_color}20;color:${b.primary_color}">${i + 1}</div></td>
                    <td style="font-weight:${isMyBrand ? '700' : '400'}">${b.brand_name}</td>
                    <td>${formatNumber(b.total_sales)}</td>
                    <td>${b.province_count} il</td>
                </tr>
            `;
        });

    } catch (err) {
        showError(err);
    }
}

// ============================================
// MAP PAGE
// ============================================
let leafletMap = null;
let geoJsonLayer = null;
let mapSalesData = null;

async function loadMapPage() {
    try {
        mapSalesData = await API.getSalesByProvince(selectedYear, currentUser?.brand_id);
        const content = document.getElementById('pageContent');

        content.innerHTML = `
            <div class="filter-bar">
                <select id="mapBrandFilter" onchange="updateMap()">
                    <option value="">Tüm Markalar</option>
                    ${allBrands.map(b => `<option value="${b.id}" ${b.id === currentUser?.brand_id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
                <select id="mapRegionFilter" onchange="updateMap()">
                    <option value="">Tüm Bölgeler</option>
                    <option value="Marmara">Marmara</option>
                    <option value="Ege">Ege</option>
                    <option value="Akdeniz">Akdeniz</option>
                    <option value="İç Anadolu">İç Anadolu</option>
                    <option value="Karadeniz">Karadeniz</option>
                    <option value="Doğu Anadolu">Doğu Anadolu</option>
                    <option value="Güneydoğu Anadolu">Güneydoğu Anadolu</option>
                </select>
            </div>

            <div class="card">
                <div class="card-header"><h3><i class="fas fa-map-marked-alt"></i> Türkiye Satış Haritası</h3></div>
                <div class="card-body">
                    <div class="turkey-map-container">
                        <div id="turkeyMap"></div>
                    </div>
                    <div style="display:flex;justify-content:center;gap:24px;margin-top:16px;font-size:12px;color:var(--text-muted)">
                        <span><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#1e40af;margin-right:4px"></span>Yüksek</span>
                        <span><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#3b82f6;margin-right:4px"></span>Orta-Yüksek</span>
                        <span><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#60a5fa;margin-right:4px"></span>Orta</span>
                        <span><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#93c5fd;margin-right:4px"></span>Düşük</span>
                        <span><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#1e293b;margin-right:4px"></span>Satış Yok</span>
                    </div>
                </div>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header"><h3>İl Bazlı Satış Tablosu</h3></div>
                    <div class="card-body" style="max-height:400px;overflow-y:auto">
                        <table class="data-table" id="provinceTable">
                            <thead><tr><th>#</th><th>İl</th><th>Bölge</th><th>Satış</th></tr></thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Bölge Dağılımı</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="regionChart"></canvas></div></div>
                </div>
            </div>
        `;

        initLeafletMap(mapSalesData);
        renderProvinceTable(mapSalesData);
        renderRegionChart(mapSalesData);

    } catch (err) {
        showError(err);
    }
}

function initLeafletMap(salesData) {
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }

    leafletMap = L.map('turkeyMap', {
        center: [39.0, 35.5],
        zoom: 6,
        minZoom: 5,
        maxZoom: 10,
        zoomControl: true,
        attributionControl: false
    });

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19
    }).addTo(leafletMap);

    // Load GeoJSON
    loadTurkeyGeoJSON(salesData);
}

async function loadTurkeyGeoJSON(salesData) {
    try {
        // Fetch Turkey provinces GeoJSON
        const response = await fetch('https://raw.githubusercontent.com/cihadturhan/tr-geojson/master/geo/tr-cities-utf8.json');
        const geoData = await response.json();

        // Aggregate sales by province name
        const provinceSales = {};
        (salesData || []).forEach(s => {
            const name = s.province_name;
            if (!provinceSales[name]) provinceSales[name] = { total: 0, brands: {} };
            provinceSales[name].total += parseInt(s.total_sales);
            if (s.brand_name) {
                if (!provinceSales[name].brands[s.brand_name]) provinceSales[name].brands[s.brand_name] = 0;
                provinceSales[name].brands[s.brand_name] += parseInt(s.total_sales);
            }
        });

        const allTotals = Object.values(provinceSales).map(p => p.total);
        const maxSales = Math.max(...allTotals, 1);

        // Province name mapping (GeoJSON name -> DB name)
        const nameMap = {
            'Afyon': 'Afyonkarahisar', 'Elâzığ': 'Elazığ', 'Içel': 'Mersin',
            'Kahramanmaras': 'Kahramanmaraş', 'Kirikkale': 'Kırıkkale', 'Kirklareli': 'Kırklareli',
            'Kirsehir': 'Kırşehir', 'Nevsehir': 'Nevşehir', 'Nigde': 'Niğde',
            'Sanliurfa': 'Şanlıurfa', 'Sirnak': 'Şırnak', 'Kinkkale': 'Kırıkkale',
            'K. Maras': 'Kahramanmaraş', 'Ağrı': 'Ağrı', 'Muş': 'Muş',
            'Karabük': 'Karabük'
        };

        function getColor(sales) {
            if (!sales || sales === 0) return '#1e293b';
            const ratio = sales / maxSales;
            if (ratio > 0.7) return '#1e40af';
            if (ratio > 0.4) return '#3b82f6';
            if (ratio > 0.2) return '#60a5fa';
            return '#93c5fd';
        }

        if (geoJsonLayer) leafletMap.removeLayer(geoJsonLayer);

        geoJsonLayer = L.geoJSON(geoData, {
            style: function(feature) {
                const name = feature.properties.name || feature.properties.Name;
                const dbName = nameMap[name] || name;
                const sales = provinceSales[dbName]?.total || 0;
                return {
                    fillColor: getColor(sales),
                    weight: 1,
                    opacity: 1,
                    color: '#334155',
                    fillOpacity: 0.85
                };
            },
            onEachFeature: function(feature, layer) {
                const name = feature.properties.name || feature.properties.Name;
                const dbName = nameMap[name] || name;
                const data = provinceSales[dbName];
                const sales = data?.total || 0;
                const prov = allProvinces.find(p => p.name === dbName);

                // Tooltip
                const topBrands = data ? Object.entries(data.brands).sort((a,b) => b[1]-a[1]).slice(0,3) : [];
                layer.bindTooltip(`
                    <div style="font-size:13px;min-width:180px">
                        <strong style="font-size:14px">${dbName}</strong> ${prov ? `(${prov.plate_code})` : ''}<br>
                        <span style="color:#94a3b8">${prov?.region || ''}</span>
                        <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0">
                        <div style="display:flex;justify-content:space-between"><span>Toplam Satış:</span><strong>${formatNumber(sales)}</strong></div>
                        ${prov ? `<div style="display:flex;justify-content:space-between"><span>Nüfus:</span><span>${formatNumber(prov.population)}</span></div>` : ''}
                        ${topBrands.length > 0 ? `
                            <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0">
                            <div style="font-size:11px;color:#94a3b8">En Çok Satan Markalar:</div>
                            ${topBrands.map((b,i) => `<div style="display:flex;justify-content:space-between;font-size:11px"><span>${i+1}. ${b[0]}</span><span>${formatNumber(b[1])}</span></div>`).join('')}
                        ` : ''}
                    </div>
                `, { sticky: true, className: 'map-tooltip' });

                // Hover effect
                layer.on('mouseover', function() {
                    this.setStyle({ weight: 3, color: '#60a5fa', fillOpacity: 1 });
                    this.bringToFront();
                });
                layer.on('mouseout', function() {
                    geoJsonLayer.resetStyle(this);
                });
                layer.on('click', function() {
                    // İl detayına git
                    if (prov) {
                        document.getElementById('pageContent').scrollTo(0, 0);
                    }
                });
            }
        }).addTo(leafletMap);

        // Fit bounds to Turkey
        leafletMap.fitBounds(geoJsonLayer.getBounds(), { padding: [20, 20] });

    } catch (err) {
        console.error('GeoJSON yükleme hatası:', err);
        // Fallback: circle markers
        drawCircleMarkers(salesData);
    }
}

function drawCircleMarkers(salesData) {
    const provinceSales = {};
    (salesData || []).forEach(s => {
        const name = s.province_name;
        if (!provinceSales[name]) provinceSales[name] = 0;
        provinceSales[name] += parseInt(s.total_sales);
    });
    const maxSales = Math.max(...Object.values(provinceSales), 1);

    allProvinces.forEach(prov => {
        const sales = provinceSales[prov.name] || 0;
        const ratio = sales / maxSales;
        let color = '#1e293b';
        if (ratio > 0.7) color = '#1e40af';
        else if (ratio > 0.4) color = '#3b82f6';
        else if (ratio > 0.2) color = '#60a5fa';
        else if (sales > 0) color = '#93c5fd';

        L.circleMarker([parseFloat(prov.latitude), parseFloat(prov.longitude)], {
            radius: 6 + ratio * 18,
            fillColor: color,
            color: '#475569',
            weight: 1,
            fillOpacity: 0.8
        }).addTo(leafletMap)
          .bindTooltip(`<strong>${prov.name}</strong> (${prov.plate_code})<br>Satış: ${formatNumber(sales)}`);
    });
}

function renderProvinceTable(salesData) {
    const aggregated = {};
    (salesData || []).forEach(s => {
        const key = s.province_name;
        if (!aggregated[key]) aggregated[key] = { name: s.province_name, region: s.region, total: 0 };
        aggregated[key].total += parseInt(s.total_sales);
    });
    const sorted = Object.values(aggregated).sort((a, b) => b.total - a.total);
    const tbody = document.querySelector('#provinceTable tbody');
    if (!tbody) return;
    tbody.innerHTML = sorted.slice(0, 30).map((p, i) => `
        <tr>
            <td>${i + 1}</td>
            <td style="font-weight:600">${p.name}</td>
            <td>${p.region}</td>
            <td>${formatNumber(p.total)}</td>
        </tr>
    `).join('');
}

function renderRegionChart(salesData) {
    const regions = {};
    (salesData || []).forEach(s => {
        if (!regions[s.region]) regions[s.region] = 0;
        regions[s.region] += parseInt(s.total_sales);
    });
    const sorted = Object.entries(regions).sort((a, b) => b[1] - a[1]);
    const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];

    charts.region = new Chart(document.getElementById('regionChart'), {
        type: 'pie',
        data: {
            labels: sorted.map(r => r[0]),
            datasets: [{ data: sorted.map(r => r[1]), backgroundColor: colors, borderWidth: 0 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 10, font: { size: 11 } } } }
        }
    });
}

async function updateMap() {
    const brandId = document.getElementById('mapBrandFilter')?.value;
    mapSalesData = await API.getSalesByProvince(selectedYear, brandId);
    if (leafletMap) {
        loadTurkeyGeoJSON(mapSalesData);
    }
    renderProvinceTable(mapSalesData);
}

// ============================================
// SALES PAGE
// ============================================
async function loadSalesPage() {
    try {
        const [categoryData, hpData, trendData] = await Promise.all([
            API.getSalesByCategory(selectedYear, 'category', currentUser?.brand_id),
            API.getHpComparison(selectedYear, currentUser?.brand_id),
            API.getMonthlyTrend(selectedYear, currentUser?.brand_id)
        ]);

        const content = document.getElementById('pageContent');
        content.innerHTML = `
            <div class="filter-bar">
                <select id="salesDimension" onchange="updateSalesCharts()">
                    <option value="category">Tarla / Bahçe</option>
                    <option value="cabin_type">Kabinli / Rollbar</option>
                    <option value="drive_type">2WD / 4WD</option>
                    <option value="hp_range">Beygir Gücü Aralığı</option>
                    <option value="gear_config">Şanzıman Tipi</option>
                </select>
                <select id="salesBrandFilter">
                    <option value="">Tüm Markalar</option>
                    ${allBrands.map(b => `<option value="${b.id}" ${b.id === currentUser?.brand_id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
                <button class="btn-filter" onclick="updateSalesCharts()"><i class="fas fa-filter"></i> Filtrele</button>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header"><h3>Kategori Dağılımı</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="categoryChart"></canvas></div></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Beygir Gücü Dağılımı</h3></div>
                    <div class="card-body"><div class="chart-container"><canvas id="hpChart"></canvas></div></div>
                </div>
            </div>

            <div class="card">
                <div class="card-header"><h3>Aylık Satış Trendi - Tüm Markalar</h3></div>
                <div class="card-body"><div class="chart-container large"><canvas id="allBrandsTrend"></canvas></div></div>
            </div>
        `;

        renderCategoryChart(categoryData);
        renderHpChart(hpData);
        renderAllBrandsTrend(trendData);

    } catch (err) {
        showError(err);
    }
}

function renderCategoryChart(data) {
    const grouped = {};
    (data || []).forEach(d => {
        if (!grouped[d.dimension_value]) grouped[d.dimension_value] = 0;
        grouped[d.dimension_value] += parseInt(d.total_sales);
    });
    const labels = Object.keys(grouped);
    const values = Object.values(grouped);
    const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

    charts.category = new Chart(document.getElementById('categoryChart'), {
        type: 'bar',
        data: {
            labels: labels.map(translateLabel),
            datasets: [{ data: values, backgroundColor: colors.slice(0, labels.length), borderRadius: 8, borderWidth: 0 }]
        },
        options: { ...chartOptions('Adet'), plugins: { legend: { display: false } } }
    });
}

function renderHpChart(data) {
    const grouped = {};
    (data || []).forEach(d => {
        const range = d.hp_range;
        if (!grouped[range]) grouped[range] = {};
        if (!grouped[range][d.brand_name]) grouped[range][d.brand_name] = 0;
        grouped[range][d.brand_name] += parseInt(d.total_sales);
    });

    const hpRanges = ['0-50', '51-75', '76-100', '101-150', '150+'];
    const brands = [...new Set((data || []).map(d => d.brand_name))].slice(0, 8);

    charts.hp = new Chart(document.getElementById('hpChart'), {
        type: 'bar',
        data: {
            labels: hpRanges.map(r => r + ' HP'),
            datasets: brands.map((brand, i) => ({
                label: brand,
                data: hpRanges.map(r => grouped[r]?.[brand] || 0),
                backgroundColor: (data || []).find(d => d.brand_name === brand)?.primary_color || `hsl(${i * 45}, 70%, 50%)`,
                borderRadius: 4
            }))
        },
        options: { ...chartOptions('Adet'), plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } } }
    });
}

function renderAllBrandsTrend(data) {
    const grouped = {};
    (data || []).forEach(d => {
        if (!grouped[d.brand_name]) grouped[d.brand_name] = { color: d.primary_color, months: {} };
        grouped[d.brand_name].months[d.month] = parseInt(d.total_sales);
    });

    const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
    const topBrands = Object.entries(grouped)
        .map(([name, d]) => ({ name, total: Object.values(d.months).reduce((a, b) => a + b, 0), ...d }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);

    charts.allBrandsTrend = new Chart(document.getElementById('allBrandsTrend'), {
        type: 'line',
        data: {
            labels: months,
            datasets: topBrands.map(b => ({
                label: b.name,
                data: months.map((_, i) => b.months[i + 1] || 0),
                borderColor: b.color,
                backgroundColor: 'transparent',
                tension: 0.3,
                pointRadius: 3,
                borderWidth: 2
            }))
        },
        options: chartOptions('Adet')
    });
}

async function updateSalesCharts() {
    const dim = document.getElementById('salesDimension')?.value;
    const brandId = document.getElementById('salesBrandFilter')?.value;
    const data = await API.getSalesByCategory(selectedYear, dim, brandId);
    charts.category?.destroy();
    renderCategoryChart(data);
}

// ============================================
// COMPETITORS PAGE
// ============================================
async function loadCompetitorsPage() {
    try {
        const marketShare = await API.getMarketShare(selectedYear);
        const content = document.getElementById('pageContent');

        content.innerHTML = `
            <div class="filter-bar">
                <select id="compBrandFilter">
                    ${allBrands.map(b => `<option value="${b.id}" ${b.id === currentUser?.brand_id ? 'selected' : ''}>${b.name}</option>`).join('')}
                </select>
                <select id="compDimension">
                    <option value="cabin_type">Kabinli vs Rollbar</option>
                    <option value="drive_type">2WD vs 4WD</option>
                    <option value="category">Tarla vs Bahçe</option>
                    <option value="hp_range">Beygir Gücü</option>
                    <option value="gear_config">Şanzıman Tipi</option>
                </select>
                <button class="btn-filter" onclick="loadCompetitorAnalysis()"><i class="fas fa-search"></i> Analiz Et</button>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header"><h3>Pazar Payı Karşılaştırma</h3></div>
                    <div class="card-body"><div class="chart-container large"><canvas id="compMarketChart"></canvas></div></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Boyut Bazlı Karşılaştırma</h3></div>
                    <div class="card-body"><div class="chart-container large"><canvas id="compDimChart"></canvas></div></div>
                </div>
            </div>

            <div class="card">
                <div class="card-header"><h3>Detaylı Rakip Tablosu</h3></div>
                <div class="card-body">
                    <table class="data-table" id="compTable">
                        <thead><tr><th>#</th><th>Marka</th><th>Satış</th><th>Pazar Payı</th><th>Durum</th></tr></thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        `;

        // Market share bar chart
        const top15 = (marketShare || []).slice(0, 15);
        charts.compMarket = new Chart(document.getElementById('compMarketChart'), {
            type: 'bar',
            data: {
                labels: top15.map(b => b.brand_name),
                datasets: [{
                    label: 'Pazar Payı %',
                    data: top15.map(b => parseFloat(b.market_share_pct)),
                    backgroundColor: top15.map(b => {
                        const isMyBrand = b.slug === currentUser?.brand?.slug;
                        return isMyBrand ? b.primary_color : b.primary_color + '80';
                    }),
                    borderColor: top15.map(b => b.primary_color),
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: { ...chartOptions('%'), plugins: { legend: { display: false } } }
        });

        // Competitor table
        const tbody = document.querySelector('#compTable tbody');
        top15.forEach((b, i) => {
            const isMyBrand = b.slug === currentUser?.brand?.slug;
            tbody.innerHTML += `
                <tr style="${isMyBrand ? 'background:rgba(59,130,246,0.08);font-weight:600' : ''}">
                    <td><div class="rank" style="background:${b.primary_color}20;color:${b.primary_color}">${i + 1}</div></td>
                    <td><span style="color:${b.primary_color}">${isMyBrand ? '★ ' : ''}${b.brand_name}</span></td>
                    <td>${formatNumber(b.brand_sales)}</td>
                    <td>%${b.market_share_pct}</td>
                    <td>${isMyBrand ? '<span style="color:var(--brand-primary)">Sizin Markanız</span>' : ''}</td>
                </tr>
            `;
        });

        loadCompetitorAnalysis();

    } catch (err) {
        showError(err);
    }
}

async function loadCompetitorAnalysis() {
    const brandId = document.getElementById('compBrandFilter')?.value;
    const dimension = document.getElementById('compDimension')?.value;
    if (!brandId) return;

    const compIds = allBrands.filter(b => b.id !== parseInt(brandId)).slice(0, 5).map(b => b.id);
    const data = await API.getCompetitorCompare(selectedYear, brandId, compIds.join(','));

    // Group by dimension
    const grouped = {};
    (data || []).forEach(d => {
        const dimVal = d[dimension] || 'Bilinmiyor';
        if (!grouped[dimVal]) grouped[dimVal] = {};
        if (!grouped[dimVal][d.brand_name]) grouped[dimVal][d.brand_name] = { total: 0, color: d.primary_color };
        grouped[dimVal][d.brand_name].total += parseInt(d.total_sales);
    });

    const dimLabels = Object.keys(grouped);
    const brandNames = [...new Set((data || []).map(d => d.brand_name))].slice(0, 6);

    if (charts.compDim) charts.compDim.destroy();
    charts.compDim = new Chart(document.getElementById('compDimChart'), {
        type: 'bar',
        data: {
            labels: dimLabels.map(translateLabel),
            datasets: brandNames.map(name => ({
                label: name,
                data: dimLabels.map(d => grouped[d]?.[name]?.total || 0),
                backgroundColor: (data || []).find(d => d.brand_name === name)?.primary_color || '#666',
                borderRadius: 4
            }))
        },
        options: { ...chartOptions('Adet'), plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } } }
    });
}

// ============================================
// MODELS PAGE
// ============================================
async function loadModelsPage() {
    const content = document.getElementById('pageContent');
    content.innerHTML = `
        <div class="filter-bar">
            <select id="modelBrandFilter">
                <option value="">Tüm Markalar</option>
                ${allBrands.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
            </select>
            <select id="modelCategory">
                <option value="">Tüm Kategoriler</option>
                <option value="tarla">Tarla</option>
                <option value="bahce">Bahçe</option>
            </select>
            <select id="modelDrive">
                <option value="">Tüm Çekişler</option>
                <option value="2WD">2WD</option>
                <option value="4WD">4WD</option>
            </select>
            <select id="modelCabin">
                <option value="">Tüm Tipler</option>
                <option value="kabinli">Kabinli</option>
                <option value="rollbar">Rollbar</option>
            </select>
            <input type="number" id="modelHpMin" placeholder="Min HP" style="width:80px">
            <input type="number" id="modelHpMax" placeholder="Max HP" style="width:80px">
            <button class="btn-filter" onclick="searchModels()"><i class="fas fa-search"></i> Ara</button>
        </div>

        <div class="card">
            <div class="card-header">
                <h3>Traktör Modelleri</h3>
                <span style="font-size:12px;color:var(--text-muted)" id="modelCount">-</span>
            </div>
            <div class="card-body">
                <div class="empty-state" id="modelResults">
                    <i class="fas fa-tractor"></i>
                    <h3>Model aramak için filtreleri kullanın</h3>
                    <p>Marka, kategori veya beygir gücü seçerek arama yapabilirsiniz</p>
                </div>
            </div>
        </div>

        <div class="card" id="compareSection" style="display:none">
            <div class="card-header"><h3>Model Karşılaştırma</h3></div>
            <div class="card-body" id="compareResults"></div>
        </div>
    `;
}

async function searchModels() {
    const filters = {
        brand_id: document.getElementById('modelBrandFilter')?.value,
        category: document.getElementById('modelCategory')?.value,
        drive_type: document.getElementById('modelDrive')?.value,
        cabin_type: document.getElementById('modelCabin')?.value,
        hp_min: document.getElementById('modelHpMin')?.value,
        hp_max: document.getElementById('modelHpMax')?.value,
    };

    Object.keys(filters).forEach(k => { if (!filters[k]) delete filters[k]; });
    const models = await API.getModels(filters);

    const results = document.getElementById('modelResults');
    document.getElementById('modelCount').textContent = `${(models || []).length} model bulundu`;

    if (!models || models.length === 0) {
        results.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><h3>Sonuç bulunamadı</h3></div>';
        return;
    }

    results.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Marka</th><th>Model</th><th>HP</th><th>Kategori</th>
                    <th>Kabin</th><th>Çekiş</th><th>Şanzıman</th><th>Ağırlık</th>
                </tr>
            </thead>
            <tbody>
                ${models.map(m => `
                    <tr>
                        <td style="color:${allBrands.find(b => b.id === m.brand_id)?.primary_color || '#fff'};font-weight:600">${m.brand_name}</td>
                        <td>${m.model_name}</td>
                        <td>${m.horsepower} HP</td>
                        <td>${translateLabel(m.category)}</td>
                        <td>${translateLabel(m.cabin_type)}</td>
                        <td>${m.drive_type}</td>
                        <td>${m.gear_config || '-'}</td>
                        <td>${m.weight_kg ? m.weight_kg + ' kg' : '-'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// ============================================
// PROVINCE PAGE
// ============================================
async function loadProvincePage() {
    const content = document.getElementById('pageContent');
    content.innerHTML = `
        <div class="filter-bar">
            <select id="provinceSelect" onchange="loadProvinceDetail()">
                <option value="">İl Seçin</option>
                ${allProvinces.map(p => `<option value="${p.id}">${p.name} (${p.plate_code})</option>`).join('')}
            </select>
        </div>
        <div id="provinceDetailContent">
            <div class="empty-state">
                <i class="fas fa-city"></i>
                <h3>Analiz etmek istediğiniz ili seçin</h3>
                <p>Toprak yapısı, ekin bilgisi ve traktör önerileri görüntülenecek</p>
            </div>
        </div>
    `;
}

async function loadProvinceDetail() {
    const provId = document.getElementById('provinceSelect')?.value;
    if (!provId) return;

    const prov = allProvinces.find(p => p.id === parseInt(provId));
    const [soil, crops, provinceSales] = await Promise.all([
        API.getSoil(provId),
        API.getCrops(provId, selectedYear),
        API.getSalesByProvince(selectedYear, currentUser?.brand_id)
    ]);

    const provSales = (provinceSales || []).filter(s => s.plate_code === prov?.plate_code);
    const totalSales = provSales.reduce((sum, s) => sum + parseInt(s.total_sales), 0);

    const detailEl = document.getElementById('provinceDetailContent');
    detailEl.innerHTML = `
        <div class="province-detail">
            <div class="detail-item">
                <div class="detail-label">Bölge</div>
                <div class="detail-value">${prov?.region || '-'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Nüfus</div>
                <div class="detail-value">${formatNumber(prov?.population)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Toplam Satış (${selectedYear})</div>
                <div class="detail-value">${formatNumber(totalSales)} adet</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">İklim Bölgesi</div>
                <div class="detail-value">${prov?.climate_zone || '-'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Yıllık Yağış</div>
                <div class="detail-value">${prov?.annual_rainfall_mm ? prov.annual_rainfall_mm + ' mm' : '-'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Yükseklik</div>
                <div class="detail-value">${prov?.elevation_m ? prov.elevation_m + ' m' : '-'}</div>
            </div>
        </div>

        <div class="grid-2">
            <div class="card">
                <div class="card-header"><h3><i class="fas fa-mountain"></i> Toprak Yapısı</h3></div>
                <div class="card-body">
                    ${(soil || []).length > 0 ? soil.map(s => `
                        <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:8px;border:1px solid var(--border-color)">
                            <div style="font-weight:600;margin-bottom:6px">${s.soil_type}</div>
                            <div style="font-size:12px;color:var(--text-muted)">
                                ${s.soil_texture ? `Doku: ${s.soil_texture}` : ''}
                                ${s.ph_level ? ` | pH: ${s.ph_level}` : ''}
                                ${s.organic_matter_pct ? ` | Organik Madde: %${s.organic_matter_pct}` : ''}
                            </div>
                            ${s.recommended_hp_range ? `<div style="font-size:12px;margin-top:6px;color:var(--brand-accent)">Önerilen HP: ${s.recommended_hp_range}</div>` : ''}
                            ${s.recommended_tractor_type ? `<div style="font-size:12px;color:var(--success)">Önerilen Tip: ${translateLabel(s.recommended_tractor_type)}</div>` : ''}
                        </div>
                    `).join('') : '<div class="empty-state"><p>Toprak verisi bulunamadı</p></div>'}
                </div>
            </div>
            <div class="card">
                <div class="card-header"><h3><i class="fas fa-seedling"></i> Yetiştirilen Ekinler</h3></div>
                <div class="card-body">
                    ${(crops || []).length > 0 ? `
                        <table class="data-table">
                            <thead><tr><th>Ekin</th><th>Alan (ha)</th><th>Üretim (ton)</th><th>HP İhtiyacı</th></tr></thead>
                            <tbody>
                                ${crops.map(c => `
                                    <tr>
                                        <td style="font-weight:600">${c.crop_name}</td>
                                        <td>${formatNumber(c.cultivation_area_hectare)}</td>
                                        <td>${formatNumber(c.annual_production_tons)}</td>
                                        <td>${c.requires_hp_min || '-'} - ${c.requires_hp_max || '-'} HP</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    ` : '<div class="empty-state"><p>Ekin verisi bulunamadı</p></div>'}
                </div>
            </div>
        </div>
    `;
}

// ============================================
// WEATHER PAGE
// ============================================
async function loadWeatherPage() {
    const content = document.getElementById('pageContent');
    content.innerHTML = `
        <div class="filter-bar">
            <select id="weatherProvinceSelect" onchange="loadWeatherDetail()">
                <option value="">İl Seçin</option>
                ${allProvinces.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
            </select>
        </div>
        <div id="weatherContent">
            <div class="empty-state">
                <i class="fas fa-cloud-sun"></i>
                <h3>Hava durumu görmek için il seçin</h3>
                <p>7 günlük tahmin ve 10 yıllık iklim analizi görüntülenecek</p>
            </div>
        </div>
    `;
}

async function loadWeatherDetail() {
    const provId = document.getElementById('weatherProvinceSelect')?.value;
    if (!provId) return;

    const prov = allProvinces.find(p => p.id === parseInt(provId));
    const [weather, forecast, climate] = await Promise.all([
        API.getWeather(provId),
        API.getWeatherForecast(provId),
        API.getClimate(provId)
    ]);

    const wContent = document.getElementById('weatherContent');
    wContent.innerHTML = `
        <h3 style="margin-bottom:16px">${prov?.name} - Hava Durumu & İklim Analizi</h3>

        <div class="card">
            <div class="card-header"><h3><i class="fas fa-cloud-sun"></i> Önümüzdeki 7 Gün Tahmini</h3></div>
            <div class="card-body">
                ${(forecast || []).length > 0 ? `
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px">
                        ${forecast.map(f => `
                            <div style="text-align:center;padding:16px 8px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid var(--border-color)">
                                <div style="font-size:11px;color:var(--text-muted)">${new Date(f.date).toLocaleDateString('tr-TR', { weekday: 'short' })}</div>
                                <div style="font-size:24px;margin:8px 0">${getWeatherIcon(f.weather_condition)}</div>
                                <div style="font-size:16px;font-weight:700">${f.temp_max}°</div>
                                <div style="font-size:12px;color:var(--text-muted)">${f.temp_min}°</div>
                                ${f.rainfall_mm ? `<div style="font-size:11px;color:#06b6d4;margin-top:4px">${f.rainfall_mm}mm</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                ` : '<div class="empty-state"><p>Hava tahmini verisi bulunamadı. n8n workflow tetiklendiğinde veriler dolacaktır.</p></div>'}
            </div>
        </div>

        <div class="card">
            <div class="card-header"><h3><i class="fas fa-chart-area"></i> 10 Yıllık İklim Analizi</h3></div>
            <div class="card-body">
                ${(climate || []).length > 0 ? `
                    <div class="chart-container large"><canvas id="climateChart"></canvas></div>
                ` : '<div class="empty-state"><p>İklim analizi verisi bulunamadı. n8n AI ajanı tetiklendiğinde veriler dolacaktır.</p></div>'}
            </div>
        </div>
    `;

    if ((climate || []).length > 0) {
        const years = [...new Set(climate.map(c => c.year))].sort();
        const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];

        charts.climate = new Chart(document.getElementById('climateChart'), {
            type: 'line',
            data: {
                labels: months,
                datasets: years.slice(-5).map((year, i) => ({
                    label: year.toString(),
                    data: months.map((_, m) => {
                        const d = climate.find(c => c.year === year && c.month === m + 1);
                        return d ? parseFloat(d.avg_temp) : null;
                    }),
                    borderColor: `hsl(${i * 60}, 70%, 50%)`,
                    tension: 0.3,
                    pointRadius: 2,
                    borderWidth: 2,
                    fill: false
                }))
            },
            options: chartOptions('°C')
        });
    }
}

function getWeatherIcon(condition) {
    const icons = { sunny: '☀️', clear: '☀️', cloudy: '☁️', rain: '🌧️', snow: '❄️', storm: '⛈️', fog: '🌫️' };
    return icons[condition?.toLowerCase()] || '🌤️';
}

// ============================================
// AI INSIGHTS PAGE
// ============================================
async function loadAIInsightsPage() {
    try {
        const insights = await API.getInsights(currentUser?.brand_id);
        const content = document.getElementById('pageContent');

        content.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(96,165,250,0.15);color:#60a5fa"><i class="fas fa-robot"></i></div>
                    <div class="stat-value">${(insights || []).length}</div>
                    <div class="stat-label">Toplam AI Öngörü</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(34,197,94,0.15);color:#22c55e"><i class="fas fa-bullseye"></i></div>
                    <div class="stat-value">${(insights || []).filter(i => i.insight_type === 'recommendation').length}</div>
                    <div class="stat-label">Öneri</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(245,158,11,0.15);color:#f59e0b"><i class="fas fa-exclamation-triangle"></i></div>
                    <div class="stat-value">${(insights || []).filter(i => i.insight_type === 'warning').length}</div>
                    <div class="stat-label">Uyarı</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon" style="background:rgba(168,85,247,0.15);color:#a855f7"><i class="fas fa-lightbulb"></i></div>
                    <div class="stat-value">${(insights || []).filter(i => i.insight_type === 'opportunity').length}</div>
                    <div class="stat-label">Fırsat</div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <h3><i class="fas fa-robot"></i> AI Öngörüleri</h3>
                    <span style="font-size:12px;color:var(--text-muted)">n8n AI Ajanları tarafından oluşturuluyor</span>
                </div>
                <div class="card-body">
                    ${(insights || []).length > 0 ? insights.map(i => `
                        <div class="insight-card">
                            <div class="insight-type">${translateInsightType(i.insight_type)} ${i.confidence_score ? `| Güven: %${Math.round(i.confidence_score * 100)}` : ''}</div>
                            <div class="insight-title">${i.title}</div>
                            <div class="insight-content">${i.content}</div>
                            <div class="insight-meta">
                                ${i.brand_name ? `<span><i class="fas fa-tag"></i> ${i.brand_name}</span>` : ''}
                                ${i.province_name ? `<span><i class="fas fa-map-marker-alt"></i> ${i.province_name}</span>` : ''}
                                <span><i class="fas fa-clock"></i> ${new Date(i.created_at).toLocaleDateString('tr-TR')}</span>
                            </div>
                        </div>
                    `).join('') : `
                        <div class="empty-state">
                            <i class="fas fa-robot"></i>
                            <h3>Henüz AI öngörüsü yok</h3>
                            <p>n8n AI ajanları çalıştırıldığında burada toprak analizi, ekin önerileri, satış tahminleri ve rakip analizleri görüntülenecek</p>
                        </div>
                    `}
                </div>
            </div>
        `;
    } catch (err) {
        showError(err);
    }
}

function translateInsightType(type) {
    const map = { recommendation: '💡 Öneri', warning: '⚠️ Uyarı', opportunity: '🎯 Fırsat', analysis: '📊 Analiz', forecast: '🔮 Tahmin' };
    return map[type] || type;
}

// ============================================
// SUBSCRIPTION PAGE
// ============================================
async function loadSubscriptionPage() {
    try {
        const [plans, subscription] = await Promise.all([
            API.getPlans(),
            API.getSubscription()
        ]);

        const content = document.getElementById('pageContent');
        content.innerHTML = `
            ${subscription ? `
                <div class="card" style="margin-bottom:24px;border-color:var(--brand-primary)">
                    <div class="card-body" style="display:flex;align-items:center;gap:20px">
                        <div class="stat-icon" style="background:rgba(59,130,246,0.15);color:var(--brand-primary);width:56px;height:56px;font-size:24px;border-radius:14px;display:flex;align-items:center;justify-content:center">
                            <i class="fas fa-crown"></i>
                        </div>
                        <div style="flex:1">
                            <h3>Mevcut Plan: ${subscription.plan_name}</h3>
                            <p style="color:var(--text-muted);font-size:13px">
                                ${subscription.current_period_end ? `Bitiş: ${new Date(subscription.current_period_end).toLocaleDateString('tr-TR')}` : 'Aktif'}
                            </p>
                        </div>
                        <span style="padding:6px 12px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:6px;font-size:12px;font-weight:600">
                            ${subscription.status === 'active' ? 'Aktif' : subscription.status}
                        </span>
                    </div>
                </div>
            ` : ''}

            <div class="pricing-grid">
                ${(plans || []).map((plan, i) => `
                    <div class="pricing-card ${i === 1 ? 'featured' : ''}">
                        ${i === 1 ? '<div style="text-align:center;margin-bottom:12px"><span style="padding:4px 12px;background:var(--brand-primary);color:var(--brand-text);border-radius:20px;font-size:11px;font-weight:600">EN POPÜLER</span></div>' : ''}
                        <div class="plan-name">${plan.name}</div>
                        <div class="plan-price">₺${formatNumber(plan.price_monthly)} <span>/ ay</span></div>
                        ${plan.price_yearly ? `<div style="font-size:12px;color:var(--text-muted)">veya ₺${formatNumber(plan.price_yearly)} / yıl</div>` : ''}
                        <ul class="plan-features">
                            ${JSON.parse(plan.features || '[]').map(f => `
                                <li><i class="fas fa-check"></i> ${f}</li>
                            `).join('')}
                            <li class="${plan.has_ai_insights ? '' : 'disabled'}"><i class="fas fa-${plan.has_ai_insights ? 'check' : 'times'}"></i> AI Öngörüler</li>
                            <li class="${plan.has_competitor_analysis ? '' : 'disabled'}"><i class="fas fa-${plan.has_competitor_analysis ? 'check' : 'times'}"></i> Rakip Analizi</li>
                            <li class="${plan.has_weather_data ? '' : 'disabled'}"><i class="fas fa-${plan.has_weather_data ? 'check' : 'times'}"></i> Hava Durumu</li>
                            <li class="${plan.has_export ? '' : 'disabled'}"><i class="fas fa-${plan.has_export ? 'check' : 'times'}"></i> Excel Export</li>
                        </ul>
                        <button class="btn-subscribe ${i === 1 ? 'primary' : 'outline'}" onclick="alert('Stripe ödeme entegrasyonu yakında aktif olacak')">
                            ${subscription?.plan_id === plan.id ? 'Mevcut Plan' : 'Planı Seç'}
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        showError(err);
    }
}

// ============================================
// SETTINGS PAGE
// ============================================
async function loadSettingsPage() {
    const content = document.getElementById('pageContent');
    content.innerHTML = `
        <div class="grid-2">
            <div class="card">
                <div class="card-header"><h3><i class="fas fa-user"></i> Hesap Bilgileri</h3></div>
                <div class="card-body">
                    <div style="margin-bottom:16px">
                        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Ad Soyad</label>
                        <div style="font-size:15px;font-weight:600">${currentUser?.full_name || '-'}</div>
                    </div>
                    <div style="margin-bottom:16px">
                        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">E-posta</label>
                        <div style="font-size:15px">${currentUser?.email || '-'}</div>
                    </div>
                    <div style="margin-bottom:16px">
                        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Rol</label>
                        <div style="font-size:15px">${currentUser?.role === 'admin' ? 'Yönetici' : 'Marka Kullanıcısı'}</div>
                    </div>
                    <div style="margin-bottom:16px">
                        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Marka</label>
                        <div style="font-size:15px;color:var(--brand-primary);font-weight:600">${currentUser?.brand?.name || 'Tüm Markalar (Admin)'}</div>
                    </div>
                    <div>
                        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Şirket</label>
                        <div style="font-size:15px">${currentUser?.company_name || '-'}</div>
                    </div>
                </div>
            </div>
            <div class="card">
                <div class="card-header"><h3><i class="fas fa-palette"></i> Marka Teması</h3></div>
                <div class="card-body">
                    ${currentUser?.brand ? `
                        <div style="display:flex;gap:12px;margin-bottom:20px">
                            <div style="width:60px;height:60px;border-radius:12px;background:${currentUser.brand.primary_color}"></div>
                            <div style="width:60px;height:60px;border-radius:12px;background:${currentUser.brand.secondary_color}"></div>
                            <div style="width:60px;height:60px;border-radius:12px;background:${currentUser.brand.accent_color}"></div>
                        </div>
                        <div style="font-size:13px;color:var(--text-muted)">
                            <p>Birincil: ${currentUser.brand.primary_color}</p>
                            <p>İkincil: ${currentUser.brand.secondary_color}</p>
                            <p>Vurgu: ${currentUser.brand.accent_color}</p>
                        </div>
                    ` : '<p style="color:var(--text-muted)">Admin hesaplarında marka teması uygulanmaz</p>'}
                </div>
            </div>
        </div>
    `;
}

// ============================================
// NOTIFICATIONS
// ============================================
async function loadNotifications() {
    const panel = document.getElementById('notifPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';

    if (panel.style.display === 'flex') {
        const notifs = await API.getNotifications();
        const list = document.getElementById('notifList');
        list.innerHTML = (notifs || []).length > 0
            ? notifs.map(n => `
                <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="API.markNotificationRead(${n.id})">
                    <div class="notif-title">${n.title}</div>
                    <div class="notif-body">${n.body || ''}</div>
                    <div class="notif-time">${new Date(n.created_at).toLocaleString('tr-TR')}</div>
                </div>
            `).join('')
            : '<div class="empty-state"><p>Bildirim yok</p></div>';
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function formatNumber(num) {
    if (num == null) return '-';
    return parseInt(num).toLocaleString('tr-TR');
}

function translateLabel(label) {
    const map = {
        tarla: 'Tarla', bahce: 'Bahçe', kabinli: 'Kabinli', rollbar: 'Rollbar',
        '2WD': '2WD', '4WD': '4WD', mekanik: 'Mekanik', senkromec: 'Senkromeç',
        powershift: 'Powershift', CVT: 'CVT',
        '8+2': '8+2', '8+8': '8+8', '12+12': '12+12', '16+16': '16+16', '32+32': '32+32',
        '0-50': '0-50 HP', '51-75': '51-75 HP', '76-100': '76-100 HP', '101-150': '101-150 HP', '150+': '150+ HP'
    };
    return map[label] || label || '-';
}

function chartOptions(yLabel) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
            x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 11 } } },
            y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 11 } }, title: { display: !!yLabel, text: yLabel, color: '#64748b' } }
        },
        plugins: {
            legend: { labels: { color: '#94a3b8', padding: 12, font: { size: 11 } } },
            tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, cornerRadius: 8 }
        }
    };
}

function showError(err) {
    const content = document.getElementById('pageContent');
    content.innerHTML = `
        <div class="empty-state">
            <i class="fas fa-exclamation-circle" style="color:var(--danger)"></i>
            <h3>Bir hata oluştu</h3>
            <p>${err.message || 'Bilinmeyen hata'}</p>
            <button class="btn-filter" onclick="navigateTo(currentPage)" style="margin-top:16px">Tekrar Dene</button>
        </div>
    `;
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', init);
