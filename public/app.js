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

    const titles = {
        dashboard: ['Dashboard', 'Genel Bakış'],
        historical: ['Tarihsel Gelişim', 'Traktör Pazarı Yıllık Analiz'],
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
