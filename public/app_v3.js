// ============================================
// TRAKTÖR SEKTÖR ANALİZİ - MAIN APPLICATION
// ============================================

let currentUser = null;
let currentPage = 'dashboard';
let selectedYear = 2025; // Varsayılan: veri bulunan en son yıl
let charts = {};
let allBrands = [];
let allProvinces = [];

// Simple markdown to HTML
function mdToHtml(md) {
    if (!md) return '';
    return md
        .replace(/^### (.+)$/gm, '<h4 class="ai-h4">$1</h4>')
        .replace(/^## (.+)$/gm, '<h3 class="ai-h3">$1</h3>')
        .replace(/^# (.+)$/gm, '<h2 class="ai-h2">$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>').replace(/$/, '</p>');
}

async function requestAiAnalysis(type, context, panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = `<div class="ai-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div><span>AI analiz hazırlanıyor...</span></div>`;
    panel.style.display = 'block';
    try {
        const res = await API.getAiAnalysis(type, context);
        panel.innerHTML = `
            <div class="ai-result">
                <div class="ai-result-header"><i class="fas fa-robot"></i> AI Strateji Raporu <span class="ai-model">Llama 3.3 70B · ${res.usage?.total_tokens || 0} token</span></div>
                <div class="ai-result-body">${mdToHtml(res.analysis)}</div>
            </div>`;
    } catch (err) {
        panel.innerHTML = `<div class="ai-error"><i class="fas fa-exclamation-triangle"></i> AI analiz hatası: ${err.message}</div>`;
    }
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
    const token = localStorage.getItem('auth_token');
    if (!token) { window.location.href = '/login.html'; return; }

    try {
        currentUser = await API.me();
    } catch (err) {
        console.error('Auth check failed:', err);
        API.logout();
        return;
    }

    if (!currentUser) { API.logout(); return; }

    localStorage.setItem('user_data', JSON.stringify(currentUser));
    applyBrandTheme(currentUser.brand);
    updateUserUI();

    try {
        // Pre-load common data
        [allBrands, allProvinces] = await Promise.all([
            API.getBrands(),
            API.getProvinces()
        ]);
    } catch (err) {
        console.error('Data pre-load error (non-fatal):', err);
        allBrands = allBrands || [];
        allProvinces = allProvinces || [];
    }

    navigateTo('dashboard');
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
    if (riMapInstance) { riMapInstance.remove(); riMapInstance = null; }

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
        'brand-compare': ['Marka Karşılaştırma', 'Dinamik Marka Kıyaslama Paneli'],
        'benchmark': ['Teknik Kıyaslama', '4 Katmanlı Profesyonel Benchmarking Analizi'],
        'regional-index': ['Bölgesel Mekanizasyon', 'İl Bazlı Mekanizasyon İndeksi ve Isı Haritası'],
        'model-region': ['Model-Bölge Analizi', 'Model-Bölge Uyumluluk ve Derinlik Raporu'],
        'map-full': ['Harita 1', 'İl Bazlı Filtreleme'],
        map: ['Türkiye Haritası', 'İl Bazlı Satış Dağılımı'],
        sales: ['Satış Analizi', 'Detaylı Satış Verileri'],
        competitors: ['Rakip Analizi', 'Çok Boyutlu Karşılaştırma'],
        models: ['Model Karşılaştırma', 'Teknik Özellik Analizi'],
        province: ['İl Analizi', 'Toprak, İklim ve Ekin Verileri'],
        weather: ['Hava & İklim', 'Hava Durumu ve 10 Yıllık İklim Analizi'],
        'ai-insights': ['AI Öngörüler', 'Yapay Zeka Destekli Analizler'],
        subscription: ['Abonelik', 'Plan ve Ödeme Yönetimi'],
        tarmakbir: ['TarmakBir', 'Model Yılı Bazlı Aylık Satış Analizi'],
        tarmakbir2: ['Bütün Model Yılları', 'Marka Bazlı Aylık Satış Raporu'],
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
        'brand-compare': loadBrandComparePage,
        'benchmark': loadBenchmarkPage,
        'regional-index': loadRegionalIndexPage,
        'model-region': loadModelRegionPage,
        'map-full': loadMapFullPage,
        map: loadMapPage,
        sales: loadSalesPage,
        competitors: loadCompetitorsPage,
        models: loadModelsPage,
        province: loadProvincePage,
        weather: loadWeatherPage,
        'ai-insights': loadAIInsightsPage,
        subscription: loadSubscriptionPage,
        tarmakbir: loadTarmakBirPage,
        tarmakbir2: loadTarmakBir2Page,
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

// ============================================
// REGIONAL MECHANIZATION INDEX PAGE
// ============================================
let riMapInstance = null;
let riGeoJsonLayer = null;

async function loadRegionalIndexPage() {
    try {
        const data = await API.getRegionalIndex(selectedYear);
        if (!data) return;
        const { year, maxMonth, provinces } = data;

        const metricOpts = [
            { val: 'total', label: 'Toplam Satış' },
            { val: 'bahceRatio', label: 'Bahçe Oranı %' },
            { val: 'tarlaRatio', label: 'Tarla Oranı %' },
            { val: 'avgHp', label: 'Ortalama HP' },
            { val: 'ratio4wd', label: '4WD Oranı %' },
            { val: 'cabinRatio', label: 'Kabinli Oranı %' },
            { val: 'mechIndex', label: 'Mekanizasyon İndeksi' },
            { val: 'yoyGrowth', label: 'YoY Büyüme %' }
        ];
        const selMetric = window._riMetric || 'total';
        let metricSelHtml = metricOpts.map(o => `<option value="${o.val}" ${o.val === selMetric ? 'selected' : ''}>${o.label}</option>`).join('');

        // Sort provinces by selected metric
        const sorted = [...provinces].sort((a, b) => (b[selMetric] || 0) - (a[selMetric] || 0));

        // Top 10 table
        let top10Rows = '';
        sorted.slice(0, 15).forEach((p, i) => {
            const metricVal = p[selMetric] || 0;
            const maxVal = sorted[0]?.[selMetric] || 1;
            const barW = Math.max(5, (Math.abs(metricVal) / Math.abs(maxVal)) * 100);
            const isNeg = metricVal < 0;
            top10Rows += `<tr>
                <td class="ri-rank">${i + 1}</td>
                <td class="ri-prov-name">${p.name}</td>
                <td class="ri-val">${selMetric === 'total' ? fmtNum(metricVal) : metricVal.toFixed(1) + (selMetric.includes('Ratio') || selMetric.includes('ratio') || selMetric === 'yoyGrowth' || selMetric === 'cabinRatio' ? '%' : '')}</td>
                <td class="ri-bar-cell"><div class="ri-bar ${isNeg ? 'ri-bar-neg' : ''}" style="width:${barW}%"></div></td>
                <td class="ri-detail">${fmtNum(p.total)}</td>
                <td class="ri-detail">${p.bahceRatio.toFixed(0)}%/${p.tarlaRatio.toFixed(0)}%</td>
                <td class="ri-detail">${p.avgHp} HP</td>
                <td class="ri-detail">${p.dominantHp}</td>
                <td class="ri-detail ${p.yoyGrowth >= 0 ? 'ri-up' : 'ri-down'}">${p.yoyGrowth >= 0 ? '+' : ''}${p.yoyGrowth}%</td>
            </tr>`;
        });

        // Region summary
        const regionMap = {};
        provinces.forEach(p => {
            if (!regionMap[p.region]) regionMap[p.region] = { total: 0, bahce: 0, tarla: 0, count: 0, hpSum: 0 };
            regionMap[p.region].total += p.total;
            regionMap[p.region].bahce += p.bahce;
            regionMap[p.region].tarla += p.tarla;
            regionMap[p.region].count++;
            regionMap[p.region].hpSum += p.avgHp;
        });
        let regionRows = '';
        Object.entries(regionMap).sort((a, b) => b[1].total - a[1].total).forEach(([name, d]) => {
            const bahcePct = d.total > 0 ? (d.bahce / d.total * 100).toFixed(1) : '0';
            regionRows += `<tr>
                <td class="ri-region-name">${name}</td>
                <td>${fmtNum(d.total)}</td>
                <td>${bahcePct}%</td>
                <td>${Math.round(d.hpSum / d.count)} HP</td>
                <td>${d.count} İl</td>
            </tr>`;
        });

        document.getElementById('pageContent').innerHTML = `
        <div class="ri-container">
            <div class="ri-top-controls">
                <div class="ri-metric-sel">
                    <label>Isı Haritası Metriği:</label>
                    <select onchange="window._riMetric=this.value;loadRegionalIndexPage()">${metricSelHtml}</select>
                </div>
                <div class="ri-stat-cards">
                    <div class="ri-stat"><span class="ri-stat-val">${fmtNum(provinces.reduce((s,p)=>s+p.total,0))}</span><span class="ri-stat-lbl">${year} Toplam Satış</span></div>
                    <div class="ri-stat"><span class="ri-stat-val">${provinces.filter(p=>p.total>0).length}</span><span class="ri-stat-lbl">Aktif İl</span></div>
                    <div class="ri-stat"><span class="ri-stat-val">${Math.round(provinces.reduce((s,p)=>s+p.avgHp,0)/provinces.filter(p=>p.total>0).length)} HP</span><span class="ri-stat-lbl">Ort. HP</span></div>
                    <div class="ri-stat"><span class="ri-stat-val">${(provinces.reduce((s,p)=>s+p.bahce,0)/(provinces.reduce((s,p)=>s+p.total,0)||1)*100).toFixed(1)}%</span><span class="ri-stat-lbl">Bahçe Oranı</span></div>
                </div>
            </div>

            <div class="ri-main-grid">
                <div class="ri-map-wrap">
                    <div class="ri-section-title"><i class="fas fa-map"></i> Isı Haritası: ${metricOpts.find(o=>o.val===selMetric)?.label}</div>
                    <div id="riMapContainer" style="height:500px;border-radius:8px;"></div>
                    <div class="ri-map-legend" id="riMapLegend"></div>
                </div>
                <div class="ri-region-panel">
                    <div class="ri-section-title"><i class="fas fa-chart-bar"></i> Bölge Özeti</div>
                    <table class="ri-region-table">
                        <thead><tr><th>Bölge</th><th>Satış</th><th>Bahçe%</th><th>Ort.HP</th><th>İl</th></tr></thead>
                        <tbody>${regionRows}</tbody>
                    </table>
                </div>
            </div>

            <div class="ri-table-section">
                <div class="ri-section-title"><i class="fas fa-list-ol"></i> İl Sıralaması (${metricOpts.find(o=>o.val===selMetric)?.label})</div>
                <div style="overflow-x:auto">
                    <table class="ri-table">
                        <thead><tr>
                            <th>#</th><th>İl</th><th>${metricOpts.find(o=>o.val===selMetric)?.label}</th><th></th>
                            <th>Satış</th><th>Bahçe/Tarla</th><th>Ort.HP</th><th>Baskın HP</th><th>YoY</th>
                        </tr></thead>
                        <tbody>${top10Rows}</tbody>
                    </table>
                </div>
            </div>

            <div class="ai-action-bar">
                <button class="ai-btn" onclick="requestAiAnalysis('regional-index', {year:${year}, provinces: ${JSON.stringify(sorted.slice(0,15).map(p=>({name:p.name,region:p.region,total:p.total,bahceRatio:p.bahceRatio,tarlaRatio:p.tarlaRatio,avgHp:p.avgHp,ratio4wd:p.ratio4wd,mechIndex:p.mechIndex,yoyGrowth:p.yoyGrowth,soil_type:p.soil_type,climate_zone:p.climate_zone})))}}, 'riAiPanel')">
                    <i class="fas fa-robot"></i> AI Bölgesel Strateji Raporu
                </button>
                <span class="ai-powered">Powered by Groq · Llama 3.3 70B</span>
            </div>
            <div id="riAiPanel" class="ai-panel" style="display:none"></div>
        </div>`;

        // Initialize map
        setTimeout(() => {
            if (riMapInstance) { riMapInstance.remove(); riMapInstance = null; }
            riMapInstance = L.map('riMapContainer', { zoomControl: true, attributionControl: false }).setView([39.0, 35.5], 6);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(riMapInstance);

            // Color scale
            const vals = provinces.map(p => p[selMetric] || 0).filter(v => v !== 0);
            const minVal = Math.min(...vals, 0);
            const maxVal = Math.max(...vals, 1);

            function getColor(val) {
                if (selMetric === 'yoyGrowth') {
                    if (val > 30) return '#22c55e';
                    if (val > 10) return '#86efac';
                    if (val > 0) return '#bbf7d0';
                    if (val > -10) return '#fecaca';
                    if (val > -30) return '#f87171';
                    return '#dc2626';
                }
                const t = maxVal !== minVal ? (val - minVal) / (maxVal - minVal) : 0;
                const r = Math.round(30 + t * 225);
                const g = Math.round(120 - t * 70);
                const b = Math.round(200 - t * 150);
                return `rgb(${r},${g},${b})`;
            }

            // Add markers
            const provByName = {};
            provinces.forEach(p => { provByName[p.name.toUpperCase()] = p; });

            provinces.forEach(p => {
                if (!p.lat || !p.lng || p.total === 0) return;
                const val = p[selMetric] || 0;
                const radius = Math.max(6, Math.min(25, (p.total / (sorted[0]?.total || 1)) * 25));
                L.circleMarker([p.lat, p.lng], {
                    radius, fillColor: getColor(val), color: '#fff', weight: 1, fillOpacity: 0.85
                }).bindPopup(`
                    <div style="min-width:200px;font-size:12px;">
                        <strong style="font-size:14px">${p.name}</strong> <span style="color:#888">(${p.region})</span><hr style="margin:4px 0;border-color:#333">
                        <b>Satış:</b> ${fmtNum(p.total)} | <b>Bahçe:</b> ${p.bahceRatio.toFixed(0)}% | <b>Tarla:</b> ${p.tarlaRatio.toFixed(0)}%<br>
                        <b>Ort. HP:</b> ${p.avgHp} | <b>Baskın:</b> ${p.dominantHp}<br>
                        <b>4WD:</b> ${p.ratio4wd.toFixed(0)}% | <b>Kabinli:</b> ${p.cabinRatio.toFixed(0)}%<br>
                        <b>Mek. İndeks:</b> ${p.mechIndex} | <b>YoY:</b> ${p.yoyGrowth}%<br>
                        ${p.soil_type ? `<b>Toprak:</b> ${p.soil_type}<br>` : ''}
                        ${p.climate_zone ? `<b>İklim:</b> ${p.climate_zone}<br>` : ''}
                        ${p.primary_crops ? `<b>Ürünler:</b> ${Array.isArray(p.primary_crops) ? p.primary_crops.join(', ') : p.primary_crops}<br>` : ''}
                        <b>Trend:</b> ${p.trend.map(t => `${t.year}: ${fmtNum(t.sales)}`).join(' → ')}
                    </div>
                `).addTo(riMapInstance);
            });

            // Legend
            document.getElementById('riMapLegend').innerHTML = `
                <span style="display:inline-block;width:14px;height:14px;background:${getColor(minVal)};border-radius:3px;vertical-align:middle"></span> Düşük
                <span style="display:inline-block;width:14px;height:14px;background:${getColor((minVal+maxVal)/2)};border-radius:3px;vertical-align:middle;margin-left:8px"></span> Orta
                <span style="display:inline-block;width:14px;height:14px;background:${getColor(maxVal)};border-radius:3px;vertical-align:middle;margin-left:8px"></span> Yüksek
            `;
        }, 100);

    } catch (err) {
        showError(err);
    }
}

// ============================================
// MODEL-REGION COMPATIBILITY PAGE
// ============================================
async function loadModelRegionPage() {
    try {
        const data = await API.getModelRegion();
        if (!data) return;
        const { years, max_year, max_month, brands } = data;

        const selBrandId = window._mrBrand || (brands[0]?.id);
        let brandOpts = brands.map(b => `<option value="${b.id}" ${b.id == selBrandId ? 'selected' : ''}>${b.name}</option>`).join('');

        const brand = brands.find(b => b.id == selBrandId) || brands[0];
        if (!brand) { document.getElementById('pageContent').innerHTML = '<div class="empty-state"><p>Veri bulunamadı</p></div>'; return; }

        const topProv = brand.topProvinces || [];
        const totalSales = brand.totalSales || 0;
        const totalRev = brand.totalRevenue || 0;

        // Summary KPIs
        const avgGrowth = topProv.length > 0 ? (topProv.reduce((s, p) => s + p.yoyGrowth, 0) / topProv.length) : 0;

        // Province detail cards
        let provCards = '';
        topProv.forEach((p, i) => {
            const pctOfBrand = totalSales > 0 ? (p.total / totalSales * 100).toFixed(1) : '0';
            const bahcePct = p.total > 0 ? (p.bahce / p.total * 100).toFixed(0) : '0';
            const tarlaPct = p.total > 0 ? (p.tarla / p.total * 100).toFixed(0) : '0';

            // Trend sparkline (text-based)
            const trendStr = p.yearlyTrend.map(t => fmtNum(t.sales)).join(' → ');
            const lastTwo = p.yearlyTrend.slice(-2);
            const trendDir = lastTwo.length === 2 && lastTwo[1].sales >= lastTwo[0].sales ? 'up' : 'down';

            provCards += `
            <div class="mr-prov-card">
                <div class="mr-prov-header">
                    <span class="mr-prov-rank">${i + 1}</span>
                    <div class="mr-prov-info">
                        <span class="mr-prov-name">${p.name}</span>
                        <span class="mr-prov-region">${p.region} · ${p.plate_code}</span>
                    </div>
                    <div class="mr-prov-badge ${trendDir === 'up' ? 'mr-badge-up' : 'mr-badge-down'}">
                        <i class="fas fa-arrow-${trendDir}"></i> ${p.yoyGrowth >= 0 ? '+' : ''}${p.yoyGrowth}%
                    </div>
                </div>
                <div class="mr-prov-metrics">
                    <div class="mr-metric">
                        <span class="mr-metric-val">${fmtNum(p.total)}</span>
                        <span class="mr-metric-lbl">Toplam Satış</span>
                    </div>
                    <div class="mr-metric">
                        <span class="mr-metric-val">${fmtPrice(p.estimatedRevenue)}</span>
                        <span class="mr-metric-lbl">Tahmini Ciro</span>
                    </div>
                    <div class="mr-metric">
                        <span class="mr-metric-val">${p.marketShareCurr}%</span>
                        <span class="mr-metric-lbl">${max_year} Pazar Payı</span>
                    </div>
                    <div class="mr-metric">
                        <span class="mr-metric-val">${pctOfBrand}%</span>
                        <span class="mr-metric-lbl">Marka İçi Pay</span>
                    </div>
                </div>
                <div class="mr-prov-details">
                    <div class="mr-detail-row">
                        <span class="mr-detail-label">Kategori:</span>
                        <div class="mr-bar-wrap">
                            <div class="mr-bar mr-bar-tarla" style="width:${tarlaPct}%">${tarlaPct}% Tarla</div>
                            <div class="mr-bar mr-bar-bahce" style="width:${bahcePct}%">${bahcePct}% Bahçe</div>
                        </div>
                    </div>
                    <div class="mr-detail-row">
                        <span class="mr-detail-label">Baskın HP:</span>
                        <span class="mr-detail-val">${p.dominantHp}</span>
                    </div>
                    ${p.soil_type ? `<div class="mr-detail-row"><span class="mr-detail-label">Toprak:</span><span class="mr-detail-val">${p.soil_type}</span></div>` : ''}
                    ${p.climate_zone ? `<div class="mr-detail-row"><span class="mr-detail-label">İklim:</span><span class="mr-detail-val">${p.climate_zone}</span></div>` : ''}
                    ${p.primary_crops && p.primary_crops.length ? `<div class="mr-detail-row"><span class="mr-detail-label">Ürünler:</span><span class="mr-detail-val">${Array.isArray(p.primary_crops) ? p.primary_crops.join(', ') : p.primary_crops}</span></div>` : ''}
                    ${p.rainfall ? `<div class="mr-detail-row"><span class="mr-detail-label">Yağış:</span><span class="mr-detail-val">${p.rainfall} mm</span></div>` : ''}
                    ${p.elevation ? `<div class="mr-detail-row"><span class="mr-detail-label">Rakım:</span><span class="mr-detail-val">${fmtNum(p.elevation)} m</span></div>` : ''}
                    <div class="mr-detail-row">
                        <span class="mr-detail-label">Trend:</span>
                        <span class="mr-detail-val mr-trend-text">${trendStr}</span>
                    </div>
                </div>
            </div>`;
        });

        // Model portfolio
        let modelCards = '';
        (brand.models || []).forEach(m => {
            modelCards += `<div class="mr-model-chip">
                <span class="mr-model-name">${m.name}</span>
                <span class="mr-model-detail">${m.hp} HP · ${m.category} · ${m.price ? fmtPrice(m.price) : '-'}</span>
            </div>`;
        });

        document.getElementById('pageContent').innerHTML = `
        <div class="mr-container">
            <div class="mr-top-bar">
                <div class="mr-brand-sel">
                    <select class="bc-select" onchange="window._mrBrand=parseInt(this.value);loadModelRegionPage()">${brandOpts}</select>
                    <div class="mr-brand-badge" style="background:${brand.color}"><i class="fas fa-tractor"></i></div>
                </div>
            </div>

            <div class="mr-kpi-row">
                <div class="mr-kpi"><span class="mr-kpi-val" style="color:${brand.color}">${fmtNum(totalSales)}</span><span class="mr-kpi-lbl">Toplam Satış</span></div>
                <div class="mr-kpi"><span class="mr-kpi-val">${fmtPrice(totalRev)}</span><span class="mr-kpi-lbl">Tahmini Toplam Ciro</span></div>
                <div class="mr-kpi"><span class="mr-kpi-val">${brand.provinceCount}</span><span class="mr-kpi-lbl">Satış Yapılan İl</span></div>
                <div class="mr-kpi"><span class="mr-kpi-val">${brand.models?.length || 0}</span><span class="mr-kpi-lbl">Model Sayısı</span></div>
                <div class="mr-kpi"><span class="mr-kpi-val ${avgGrowth >= 0 ? 'ri-up' : 'ri-down'}">${avgGrowth >= 0 ? '+' : ''}${avgGrowth.toFixed(1)}%</span><span class="mr-kpi-lbl">Ort. Büyüme</span></div>
            </div>

            <div class="mr-models-section">
                <div class="ri-section-title"><i class="fas fa-th-list"></i> Model Portföyü</div>
                <div class="mr-model-grid">${modelCards || '<span style="color:var(--text-muted)">Model verisi bulunamadı</span>'}</div>
            </div>

            <div class="ai-action-bar">
                <button class="ai-btn" onclick="requestAiAnalysis('brand-region', window._mrAiContext, 'mrAiPanel')">
                    <i class="fas fa-robot"></i> AI Strateji Raporu Oluştur
                </button>
                <span class="ai-powered">Powered by Groq · Llama 3.3 70B</span>
            </div>
            <div id="mrAiPanel" class="ai-panel" style="display:none"></div>

            <div class="ri-section-title" style="margin-top:8px"><i class="fas fa-chart-line"></i> İl Bazlı Derinlik Raporu — Top ${topProv.length} İl</div>
            <div class="mr-prov-grid">${provCards}</div>
        </div>`;

        // Store AI context for later
        window._mrAiContext = {
            brandName: brand.name,
            provinces: topProv,
            models: brand.models,
            totalSales: totalSales,
            totalRevenue: totalRev
        };

    } catch (err) {
        showError(err);
    }
}

// ============================================
// BRAND COMPARE PAGE
// ============================================
function fmtNum(n) {
    if (n == null || isNaN(n)) return '-';
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' M';
    if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + ' B';
    return n.toLocaleString('tr-TR');
}
function fmtPrice(n) {
    if (!n || n === 0) return '-';
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' M ₺';
    if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + ' B ₺';
    return n.toLocaleString('tr-TR') + ' ₺';
}
function fmtPct(n, dec = 1) { return n != null ? n.toFixed(dec) + '%' : '-'; }

async function loadBrandComparePage() {
    try {
        if (!allBrands || allBrands.length === 0) allBrands = await API.getBrands();
        const b1Id = window._bc_brand1 || (allBrands[0]?.id);
        const b2Id = window._bc_brand2 || (allBrands[1]?.id || allBrands[0]?.id);

        // Seed models if needed (one-time)
        try { await API.seedModels(); } catch(e) {}

        const data = await API.getBrandCompare(b1Id, b2Id);
        if (!data) return;

        const { brand1, brand2, years, max_year, max_month, prev_year, total_market } = data;
        const d1 = brand1.data, d2 = brand2.data;
        const monthNames = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];

        let b1Opts = '', b2Opts = '';
        allBrands.forEach(b => {
            b1Opts += `<option value="${b.id}" ${b.id == b1Id ? 'selected' : ''}>${b.name}</option>`;
            b2Opts += `<option value="${b.id}" ${b.id == b2Id ? 'selected' : ''}>${b.name}</option>`;
        });

        // Winner helper
        function win(v1, v2, higher = true) {
            if (v1 === v2) return ['', ''];
            return higher ? (v1 > v2 ? ['bc-winner', ''] : ['', 'bc-winner']) : (v1 < v2 ? ['bc-winner', ''] : ['', 'bc-winner']);
        }

        // KPI cards data
        const kpis = [
            { label: `${max_year} Satış (İlk ${max_month} Ay)`, v1: d1.currPartial, v2: d2.currPartial, fmt: fmtNum, higher: true },
            { label: `${prev_year} Satış (İlk ${max_month} Ay)`, v1: d1.prevPartial, v2: d2.prevPartial, fmt: fmtNum, higher: true },
            { label: 'YoY Büyüme', v1: d1.yoyGrowth, v2: d2.yoyGrowth, fmt: fmtPct, higher: true },
            { label: `Pazar Payı (${max_year})`, v1: d1.marketShare[max_year], v2: d2.marketShare[max_year], fmt: fmtPct, higher: true },
            { label: 'Ort. Fiyat', v1: d1.avgPrice, v2: d2.avgPrice, fmt: fmtPrice, higher: false },
            { label: 'Min Fiyat', v1: d1.minPrice, v2: d2.minPrice, fmt: fmtPrice, higher: false },
            { label: 'Max Fiyat', v1: d1.maxPrice, v2: d2.maxPrice, fmt: fmtPrice, higher: false },
            { label: 'Model Sayısı', v1: d1.models.length, v2: d2.models.length, fmt: fmtNum, higher: true }
        ];

        let kpiRows = '';
        kpis.forEach(k => {
            const [w1, w2] = win(k.v1, k.v2, k.higher);
            kpiRows += `<tr>
                <td class="bc-kpi-val ${w1}">${k.fmt(k.v1)}</td>
                <td class="bc-kpi-label">${k.label}</td>
                <td class="bc-kpi-val ${w2}">${k.fmt(k.v2)}</td>
            </tr>`;
        });

        // Yearly trend table
        let yearHeaders = '', yearRow1 = '', yearRow2 = '', yearRowMkt = '';
        years.forEach(y => {
            yearHeaders += `<th>${y}</th>`;
            yearRow1 += `<td>${fmtNum(d1.yearly[y])}</td>`;
            yearRow2 += `<td>${fmtNum(d2.yearly[y])}</td>`;
            yearRowMkt += `<td>${fmtNum(total_market[y])}</td>`;
        });

        // Monthly trend for chart
        const monthLabels = [];
        const monthD1 = [], monthD2 = [];
        for (let m = 1; m <= max_month; m++) {
            monthLabels.push(monthNames[m - 1]);
            monthD1.push(d1.monthly[m] || 0);
            monthD2.push(d2.monthly[m] || 0);
        }

        // Market share trend for chart
        const shareLabels = years.map(String);
        const shareD1 = years.map(y => d1.marketShare[y]?.toFixed(1) || 0);
        const shareD2 = years.map(y => d2.marketShare[y]?.toFixed(1) || 0);

        // HP distribution comparison
        const allHpSet = new Set();
        d1.hpDist.forEach(h => allHpSet.add(h.hp));
        d2.hpDist.forEach(h => allHpSet.add(h.hp));
        const hpOrder = ['1-39','40-49','50-54','55-59','60-69','70-79','80-89','90-99','100-109','110-119','120+'];
        const sortedHp = hpOrder.filter(h => allHpSet.has(h));
        const hpMap1 = {}, hpMap2 = {};
        d1.hpDist.forEach(h => { hpMap1[h.hp] = h; });
        d2.hpDist.forEach(h => { hpMap2[h.hp] = h; });

        let hpRows = '';
        sortedHp.forEach(hp => {
            const h1 = hpMap1[hp] || { qty: 0, pct: 0 };
            const h2 = hpMap2[hp] || { qty: 0, pct: 0 };
            hpRows += `<tr>
                <td class="bc-hp-val">${fmtNum(h1.qty)}<span class="bc-sub">${fmtPct(h1.pct)}</span></td>
                <td class="bc-hp-label">${hp} HP</td>
                <td class="bc-hp-val">${fmtNum(h2.qty)}<span class="bc-sub">${fmtPct(h2.pct)}</span></td>
            </tr>`;
        });

        // Top provinces
        let provRows = '';
        const maxProv = Math.max(d1.topProvinces.length, d2.topProvinces.length);
        for (let i = 0; i < maxProv; i++) {
            const p1 = d1.topProvinces[i], p2 = d2.topProvinces[i];
            provRows += `<tr>
                <td class="bc-prov-val">${p1 ? `${p1.name} <span class="bc-sub">${fmtNum(p1.qty)}</span>` : '-'}</td>
                <td class="bc-prov-rank">${i + 1}</td>
                <td class="bc-prov-val">${p2 ? `${p2.name} <span class="bc-sub">${fmtNum(p2.qty)}</span>` : '-'}</td>
            </tr>`;
        }

        // Category split
        const cat1Total = (d1.categories.tarla || 0) + (d1.categories.bahce || 0);
        const cat2Total = (d2.categories.tarla || 0) + (d2.categories.bahce || 0);
        const cat1TarlaPct = cat1Total > 0 ? ((d1.categories.tarla || 0) / cat1Total * 100) : 0;
        const cat1BahcePct = cat1Total > 0 ? ((d1.categories.bahce || 0) / cat1Total * 100) : 0;
        const cat2TarlaPct = cat2Total > 0 ? ((d2.categories.tarla || 0) / cat2Total * 100) : 0;
        const cat2BahcePct = cat2Total > 0 ? ((d2.categories.bahce || 0) / cat2Total * 100) : 0;

        // Drive type split
        const drv1_4wd = d1.driveTypes['4WD'] || 0;
        const drv1_2wd = d1.driveTypes['2WD'] || 0;
        const drv1Total = drv1_4wd + drv1_2wd;
        const drv2_4wd = d2.driveTypes['4WD'] || 0;
        const drv2_2wd = d2.driveTypes['2WD'] || 0;
        const drv2Total = drv2_4wd + drv2_2wd;

        // Price comparison table - match models by similar HP
        let priceRows = '';
        const m1 = d1.models.filter(m => m.price > 0);
        const m2 = d2.models.filter(m => m.price > 0);
        // Group by HP range for price comparison
        const priceHpRanges = {};
        m1.forEach(m => {
            const hr = m.hp < 40 ? '1-39' : m.hp < 50 ? '40-49' : m.hp < 55 ? '50-54' : m.hp < 60 ? '55-59' : m.hp < 70 ? '60-69' : m.hp < 80 ? '70-79' : m.hp < 90 ? '80-89' : m.hp < 100 ? '90-99' : m.hp < 110 ? '100-109' : m.hp < 120 ? '110-119' : '120+';
            if (!priceHpRanges[hr]) priceHpRanges[hr] = { m1: [], m2: [] };
            priceHpRanges[hr].m1.push(m);
        });
        m2.forEach(m => {
            const hr = m.hp < 40 ? '1-39' : m.hp < 50 ? '40-49' : m.hp < 55 ? '50-54' : m.hp < 60 ? '55-59' : m.hp < 70 ? '60-69' : m.hp < 80 ? '70-79' : m.hp < 90 ? '80-89' : m.hp < 100 ? '90-99' : m.hp < 110 ? '100-109' : m.hp < 120 ? '110-119' : '120+';
            if (!priceHpRanges[hr]) priceHpRanges[hr] = { m1: [], m2: [] };
            priceHpRanges[hr].m2.push(m);
        });

        hpOrder.forEach(hr => {
            const g = priceHpRanges[hr];
            if (!g) return;
            const maxLen = Math.max(g.m1.length, g.m2.length);
            for (let i = 0; i < maxLen; i++) {
                const p1 = g.m1[i], p2 = g.m2[i];
                const price1 = p1?.price || 0, price2 = p2?.price || 0;
                const diff = (price1 && price2) ? price1 - price2 : null;
                const diffClass = diff ? (diff < 0 ? 'bc-cheaper' : diff > 0 ? 'bc-expensive' : '') : '';
                priceRows += `<tr>
                    <td class="bc-model-cell">${p1 ? `<span class="bc-model-name">${p1.name}</span><span class="bc-model-hp">${p1.hp} HP</span>` : '-'}</td>
                    <td class="bc-price-cell ${price1 && price2 && price1 <= price2 ? 'bc-cheaper' : ''}">${p1 ? fmtPrice(price1) : '-'}</td>
                    <td class="bc-hp-range-cell">${i === 0 ? hr + ' HP' : ''}</td>
                    <td class="bc-price-cell ${price1 && price2 && price2 <= price1 ? 'bc-cheaper' : ''}">${p2 ? fmtPrice(price2) : '-'}</td>
                    <td class="bc-model-cell">${p2 ? `<span class="bc-model-name">${p2.name}</span><span class="bc-model-hp">${p2.hp} HP</span>` : '-'}</td>
                </tr>`;
            }
        });

        document.getElementById('pageContent').innerHTML = `
        <div class="bc-container">
            <!-- Brand Selectors -->
            <div class="bc-selectors">
                <div class="bc-sel-left">
                    <div class="bc-brand-badge" style="background:${brand1.primary_color}"><i class="fas fa-tractor"></i></div>
                    <select class="bc-select" onchange="window._bc_brand1=parseInt(this.value);loadBrandComparePage()">${b1Opts}</select>
                </div>
                <div class="bc-vs">VS</div>
                <div class="bc-sel-right">
                    <select class="bc-select" onchange="window._bc_brand2=parseInt(this.value);loadBrandComparePage()">${b2Opts}</select>
                    <div class="bc-brand-badge" style="background:${brand2.primary_color}"><i class="fas fa-tractor"></i></div>
                </div>
            </div>

            <!-- KPI Comparison -->
            <div class="bc-section">
                <div class="bc-section-title"><i class="fas fa-chart-line"></i> Temel Göstergeler</div>
                <table class="bc-kpi-table">
                    <thead>
                        <tr>
                            <th style="color:${brand1.primary_color}">${brand1.name}</th>
                            <th class="bc-kpi-mid">Metrik</th>
                            <th style="color:${brand2.primary_color}">${brand2.name}</th>
                        </tr>
                    </thead>
                    <tbody>${kpiRows}</tbody>
                </table>
            </div>

            <!-- Charts Row -->
            <div class="bc-charts-row">
                <div class="bc-chart-card">
                    <div class="bc-chart-title"><i class="fas fa-chart-bar"></i> ${max_year} Aylık Satış Trendi</div>
                    <div style="position:relative;height:280px;"><canvas id="bcMonthlyChart"></canvas></div>
                </div>
                <div class="bc-chart-card">
                    <div class="bc-chart-title"><i class="fas fa-percentage"></i> Pazar Payı Trendi</div>
                    <div style="position:relative;height:280px;"><canvas id="bcShareChart"></canvas></div>
                </div>
            </div>

            <!-- Yearly Sales -->
            <div class="bc-section">
                <div class="bc-section-title"><i class="fas fa-calendar-alt"></i> Yıllık Satış Karşılaştırması</div>
                <div style="overflow-x:auto">
                    <table class="bc-year-table">
                        <thead><tr><th>Marka</th>${yearHeaders}</tr></thead>
                        <tbody>
                            <tr class="bc-row-market"><td>Toplam Pazar</td>${yearRowMkt}</tr>
                            <tr style="color:${brand1.primary_color}"><td>${brand1.name}</td>${yearRow1}</tr>
                            <tr style="color:${brand2.primary_color}"><td>${brand2.name}</td>${yearRow2}</tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Middle panels row -->
            <div class="bc-panels-row">
                <!-- HP Distribution -->
                <div class="bc-panel">
                    <div class="bc-section-title"><i class="fas fa-horse-head"></i> HP Segment Dağılımı</div>
                    <table class="bc-mirror-table">
                        <thead><tr>
                            <th style="color:${brand1.primary_color}">${brand1.name}</th>
                            <th class="bc-mid-col">Segment</th>
                            <th style="color:${brand2.primary_color}">${brand2.name}</th>
                        </tr></thead>
                        <tbody>${hpRows}</tbody>
                    </table>
                </div>

                <!-- Top Provinces -->
                <div class="bc-panel">
                    <div class="bc-section-title"><i class="fas fa-map-marker-alt"></i> En Çok Satılan İller</div>
                    <table class="bc-mirror-table">
                        <thead><tr>
                            <th style="color:${brand1.primary_color}">${brand1.name}</th>
                            <th class="bc-mid-col">#</th>
                            <th style="color:${brand2.primary_color}">${brand2.name}</th>
                        </tr></thead>
                        <tbody>${provRows}</tbody>
                    </table>
                </div>

                <!-- Category & Drive -->
                <div class="bc-panel">
                    <div class="bc-section-title"><i class="fas fa-sliders-h"></i> Kategori & Çekiş</div>
                    <table class="bc-mirror-table">
                        <thead><tr>
                            <th style="color:${brand1.primary_color}">${brand1.name}</th>
                            <th class="bc-mid-col">Özellik</th>
                            <th style="color:${brand2.primary_color}">${brand2.name}</th>
                        </tr></thead>
                        <tbody>
                            <tr>
                                <td class="bc-bar-cell"><div class="bc-bar" style="width:${cat1TarlaPct}%;background:${brand1.primary_color}">${fmtPct(cat1TarlaPct,0)}</div></td>
                                <td class="bc-mid-label">Tarla</td>
                                <td class="bc-bar-cell"><div class="bc-bar" style="width:${cat2TarlaPct}%;background:${brand2.primary_color}">${fmtPct(cat2TarlaPct,0)}</div></td>
                            </tr>
                            <tr>
                                <td class="bc-bar-cell"><div class="bc-bar bc-bar-alt" style="width:${cat1BahcePct}%;background:${brand1.primary_color}88">${fmtPct(cat1BahcePct,0)}</div></td>
                                <td class="bc-mid-label">Bahçe</td>
                                <td class="bc-bar-cell"><div class="bc-bar bc-bar-alt" style="width:${cat2BahcePct}%;background:${brand2.primary_color}88">${fmtPct(cat2BahcePct,0)}</div></td>
                            </tr>
                            <tr>
                                <td class="bc-bar-cell"><div class="bc-bar" style="width:${drv1Total > 0 ? drv1_4wd/drv1Total*100 : 0}%;background:#22c55e">${drv1Total > 0 ? fmtPct(drv1_4wd/drv1Total*100,0) : '-'}</div></td>
                                <td class="bc-mid-label">4WD</td>
                                <td class="bc-bar-cell"><div class="bc-bar" style="width:${drv2Total > 0 ? drv2_4wd/drv2Total*100 : 0}%;background:#22c55e">${drv2Total > 0 ? fmtPct(drv2_4wd/drv2Total*100,0) : '-'}</div></td>
                            </tr>
                            <tr>
                                <td class="bc-bar-cell"><div class="bc-bar bc-bar-alt" style="width:${drv1Total > 0 ? drv1_2wd/drv1Total*100 : 0}%;background:#f59e0b88">${drv1Total > 0 ? fmtPct(drv1_2wd/drv1Total*100,0) : '-'}</div></td>
                                <td class="bc-mid-label">2WD</td>
                                <td class="bc-bar-cell"><div class="bc-bar bc-bar-alt" style="width:${drv2Total > 0 ? drv2_2wd/drv2Total*100 : 0}%;background:#f59e0b88">${drv2Total > 0 ? fmtPct(drv2_2wd/drv2Total*100,0) : '-'}</div></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Price Comparison -->
            <div class="bc-section">
                <div class="bc-section-title"><i class="fas fa-tag"></i> Fiyat Karşılaştırması (Liste Fiyatı)</div>
                <div style="overflow-x:auto">
                    <table class="bc-price-table">
                        <thead><tr>
                            <th style="color:${brand1.primary_color}">Model</th>
                            <th style="color:${brand1.primary_color}">Fiyat</th>
                            <th>HP Segment</th>
                            <th style="color:${brand2.primary_color}">Fiyat</th>
                            <th style="color:${brand2.primary_color}">Model</th>
                        </tr></thead>
                        <tbody>${priceRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Model fiyat verisi bulunamadı</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div class="ai-action-bar">
                <button class="ai-btn" onclick="requestAiAnalysis('brand-compare', {brand1:'${brand1.name}',brand2:'${brand2.name}',data1:${JSON.stringify({currPartial:d1.currPartial,prevPartial:d1.prevPartial,yoyGrowth:d1.yoyGrowth,marketShare:d1.marketShare,avgPrice:d1.avgPrice,models:d1.models})},data2:${JSON.stringify({currPartial:d2.currPartial,prevPartial:d2.prevPartial,yoyGrowth:d2.yoyGrowth,marketShare:d2.marketShare,avgPrice:d2.avgPrice,models:d2.models})},maxYear:${max_year}}, 'bcAiPanel')">
                    <i class="fas fa-robot"></i> AI Karşılaştırma Raporu
                </button>
                <span class="ai-powered">Powered by Groq · Llama 3.3 70B</span>
            </div>
            <div id="bcAiPanel" class="ai-panel" style="display:none"></div>
        </div>`;

        // Monthly chart
        charts.bcMonthly = new Chart(document.getElementById('bcMonthlyChart'), {
            type: 'bar',
            data: {
                labels: monthLabels,
                datasets: [
                    { label: brand1.name, data: monthD1, backgroundColor: brand1.primary_color + 'cc', borderColor: brand1.primary_color, borderWidth: 1, borderRadius: 4 },
                    { label: brand2.name, data: monthD2, backgroundColor: brand2.primary_color + 'cc', borderColor: brand2.primary_color, borderWidth: 1, borderRadius: 4 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } }, datalabels: { display: false } },
                scales: {
                    x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: '#64748b', callback: v => fmtNum(v) }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        });

        // Share chart
        charts.bcShare = new Chart(document.getElementById('bcShareChart'), {
            type: 'line',
            data: {
                labels: shareLabels,
                datasets: [
                    { label: brand1.name, data: shareD1, borderColor: brand1.primary_color, backgroundColor: brand1.primary_color + '33', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: brand1.primary_color },
                    { label: brand2.name, data: shareD2, borderColor: brand2.primary_color, backgroundColor: brand2.primary_color + '33', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: brand2.primary_color }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } }, datalabels: { display: false } },
                scales: {
                    x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: '#64748b', callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        });

    } catch (err) {
        showError(err);
    }
}

// ============================================
// TARMAKBIR PAGE - Model Yılı Bazlı Aylık Satış
// ============================================
let tarmakbirSelectedYear = null;

async function loadTarmakBirPage() {
    try {
        const targetYear = tarmakbirSelectedYear || selectedYear;
        const data = await API.getTarmakBir(targetYear);
        if (!data) return;

        const { selected_year, registration_years, months_data, model_breakdown, max_month, available_years } = data;
        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

        // Year selector options
        let yearOptions = '';
        (available_years || []).forEach(y => {
            yearOptions += `<option value="${y}" ${y === selected_year ? 'selected' : ''}>${y}</option>`;
        });

        // --- Build Table ---
        // Header: Yıl | 1 | 2 | ... | 12 | Toplam
        let headerCells = '<th class="tb-header-label">Yıl</th>';
        for (let m = 1; m <= 12; m++) {
            headerCells += `<th class="tb-month-header">${m}</th>`;
        }
        headerCells += '<th class="tb-total-header">Toplam</th>';

        // Data rows - 2 registration years
        let bodyRows = '';
        const rowColors = ['#2563eb', '#7c3aed', '#f59e0b', '#06b6d4', '#22c55e'];
        registration_years.forEach((ry, idx) => {
            const rowData = months_data[ry] || {};
            let rowTotal = 0;
            let cells = `<td class="tb-year-cell" style="color:${rowColors[idx % rowColors.length]}; font-weight:700;">${ry}</td>`;
            
            for (let m = 1; m <= 12; m++) {
                const val = rowData[m] || 0;
                rowTotal += val;
                const hasData = val > 0;
                const opacity = hasData ? 1 : 0.3;
                cells += `<td class="tb-data-cell" style="opacity:${opacity}">${hasData ? val.toLocaleString('tr-TR') : '-'}</td>`;
            }
            cells += `<td class="tb-total-cell">${rowTotal > 0 ? rowTotal.toLocaleString('tr-TR') : '-'}</td>`;
            
            bodyRows += `<tr class="tb-data-row ${idx === 0 ? 'tb-row-primary' : 'tb-row-secondary'}">${cells}</tr>`;
        });

        // Delta row (fark)
        if (registration_years.length >= 2) {
            const curr = months_data[registration_years[0]] || {};
            const prev = months_data[registration_years[1]] || {};
            let deltaCells = '<td class="tb-year-cell" style="font-weight:700; color:#f59e0b;">Δ Fark</td>';
            let totalCurr = 0, totalPrev = 0;
            
            for (let m = 1; m <= 12; m++) {
                const c = curr[m] || 0;
                const p = prev[m] || 0;
                totalCurr += c;
                totalPrev += p;
                const diff = c - p;
                if (c === 0 && p === 0) {
                    deltaCells += '<td class="tb-data-cell" style="opacity:0.3">-</td>';
                } else {
                    const cls = diff >= 0 ? 'tb-delta-pos' : 'tb-delta-neg';
                    const arrow = diff >= 0 ? '▲' : '▼';
                    deltaCells += `<td class="tb-data-cell ${cls}">${arrow} ${Math.abs(diff).toLocaleString('tr-TR')}</td>`;
                }
            }
            const totalDiff = totalCurr - totalPrev;
            const totalCls = totalDiff >= 0 ? 'tb-delta-pos' : 'tb-delta-neg';
            const totalArrow = totalDiff >= 0 ? '▲' : '▼';
            deltaCells += `<td class="tb-total-cell ${totalCls}">${totalArrow} ${Math.abs(totalDiff).toLocaleString('tr-TR')}</td>`;
            bodyRows += `<tr class="tb-delta-row">${deltaCells}</tr>`;

            // % Değişim row
            let pctCells = '<td class="tb-year-cell" style="font-weight:700; color:#06b6d4;">% Değişim</td>';
            for (let m = 1; m <= 12; m++) {
                const c = curr[m] || 0;
                const p = prev[m] || 0;
                if (p === 0 && c === 0) {
                    pctCells += '<td class="tb-data-cell" style="opacity:0.3">-</td>';
                } else if (p === 0) {
                    pctCells += '<td class="tb-data-cell tb-delta-pos">YENİ</td>';
                } else {
                    const pct = ((c - p) * 100 / p).toFixed(1);
                    const cls = parseFloat(pct) >= 0 ? 'tb-delta-pos' : 'tb-delta-neg';
                    pctCells += `<td class="tb-data-cell ${cls}">%${pct}</td>`;
                }
            }
            if (totalPrev === 0 && totalCurr > 0) {
                pctCells += '<td class="tb-total-cell tb-delta-pos">YENİ</td>';
            } else if (totalPrev > 0) {
                const totalPct = ((totalCurr - totalPrev) * 100 / totalPrev).toFixed(1);
                const totalPctCls = parseFloat(totalPct) >= 0 ? 'tb-delta-pos' : 'tb-delta-neg';
                pctCells += `<td class="tb-total-cell ${totalPctCls}">%${totalPct}</td>`;
            } else {
                pctCells += '<td class="tb-total-cell" style="opacity:0.3">-</td>';
            }
            bodyRows += `<tr class="tb-pct-row">${pctCells}</tr>`;
        }

        // --- Chart Data ---
        const chartLabels = [];
        const chartDataCurr = [];
        const chartDataPrev = [];
        for (let m = 1; m <= 12; m++) {
            chartLabels.push(monthNames[m - 1]);
            chartDataCurr.push((months_data[registration_years[0]] || {})[m] || 0);
            if (registration_years.length > 1) {
                chartDataPrev.push((months_data[registration_years[1]] || {})[m] || 0);
            }
        }

        // --- Build Model Breakdown Table ---
        let modelRows = '';
        const mRowColors = ['#ec4899', '#f97316', '#22c55e', '#ef4444'];
        Object.keys(model_breakdown).sort((a,b) => b-a).forEach((my, idx) => {
            const rowData = model_breakdown[my] || {};
            let rowTotal = 0;
            let cells = `<td class="tb-year-cell" style="color:${mRowColors[idx % mRowColors.length]}; font-weight:700;">Model Yılı ${my}</td>`;
            for (let m = 1; m <= 12; m++) {
                const val = rowData[m] || 0;
                rowTotal += val;
                cells += `<td class="tb-data-cell">${val > 0 ? val.toLocaleString('tr-TR') : '-'}</td>`;
            }
            cells += `<td class="tb-total-cell">${rowTotal.toLocaleString('tr-TR')}</td>`;
            modelRows += `<tr class="tb-item-row">${cells}</tr>`;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="tb-container">
                <div class="tm-top-bar">
                    <div>
                        <h2><i class="fas fa-warehouse" style="margin-right:8px;color:var(--brand-primary)"></i>TarmakBir - [GÜNCEL] Toplam Market Analizi</h2>
                        <p>Dinamik Tarihsel Kıyaslama ve Model Yılı Detayı</p>
                    </div>
                    <div style="display:flex;gap:12px;align-items:center;">
                        <label style="color:var(--text-muted);font-size:13px;">Kırılım Yılı:</label>
                        <select id="tarmakbirYearFilter" class="year-select" onchange="reloadTarmakBir()" style="min-width:120px;">
                            ${yearOptions}
                        </select>
                    </div>
                </div>

                <!-- Chart -->
                <div class="chart-card" style="padding:24px; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;"><i class="fas fa-chart-bar" style="margin-right:8px;color:#3b82f6"></i>Tescil Yılı Kıyaslaması (${registration_years.slice(0,2).join(' & ')})</h3>
                    <div style="position:relative;height:350px;"><canvas id="tarmakbirChart"></canvas></div>
                </div>

                <!-- MAIN TABLE: HISTORICAL COMPARISON -->
                <div class="chart-card tb-table-card" style="padding:24px; overflow-x:auto; margin-bottom:24px;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;"><i class="fas fa-history" style="margin-right:8px;color:#8b5cf6"></i>Tüm Yıllar Tescil Dağılım Tablosu</h3>
                    <table class="tb-table">
                        <thead><tr>${headerCells}</tr></thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                </div>

                <!-- SECONDARY TABLE: MODEL YEAR BREAKDOWN -->
                <div class="chart-card tb-table-card" style="padding:24px; overflow-x:auto;">
                    <h3 style="color:var(--text-primary);margin:0 0 16px;"><i class="fas fa-tags" style="margin-right:8px;color:#ec4899"></i>${selected_year} Yılı Model Yılı Bazlı Detay</h3>
                    <table class="tb-table">
                        <thead><tr>${headerCells}</tr></thead>
                        <tbody>${modelRows}</tbody>
                    </table>
                </div>
            </div>
        `;

        // Render Chart
        const ctx = document.getElementById('tarmakbirChart').getContext('2d');
        const datasets = [
            {
                label: `${registration_years[0]} Yılı`,
                data: chartDataCurr,
                backgroundColor: 'rgba(37,99,235,0.8)',
                borderColor: '#2563eb',
                borderWidth: 1,
                borderRadius: 6
            }
        ];
        if (registration_years.length > 1) {
            datasets.push({
                label: `${registration_years[1]} Yılı`,
                data: chartDataPrev,
                backgroundColor: 'rgba(124,58,237,0.6)',
                borderColor: '#7c3aed',
                borderWidth: 1,
                borderRadius: 6
            });
        }

        charts.tarmakbir = new Chart(ctx, {
            type: 'bar',
            data: { labels: chartLabels, datasets },
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
                    },
                    datalabels: { display: false }
                },
                scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
                    y: {
                        beginAtZero: true,
                        ticks: { color: '#94a3b8', callback: v => v.toLocaleString('tr-TR') },
                        grid: { color: 'rgba(148,163,184,0.08)' },
                        title: { display: true, text: 'Satış Adet', color: '#94a3b8' }
                    }
                }
            }
        });

    } catch (err) {
        showError(err);
    }
}

function reloadTarmakBir() {
    tarmakbirSelectedYear = parseInt(document.getElementById('tarmakbirYearFilter')?.value) || null;
    API.clearCache();
    Object.values(charts).forEach(c => c.destroy?.());
    charts = {};
    loadTarmakBirPage();
}

// ============================================
// TARMAKBIR2 PAGE - Bütün Model Yılları
// ============================================
let tarmakbir2SelectedYear = null;

async function loadTarmakBir2Page() {
    try {
        const targetYear = tarmakbir2SelectedYear || selectedYear;
        const data = await API.get(`/api/sales/tarmakbir-total?year=${targetYear}`);
        if (!data) return;

        const { selected_year, brands_data, months_total, grand_total, available_years } = data;
        const monthNames = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

        let yearOptions = '';
        available_years.forEach(y => {
            yearOptions += `<option value="${y}" ${y === selected_year ? 'selected' : ''}>${y}</option>`;
        });

        // --- Build Table ---
        // Header
        let headerCells = '<th>Markası</th>';
        for (let m = 1; m <= 12; m++) headerCells += `<th>${monthNames[m-1]}</th>`;
        headerCells += '<th>G.Toplam</th>';

        // G.Toplam Row (Top row in screenshot)
        let totalRow = '<tr class="tb2-total-row"><td>G.Toplam</td>';
        for (let m = 1; m <= 12; m++) {
            totalRow += `<td>${months_total[m] > 0 ? months_total[m].toLocaleString('tr-TR') : '-'}</td>`;
        }
        totalRow += `<td>${grand_total.toLocaleString('tr-TR')}</td></tr>`;

        // Brand Rows
        let brandRows = '';
        Object.keys(brands_data).sort().forEach(b => {
           const row = brands_data[b];
           let cells = `<td>${b}</td>`;
           for(let m=1; m<=12; m++) {
               cells += `<td>${row[m] > 0 ? row[m].toLocaleString('tr-TR') : ''}</td>`;
           }
           cells += `<td class="tb2-brand-total">${row[0].toLocaleString('tr-TR')}</td>`;
           brandRows += `<tr>${cells}</tr>`;
        });

        document.getElementById('pageContent').innerHTML = `
            <div class="tb-container">
                <div class="tm-top-bar">
                    <div>
                        <h2>Bütün Model Yılları</h2>
                        <p>${selected_year} Yılı Marka Bazlı Satış Adetleri (Model Yılı Sınırlaması Olmadan)</p>
                    </div>
                    <div style="display:flex;gap:12px;align-items:center;">
                        <label style="color:var(--text-muted);font-size:13px;">Veri Yılı:</label>
                        <select id="tarmakbir2YearFilter" class="year-select" onchange="reloadTarmakBir2()">
                            ${yearOptions}
                        </select>
                    </div>
                </div>

                <div class="card" style="margin-top:16px;">
                    <div class="card-body" style="overflow-x:auto; padding:0;">
                        <table class="tb2-table">
                            <thead><tr>${headerCells}</tr></thead>
                            <tbody>
                                ${totalRow}
                                ${brandRows}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

    } catch (err) {
        showError(err);
    }
}

function reloadTarmakBir2() {
    tarmakbir2SelectedYear = parseInt(document.getElementById('tarmakbir2YearFilter')?.value) || null;
    API.clearCache();
    loadTarmakBir2Page();
}

// ============================================
// ERROR HANDLER
// ============================================
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
