'use strict';
// Weather / climate / soil / crops / province-intelligence routes and their private
// helpers, moved verbatim from server.js. Registration order is preserved by the
// caller (server.js calls this at the original position).
module.exports = function registerGeo(app, ctx) {
    const { pool, authMiddleware, normalizeSearchText, roundMetric, calculateYoY } = ctx;

    // ============================================
    // WEATHER
    // ============================================
    app.get('/api/weather/:province_id', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM weather_data WHERE province_id = $1
                ORDER BY date DESC LIMIT 14
            `, [req.params.province_id]);
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.get('/api/weather/:province_id/forecast', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM weather_data WHERE province_id = $1 AND is_forecast = true
                ORDER BY date ASC LIMIT 7
            `, [req.params.province_id]);
            if (result.rows.length) {
                return res.json(result.rows);
            }

            const province = await getEnrichedProvinceById(req.params.province_id);
            if (!province) {
                return res.json([]);
            }

            const referenceProfile = getProvinceReferenceArchetype(province);
            return res.json(buildProvinceReferenceForecastRows(province, referenceProfile));
        } catch (err) {
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // CLIMATE ANALYSIS (10 Year)
    // ============================================
    app.get('/api/climate/:province_id', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT * FROM climate_analysis WHERE province_id = $1
                ORDER BY year DESC, month
            `, [req.params.province_id]);
            if (result.rows.length) {
                return res.json(result.rows);
            }

            const province = await getEnrichedProvinceById(req.params.province_id);
            if (!province) {
                return res.json([]);
            }

            const referenceProfile = getProvinceReferenceArchetype(province);
            return res.json(buildProvinceReferenceClimateRows(referenceProfile, new Date().getFullYear()));
        } catch (err) {
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    // ============================================
    // SOIL & CROP DATA
    // ============================================
    app.get('/api/soil/:province_id', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM soil_data WHERE province_id = $1', [req.params.province_id]);
            if (result.rows.length) {
                return res.json(result.rows);
            }

            const province = await getEnrichedProvinceById(req.params.province_id);
            if (!province) {
                return res.json([]);
            }

            const referenceProfile = getProvinceReferenceArchetype(province);
            return res.json(buildProvinceFallbackSoils(
                province,
                referenceProfile,
                referenceProfile.dominant_hp_range,
                referenceProfile.dominant_tractor_type,
                referenceProfile.dominant_drive_type
            ));
        } catch (err) {
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    app.get('/api/crops/:province_id', authMiddleware, async (req, res) => {
        try {
            const { year } = req.query;
            const targetYear = year || new Date().getFullYear();
            const result = await pool.query(
                'SELECT * FROM crop_data WHERE province_id = $1 AND year = $2 ORDER BY cultivation_area_hectare DESC',
                [req.params.province_id, targetYear]
            );
            if (result.rows.length) {
                return res.json(result.rows);
            }

            const province = await getEnrichedProvinceById(req.params.province_id);
            if (!province) {
                return res.json([]);
            }

            const referenceProfile = getProvinceReferenceArchetype(province);
            return res.json(buildProvinceFallbackCrops(province, referenceProfile, Number(targetYear)));
        } catch (err) {
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });

    const PROVINCE_REFERENCE_ARCHETYPES = {
        akdeniz: {
            label: 'Akdeniz referans profili',
            climate_zone: 'Akdeniz gecis kusagi',
            annual_rainfall_mm: 720,
            avg_temperature: 18.8,
            elevation_m: 140,
            agricultural_area_hectare: 265000,
            soil_type: 'Aluvyal / killi-tinli',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '75-105 HP',
            primary_crops: [
                { name: 'Pamuk', type: 'endustriyel', share: 0.24, yield_ton_per_ha: 4.8, hp_min: 95, hp_max: 125, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
                { name: 'Misir', type: 'tahil', share: 0.22, yield_ton_per_ha: 9.5, hp_min: 85, hp_max: 115, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
                { name: 'Narenciye', type: 'meyve', share: 0.18, yield_ton_per_ha: 25, hp_min: 55, hp_max: 85, planting_season: 'Yillik', harvest_season: 'Kas-Oca', tractor_types: ['bahce', 'dar'] },
                { name: 'Acik alan sebze', type: 'sebze', share: 0.16, yield_ton_per_ha: 30, hp_min: 50, hp_max: 75, planting_season: 'Sub-Nis', harvest_season: 'Haz-Eki', tractor_types: ['hibrit', 'bahce'] }
            ],
            soil_layers: [
                { soil_type: 'Aluvyal tarla zemini', soil_texture: 'Tinli-killi', ph_level: 7.1, organic_matter_pct: 2.2, hp_range: '80-110 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sulama ve agir ekipman gecislerinde cekis kaybi dusurulmeli.' },
                { soil_type: 'Bahce tabani', soil_texture: 'Tinli', ph_level: 6.8, organic_matter_pct: 2.5, hp_range: '55-80 HP', tractor_type: 'bahce', drive_type: '2WD', note: 'Sira arasi manevra ve dusuk agirlikli paketler verimlidir.' }
            ],
            monthly_temp: [10, 11, 13, 17, 21, 26, 29, 29, 26, 21, 15, 11],
            monthly_rain: [110, 90, 70, 45, 25, 10, 4, 5, 15, 45, 80, 105],
            monthly_humidity: [70, 68, 66, 63, 60, 58, 56, 57, 59, 63, 67, 70],
            monthly_frost: [1.2, 0.8, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.8],
            monthly_drought: [-0.4, -0.2, 0.1, 0.4, 0.8, 1.1, 1.3, 1.2, 0.7, 0.2, -0.1, -0.3],
            monthly_gdd: [40, 55, 95, 160, 240, 320, 380, 370, 290, 190, 90, 45]
        },
        ege: {
            label: 'Ege referans profili',
            climate_zone: 'Ege - Akdeniz gecisi',
            annual_rainfall_mm: 690,
            avg_temperature: 17.1,
            elevation_m: 180,
            agricultural_area_hectare: 240000,
            soil_type: 'Tinli / kumlu-tinli',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'hibrit',
            dominant_hp_range: '65-95 HP',
            primary_crops: [
                { name: 'Zeytin', type: 'meyve', share: 0.20, yield_ton_per_ha: 3.8, hp_min: 50, hp_max: 80, planting_season: 'Yillik', harvest_season: 'Kas-Oca', tractor_types: ['bahce', 'dar'] },
                { name: 'Uzum', type: 'meyve', share: 0.16, yield_ton_per_ha: 9, hp_min: 45, hp_max: 75, planting_season: 'Yillik', harvest_season: 'Agu-Eyl', tractor_types: ['bahce', 'dar'] },
                { name: 'Pamuk', type: 'endustriyel', share: 0.18, yield_ton_per_ha: 4.4, hp_min: 90, hp_max: 120, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
                { name: 'Misir silaj', type: 'yem', share: 0.14, yield_ton_per_ha: 10.5, hp_min: 75, hp_max: 105, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', 'hibrit'] }
            ],
            soil_layers: [
                { soil_type: 'Bag-bahce zemini', soil_texture: 'Tinli', ph_level: 6.9, organic_matter_pct: 2.1, hp_range: '50-80 HP', tractor_type: 'bahce', drive_type: '2WD', note: 'Dar iz ve PTO operasyonlari on plandadir.' },
                { soil_type: 'Ova tarla zemini', soil_texture: 'Kumlu-tinli', ph_level: 7.0, organic_matter_pct: 1.9, hp_range: '75-105 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Yuksek sezon temposunda cekis ve tasima kapasitesi kritik olur.' }
            ],
            monthly_temp: [8, 9, 12, 16, 21, 26, 29, 29, 24, 19, 13, 9],
            monthly_rain: [95, 80, 65, 45, 30, 15, 6, 6, 15, 45, 75, 95],
            monthly_humidity: [72, 70, 68, 64, 60, 56, 53, 54, 58, 63, 68, 72],
            monthly_frost: [2, 1.2, 0.4, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1.6],
            monthly_drought: [-0.3, -0.1, 0.1, 0.4, 0.7, 0.9, 1.1, 1.0, 0.6, 0.2, 0, -0.2],
            monthly_gdd: [25, 40, 80, 150, 230, 310, 360, 355, 270, 170, 80, 35]
        },
        marmara: {
            label: 'Marmara referans profili',
            climate_zone: 'Marmara dengeli iklim',
            annual_rainfall_mm: 760,
            avg_temperature: 14.6,
            elevation_m: 220,
            agricultural_area_hectare: 210000,
            soil_type: 'Tinli / killi-tinli',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '70-100 HP',
            primary_crops: [
                { name: 'Bugday', type: 'tahil', share: 0.22, yield_ton_per_ha: 5.6, hp_min: 70, hp_max: 95, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla'] },
                { name: 'Aycicegi', type: 'endustriyel', share: 0.20, yield_ton_per_ha: 2.6, hp_min: 75, hp_max: 105, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
                { name: 'Misir', type: 'tahil', share: 0.16, yield_ton_per_ha: 9.2, hp_min: 80, hp_max: 110, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['tarla', '4wd'] },
                { name: 'Sebze', type: 'sebze', share: 0.12, yield_ton_per_ha: 26, hp_min: 45, hp_max: 70, planting_season: 'Sub-Nis', harvest_season: 'Haz-Eki', tractor_types: ['hibrit'] }
            ],
            soil_layers: [
                { soil_type: 'Ova tarla zemini', soil_texture: 'Killi-tinli', ph_level: 6.8, organic_matter_pct: 2.4, hp_range: '75-105 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sonbahar ve ilkbahar yagislari cekis tarafini belirginlestirir.' },
                { soil_type: 'Bahce-parsel zemini', soil_texture: 'Tinli', ph_level: 6.6, organic_matter_pct: 2.7, hp_range: '50-75 HP', tractor_type: 'hibrit', drive_type: '2WD', note: 'Kompakt ve manevrasi guclu setup daha verimli olur.' }
            ],
            monthly_temp: [5, 6, 9, 14, 18, 23, 26, 26, 21, 16, 10, 7],
            monthly_rain: [85, 70, 65, 55, 45, 35, 25, 20, 35, 60, 75, 90],
            monthly_humidity: [76, 74, 72, 69, 66, 64, 61, 62, 67, 71, 74, 76],
            monthly_frost: [4, 3, 1.5, 0.4, 0, 0, 0, 0, 0, 0.8, 2.2, 3.5],
            monthly_drought: [-0.2, -0.1, 0, 0.2, 0.4, 0.6, 0.8, 0.7, 0.3, 0.1, -0.1, -0.2],
            monthly_gdd: [10, 20, 55, 115, 190, 270, 320, 315, 225, 130, 50, 18]
        },
        'ic anadolu': {
            label: 'İç Anadolu referans profili',
            climate_zone: 'Karasal - kurak iç bölge',
            annual_rainfall_mm: 410,
            avg_temperature: 11.5,
            elevation_m: 980,
            agricultural_area_hectare: 380000,
            soil_type: 'Kireçli / killi-tinli',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '80-110 HP',
            primary_crops: [
                { name: 'Buğday', type: 'tahil', share: 0.30, yield_ton_per_ha: 4.2, hp_min: 80, hp_max: 105, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla', '4wd'] },
                { name: 'Arpa', type: 'tahil', share: 0.18, yield_ton_per_ha: 3.8, hp_min: 75, hp_max: 100, planting_season: 'Eki-Kas', harvest_season: 'Haz', tractor_types: ['tarla'] },
                { name: 'Şeker pancarı', type: 'endustriyel', share: 0.16, yield_ton_per_ha: 7.5, hp_min: 95, hp_max: 125, planting_season: 'Mar-Nis', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
                { name: 'Yonca', type: 'yem', share: 0.12, yield_ton_per_ha: 8.5, hp_min: 65, hp_max: 90, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['tarla', 'hibrit'] }
            ],
            soil_layers: [
                { soil_type: 'Kireçli ova zemini', soil_texture: 'Killi-tinli', ph_level: 7.8, organic_matter_pct: 1.5, hp_range: '85-115 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Kuraklık ve ağır çekiş gerektiren ekipmanlar güç rezervini ön plana çıkarır.' },
                { soil_type: 'Kuru tarım parçası', soil_texture: 'Tinli', ph_level: 7.5, organic_matter_pct: 1.4, hp_range: '70-95 HP', tractor_type: 'tarla', drive_type: '2WD', note: 'Düşük yakıtlı, ekonomik ve uzun iş günlerine uygun platformlar tercih edilir.' }
            ],
            monthly_temp: [-1, 1, 5, 11, 16, 21, 25, 25, 19, 12, 5, 0],
            monthly_rain: [40, 35, 38, 45, 50, 30, 12, 10, 18, 28, 32, 38],
            monthly_humidity: [74, 70, 65, 60, 55, 50, 44, 42, 46, 55, 66, 73],
            monthly_frost: [10, 7, 4, 1, 0, 0, 0, 0, 0.2, 1.5, 4.5, 8],
            monthly_drought: [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.2, 1.3, 0.9, 0.5, 0.3, 0.2],
            monthly_gdd: [0, 5, 25, 85, 160, 240, 310, 300, 210, 110, 30, 5]
        },
        karadeniz: {
            label: 'Karadeniz referans profili',
            climate_zone: 'Nemli Karadeniz iklimi',
            annual_rainfall_mm: 1080,
            avg_temperature: 13.2,
            elevation_m: 420,
            agricultural_area_hectare: 145000,
            soil_type: 'Asidik tinli / organik zengin',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'bahce',
            dominant_hp_range: '55-80 HP',
            primary_crops: [
                { name: 'Findik', type: 'meyve', share: 0.24, yield_ton_per_ha: 2.2, hp_min: 45, hp_max: 70, planting_season: 'Yillik', harvest_season: 'Agu-Eyl', tractor_types: ['bahce', 'dar'] },
                { name: 'Misir', type: 'tahil', share: 0.18, yield_ton_per_ha: 7.4, hp_min: 60, hp_max: 85, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['hibrit', '4wd'] },
                { name: 'Cay', type: 'meyve', share: 0.16, yield_ton_per_ha: 4.1, hp_min: 40, hp_max: 60, planting_season: 'Yillik', harvest_season: 'May-Eki', tractor_types: ['bahce', 'dar'] },
                { name: 'Yem bitkileri', type: 'yem', share: 0.14, yield_ton_per_ha: 8, hp_min: 55, hp_max: 80, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['hibrit'] }
            ],
            soil_layers: [
                { soil_type: 'Yamac bahce zemini', soil_texture: 'Tinli', ph_level: 6.3, organic_matter_pct: 3.1, hp_range: '45-70 HP', tractor_type: 'bahce', drive_type: '4WD', note: 'Egim ve nem, 4WD dar sasi platformlarini one cikarir.' },
                { soil_type: 'Nemli ova zemini', soil_texture: 'Milli-tinli', ph_level: 6.5, organic_matter_pct: 3.4, hp_range: '60-85 HP', tractor_type: 'hibrit', drive_type: '4WD', note: 'Yagisli donemlerde cekis ve zemin basinci dikkatle yonetilmelidir.' }
            ],
            monthly_temp: [7, 7, 8, 11, 15, 20, 23, 24, 21, 17, 13, 9],
            monthly_rain: [95, 80, 75, 65, 60, 55, 45, 45, 55, 80, 95, 105],
            monthly_humidity: [78, 78, 79, 78, 77, 76, 75, 76, 77, 79, 80, 80],
            monthly_frost: [3, 2, 1.2, 0.4, 0, 0, 0, 0, 0, 0.4, 1.2, 2.4],
            monthly_drought: [-0.5, -0.5, -0.4, -0.2, 0, 0.1, 0.2, 0.2, 0, -0.1, -0.3, -0.4],
            monthly_gdd: [8, 12, 25, 70, 130, 210, 260, 270, 210, 140, 70, 25]
        },
        'dogu anadolu': {
            label: 'Dogu Anadolu referans profili',
            climate_zone: 'Yuksek rakim karasal iklim',
            annual_rainfall_mm: 470,
            avg_temperature: 8.4,
            elevation_m: 1450,
            agricultural_area_hectare: 210000,
            soil_type: 'Killi / tasil orgulu',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '75-105 HP',
            primary_crops: [
                { name: 'Arpa', type: 'tahil', share: 0.24, yield_ton_per_ha: 3.5, hp_min: 70, hp_max: 95, planting_season: 'Nis-May', harvest_season: 'Agu', tractor_types: ['tarla', '4wd'] },
                { name: 'Bugday', type: 'tahil', share: 0.20, yield_ton_per_ha: 3.8, hp_min: 75, hp_max: 100, planting_season: 'Nis-May', harvest_season: 'Agu', tractor_types: ['tarla', '4wd'] },
                { name: 'Patates', type: 'sebze', share: 0.12, yield_ton_per_ha: 20, hp_min: 65, hp_max: 90, planting_season: 'Nis-May', harvest_season: 'Eyl', tractor_types: ['hibrit', '4wd'] },
                { name: 'Yem bitkileri', type: 'yem', share: 0.16, yield_ton_per_ha: 7.2, hp_min: 60, hp_max: 85, planting_season: 'May', harvest_season: 'Tem-Eyl', tractor_types: ['tarla'] }
            ],
            soil_layers: [
                { soil_type: 'Yuksek rakim tarla zemini', soil_texture: 'Killi', ph_level: 7.3, organic_matter_pct: 2.0, hp_range: '80-110 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Kisa sezon ve cekis ihtiyaci nedeniyle guc rezervi onemlidir.' },
                { soil_type: 'Serin mera / yem parcasi', soil_texture: 'Tinli', ph_level: 7.0, organic_matter_pct: 2.4, hp_range: '60-85 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Balya ve tasima icin PTO verimi guclu setuplar daha anlamlidir.' }
            ],
            monthly_temp: [-6, -4, 1, 8, 13, 18, 22, 22, 17, 10, 2, -3],
            monthly_rain: [55, 50, 55, 70, 75, 40, 18, 12, 20, 35, 45, 52],
            monthly_humidity: [72, 70, 66, 60, 57, 52, 48, 46, 50, 58, 66, 71],
            monthly_frost: [16, 13, 8, 3, 0.4, 0, 0, 0, 0.6, 3, 8, 13],
            monthly_drought: [0.1, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.0, 0.6, 0.3, 0.2, 0.1],
            monthly_gdd: [0, 0, 10, 60, 130, 210, 280, 275, 190, 95, 20, 0]
        },
        'guneydogu anadolu': {
            label: 'Guneydogu Anadolu referans profili',
            climate_zone: 'Sicak-kurak step kusagi',
            annual_rainfall_mm: 520,
            avg_temperature: 16.9,
            elevation_m: 640,
            agricultural_area_hectare: 330000,
            soil_type: 'Kirecli / milli-killi',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '85-120 HP',
            primary_crops: [
                { name: 'Bugday', type: 'tahil', share: 0.28, yield_ton_per_ha: 4.4, hp_min: 80, hp_max: 110, planting_season: 'Eki-Kas', harvest_season: 'Haz', tractor_types: ['tarla'] },
                { name: 'Mercimek', type: 'tahil', share: 0.14, yield_ton_per_ha: 1.9, hp_min: 70, hp_max: 95, planting_season: 'Kas-Ara', harvest_season: 'Haz', tractor_types: ['tarla'] },
                { name: 'Pamuk', type: 'endustriyel', share: 0.18, yield_ton_per_ha: 4.6, hp_min: 95, hp_max: 125, planting_season: 'Nis-May', harvest_season: 'Eyl-Eki', tractor_types: ['tarla', '4wd'] },
                { name: 'Misir', type: 'tahil', share: 0.16, yield_ton_per_ha: 9.1, hp_min: 85, hp_max: 115, planting_season: 'Mar-Nis', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] }
            ],
            soil_layers: [
                { soil_type: 'Sulamali ova zemini', soil_texture: 'Milli-killi', ph_level: 7.6, organic_matter_pct: 1.7, hp_range: '90-120 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Sira arasi ve agir ekipman operasyonlari ayni donemde yogunlasir.' },
                { soil_type: 'Kuru tarim parcasi', soil_texture: 'Tinli', ph_level: 7.7, organic_matter_pct: 1.3, hp_range: '75-100 HP', tractor_type: 'tarla', drive_type: '2WD', note: 'Ekonomik cekis ve dusuk yakit on plana cikar.' }
            ],
            monthly_temp: [4, 6, 10, 16, 22, 29, 33, 33, 28, 21, 12, 6],
            monthly_rain: [75, 65, 55, 40, 25, 8, 2, 2, 5, 20, 40, 68],
            monthly_humidity: [70, 66, 60, 54, 48, 39, 32, 32, 38, 48, 60, 68],
            monthly_frost: [3, 1.5, 0.4, 0, 0, 0, 0, 0, 0, 0.2, 0.8, 2],
            monthly_drought: [0.1, 0.2, 0.4, 0.6, 0.9, 1.2, 1.5, 1.5, 1.1, 0.6, 0.3, 0.1],
            monthly_gdd: [15, 30, 70, 140, 240, 360, 430, 425, 320, 200, 75, 25]
        },
        default: {
            label: 'Genel mekanizasyon referans profili',
            climate_zone: 'Iliman gecis kusagi',
            annual_rainfall_mm: 610,
            avg_temperature: 13.5,
            elevation_m: 360,
            agricultural_area_hectare: 180000,
            soil_type: 'Tinli',
            dominant_drive_type: '4WD',
            dominant_tractor_type: 'tarla',
            dominant_hp_range: '70-95 HP',
            primary_crops: [
                { name: 'Bugday', type: 'tahil', share: 0.26, yield_ton_per_ha: 4.6, hp_min: 70, hp_max: 95, planting_season: 'Eki-Kas', harvest_season: 'Haz-Tem', tractor_types: ['tarla'] },
                { name: 'Misir', type: 'tahil', share: 0.18, yield_ton_per_ha: 8.5, hp_min: 75, hp_max: 105, planting_season: 'Nis-May', harvest_season: 'Agu-Eyl', tractor_types: ['tarla', '4wd'] },
                { name: 'Yem bitkileri', type: 'yem', share: 0.14, yield_ton_per_ha: 7.3, hp_min: 60, hp_max: 85, planting_season: 'Mar-Nis', harvest_season: 'Haz-Eyl', tractor_types: ['tarla', 'hibrit'] }
            ],
            soil_layers: [
                { soil_type: 'Genel tarla zemini', soil_texture: 'Tinli', ph_level: 7.0, organic_matter_pct: 2.0, hp_range: '70-95 HP', tractor_type: 'tarla', drive_type: '4WD', note: 'Cok amacli saha operasyonlari icin dengeli kurulum gerekir.' }
            ],
            monthly_temp: [4, 5, 8, 13, 18, 23, 27, 27, 22, 16, 10, 6],
            monthly_rain: [70, 60, 55, 50, 45, 30, 15, 12, 20, 38, 55, 65],
            monthly_humidity: [73, 71, 68, 64, 60, 56, 52, 51, 56, 63, 69, 72],
            monthly_frost: [5, 4, 1.8, 0.4, 0, 0, 0, 0, 0, 0.7, 2, 4],
            monthly_drought: [-0.1, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.9, 0.5, 0.2, 0, -0.1],
            monthly_gdd: [10, 18, 45, 100, 180, 260, 320, 315, 230, 135, 55, 20]
        }
    };

    function getProvinceReferenceArchetype(province = {}) {
        const regionKey = normalizeSearchText(province.region || '');
        if (!regionKey) return PROVINCE_REFERENCE_ARCHETYPES.default;
        if (PROVINCE_REFERENCE_ARCHETYPES[regionKey]) return PROVINCE_REFERENCE_ARCHETYPES[regionKey];

        const fuzzyKey = Object.keys(PROVINCE_REFERENCE_ARCHETYPES)
            .filter(key => key !== 'default')
            .find(key => regionKey.includes(key) || key.includes(regionKey));

        return fuzzyKey ? PROVINCE_REFERENCE_ARCHETYPES[fuzzyKey] : PROVINCE_REFERENCE_ARCHETYPES.default;
    }

    function enrichProvinceWithReference(province = {}) {
        const reference = getProvinceReferenceArchetype(province);
        return {
            ...province,
            climate_zone: province.climate_zone || reference.climate_zone,
            annual_rainfall_mm: province.annual_rainfall_mm || reference.annual_rainfall_mm,
            avg_temperature: province.avg_temperature || reference.avg_temperature,
            elevation_m: province.elevation_m || reference.elevation_m,
            agricultural_area_hectare: province.agricultural_area_hectare || reference.agricultural_area_hectare,
            soil_type: province.soil_type || reference.soil_type,
            primary_crops: Array.isArray(province.primary_crops) && province.primary_crops.length
                ? province.primary_crops
                : reference.primary_crops.map(item => item.name)
        };
    }

    async function getEnrichedProvinceById(provinceId) {
        const result = await pool.query('SELECT * FROM provinces WHERE id = $1 LIMIT 1', [provinceId]);
        const province = result.rows[0] || null;
        return province ? enrichProvinceWithReference(province) : null;
    }

    function buildProvinceReferenceClimateRows(referenceProfile = {}, targetYear = new Date().getFullYear()) {
        const years = Array.from({ length: 6 }, (_, index) => targetYear - 5 + index);
        return years.flatMap((year, index) => {
            const warmingShift = (index - 2.5) * 0.12;
            const rainfallFactor = 1 + ((2.5 - index) * 0.03);
            return Array.from({ length: 12 }, (_, monthIndex) => ({
                year,
                month: monthIndex + 1,
                avg_temp: roundMetric((referenceProfile.monthly_temp?.[monthIndex] || 0) + warmingShift, 1),
                avg_rainfall_mm: roundMetric(Math.max(0, (referenceProfile.monthly_rain?.[monthIndex] || 0) * rainfallFactor), 1),
                avg_humidity: roundMetric(Math.min(90, Math.max(25, (referenceProfile.monthly_humidity?.[monthIndex] || 0) - (warmingShift * 1.2))), 1),
                frost_days: roundMetric(Math.max(0, (referenceProfile.monthly_frost?.[monthIndex] || 0) - Math.max(0, warmingShift * 0.8)), 1),
                drought_index: roundMetric((referenceProfile.monthly_drought?.[monthIndex] || 0) + Math.max(0, warmingShift * 0.5), 2),
                growing_degree_days: roundMetric(Math.max(0, (referenceProfile.monthly_gdd?.[monthIndex] || 0) + Math.max(0, warmingShift * 10)), 1)
            }));
        });
    }

    function buildProvinceFallbackCrops(province = {}, referenceProfile = {}, targetYear = new Date().getFullYear()) {
        const agArea = Number(province.agricultural_area_hectare || referenceProfile.agricultural_area_hectare || 180000);
        return (referenceProfile.primary_crops || []).map((crop, index) => {
            const area = Math.round(agArea * Number(crop.share || 0));
            return {
                id: -(province.id * 100 + index + 1),
                province_id: province.id,
                crop_name: crop.name,
                crop_type: crop.type,
                cultivation_area_hectare: area,
                annual_production_tons: Math.round(area * Number(crop.yield_ton_per_ha || 0)),
                year: targetYear,
                planting_season: crop.planting_season,
                harvest_season: crop.harvest_season,
                requires_hp_min: crop.hp_min,
                requires_hp_max: crop.hp_max,
                suitable_tractor_types: crop.tractor_types || [],
                source: 'province_reference_profile'
            };
        });
    }

    function buildProvinceFallbackSoils(province = {}, referenceProfile = {}, dominantHpRange = '', dominantCategory = '', dominantDrive = '') {
        return (referenceProfile.soil_layers || []).map((soil, index) => ({
            id: -(province.id * 100 + index + 1),
            province_id: province.id,
            soil_type: soil.soil_type || province.soil_type || referenceProfile.soil_type,
            soil_texture: soil.soil_texture || 'Tinli',
            ph_level: soil.ph_level,
            organic_matter_pct: soil.organic_matter_pct,
            suitable_crops: (referenceProfile.primary_crops || []).slice(index, index + 2).map(item => item.name),
            recommended_hp_range: soil.hp_range || dominantHpRange || referenceProfile.dominant_hp_range,
            recommended_tractor_type: soil.tractor_type || dominantCategory || referenceProfile.dominant_tractor_type,
            recommended_drive_type: soil.drive_type || dominantDrive || referenceProfile.dominant_drive_type,
            notes: soil.note || 'Bolgesel referans profilinden uretildi.',
            source: 'province_reference_profile'
        }));
    }

    function buildProvinceReferenceForecastRows(province = {}, referenceProfile = {}, dayCount = 7) {
        const today = new Date();
        const monthIndex = today.getMonth();
        const monthTemp = Number(referenceProfile.monthly_temp?.[monthIndex] ?? province.avg_temperature ?? 14);
        const monthRain = Number(referenceProfile.monthly_rain?.[monthIndex] ?? ((province.annual_rainfall_mm || referenceProfile.annual_rainfall_mm || 360) / 12));
        const monthHumidity = Number(referenceProfile.monthly_humidity?.[monthIndex] ?? 60);
        const weeklyRainTarget = Math.max(0, Number((monthRain / 4.3).toFixed(1)));
        const rainySlots = weeklyRainTarget >= 18
            ? [1, 3, 5]
            : weeklyRainTarget >= 8
                ? [2, 5]
                : weeklyRainTarget >= 3
                    ? [3]
                    : [];

        return Array.from({ length: dayCount }, (_, index) => {
            const date = new Date(today);
            date.setDate(today.getDate() + index);

            const tempOffset = ((index % 4) - 1.5) * 1.1;
            const avgTemp = monthTemp + tempOffset;
            const tempMax = Number((avgTemp + (monthTemp >= 22 ? 6.5 : 5.5)).toFixed(1));
            const tempMin = Number((avgTemp - (monthTemp >= 22 ? 5.5 : 4.5)).toFixed(1));
            const rainfall = rainySlots.includes(index)
                ? Number((weeklyRainTarget / Math.max(rainySlots.length, 1)).toFixed(1))
                : 0;
            const humidity = Math.min(90, Math.max(35, monthHumidity + (rainfall > 0 ? 8 : -3) + (index % 3 === 0 ? 2 : -1)));
            const windSpeed = Number((14 + (index % 3) * 2 + (rainfall > 0 ? 4 : 0)).toFixed(0));

            let weatherCondition = 'clear';
            if (rainfall >= 3) {
                weatherCondition = 'rain';
            } else if (tempMin <= 0) {
                weatherCondition = 'snow';
            } else if (humidity >= 72) {
                weatherCondition = 'cloud';
            }

            return {
                id: -((Number(province.id) || 0) * 1000 + index + 1),
                province_id: province.id,
                date: date.toISOString().slice(0, 10),
                weather_condition: weatherCondition,
                temp_max: tempMax,
                temp_min: tempMin,
                rainfall_mm: rainfall,
                humidity_pct: Number(humidity.toFixed(0)),
                wind_speed_kmh: windSpeed,
                is_forecast: true,
                source: 'province_reference_profile'
            };
        });
    }

    function hpRangeFromHorsepower(hp) {
        const value = Number(hp || 0);
        if (!Number.isFinite(value) || value <= 0) return null;
        if (value <= 39) return '1-39';
        if (value <= 49) return '40-49';
        if (value <= 54) return '50-54';
        if (value <= 59) return '55-59';
        if (value <= 69) return '60-69';
        if (value <= 79) return '70-79';
        if (value <= 89) return '80-89';
        if (value <= 99) return '90-99';
        if (value <= 109) return '100-109';
        if (value <= 119) return '110-119';
        return '120+';
    }

    function parseHpBand(rangeLabel = '') {
        const text = String(rangeLabel || '');
        const matches = text.match(/\d+/g) || [];
        if (!matches.length) return { min: null, max: null, mid: null };
        const min = Number(matches[0]);
        const max = matches[1] ? Number(matches[1]) : (text.includes('+') ? min + 20 : min);
        return { min, max, mid: Number(((min + max) / 2).toFixed(1)) };
    }

    function normalizeModelCategory(value = '') {
        const normalized = normalizeSearchText(value);
        if (!normalized) return 'tarla';
        if (normalized.includes('bah')) return 'bahce';
        if (normalized.includes('hib')) return 'hibrit';
        return 'tarla';
    }

    function normalizeModelDriveType(value = '') {
        const normalized = String(value || '').toUpperCase();
        if (normalized.includes('2')) return '2WD';
        return '4WD';
    }

    function computeHpFitScore(hp, min, max) {
        if (!Number.isFinite(Number(hp)) || !Number.isFinite(Number(min)) || !Number.isFinite(Number(max))) return 12;
        const numericHp = Number(hp);
        if (numericHp >= Number(min) && numericHp <= Number(max)) return 28;
        const gap = numericHp < Number(min) ? Number(min) - numericHp : numericHp - Number(max);
        if (gap <= 5) return 23;
        if (gap <= 10) return 18;
        if (gap <= 20) return 12;
        if (gap <= 30) return 7;
        return 3;
    }

    function computeModelProvinceCompatibility(model = {}, province = {}) {
        const reference = getProvinceReferenceArchetype(province);
        const enrichedProvince = enrichProvinceWithReference(province);
        const hp = Number(model.horsepower || 0);
        const category = normalizeModelCategory(model.category);
        const driveType = normalizeModelDriveType(model.drive_type);
        const crops = reference.primary_crops || [];
        const soils = reference.soil_layers || [];

        let bestCrop = null;
        let cropScore = 0;
        crops.forEach(crop => {
            let score = computeHpFitScore(hp, crop.hp_min, crop.hp_max);
            const tractorTypes = crop.tractor_types || [];
            if (tractorTypes.includes(category)) score += 10;
            else if (category === 'hibrit' && (tractorTypes.includes('tarla') || tractorTypes.includes('bahce'))) score += 6;
            if (tractorTypes.includes('4wd') && driveType === '4WD') score += 6;
            if (tractorTypes.includes('dar') && category === 'bahce') score += 4;
            if (score > cropScore) {
                cropScore = score;
                bestCrop = crop;
            }
        });

        let bestSoil = null;
        let soilScore = 0;
        soils.forEach(soil => {
            const hpBand = parseHpBand(soil.hp_range || reference.dominant_hp_range);
            let score = computeHpFitScore(hp, hpBand.min, hpBand.max);
            if (normalizeModelCategory(soil.tractor_type || reference.dominant_tractor_type) === category) score += 10;
            if (normalizeModelDriveType(soil.drive_type || reference.dominant_drive_type) === driveType) score += 8;
            if (score > soilScore) {
                soilScore = score;
                bestSoil = soil;
            }
        });

        let categoryScore = category === normalizeModelCategory(reference.dominant_tractor_type) ? 14 : 6;
        if (category === 'hibrit') categoryScore = 10;
        let driveScore = driveType === normalizeModelDriveType(reference.dominant_drive_type) ? 12 : 5;
        if (Number(enrichedProvince.elevation_m || 0) > 900 && driveType === '4WD') driveScore += 3;

        const finalScore = Math.max(42, Math.min(96, Math.round((cropScore * 0.38) + (soilScore * 0.30) + categoryScore + driveScore)));
        const label = finalScore >= 86
            ? 'Doğal liderlik'
            : finalScore >= 76
                ? 'Güçlü uyum'
            : finalScore >= 64
                    ? 'Seçici uyum'
                    : 'Sınırlı uyum';

        const notes = [
            bestCrop ? `${bestCrop.name} ekseninde HP uyumu belirgin.` : `${reference.label} ile genel uyum kuruluyor.`,
            bestSoil?.note || '',
            driveType === normalizeModelDriveType(reference.dominant_drive_type)
                ? `${driveType} çekiş mimarisi bölgenin saha karakteriyle örtüşüyor.`
                : ''
        ].filter(Boolean);

        return {
            score: finalScore,
            label,
            dominant_crop: bestCrop?.name || reference.primary_crops?.[0]?.name || null,
            reference_label: reference.label,
            soil_type: enrichedProvince.soil_type,
            climate_zone: enrichedProvince.climate_zone,
            annual_rainfall_mm: Number(enrichedProvince.annual_rainfall_mm || 0) || null,
            avg_temperature: Number(enrichedProvince.avg_temperature || 0) || null,
            elevation_m: Number(enrichedProvince.elevation_m || 0) || null,
            agricultural_area_hectare: Number(enrichedProvince.agricultural_area_hectare || 0) || null,
            primary_crops: Array.isArray(enrichedProvince.primary_crops) ? enrichedProvince.primary_crops : [],
            recommended_hp_range: bestSoil?.hp_range || reference.dominant_hp_range,
            recommended_drive_type: bestSoil?.drive_type || reference.dominant_drive_type,
            recommended_tractor_type: bestSoil?.tractor_type || reference.dominant_tractor_type,
            note: notes.slice(0, 2).join(' ')
        };
    }

    function buildModelRegionMission({ fitScore = 0, modelSharePct = 0, yoyPct = null, opportunityScore = 0 }) {
        if (fitScore >= 84 && modelSharePct >= 12) return 'Kale bölge';
        if (opportunityScore >= 82) return 'Sıcak beyaz alan';
        if (fitScore >= 78 && (yoyPct == null || yoyPct >= 0)) return 'Yatırım cephesi';
        if (fitScore < 64) return 'Seçici saha';
        return 'Derinleştir';
    }

    function aggregateProvinceBrandRows(rows = [], previousBrandMap = new Map(), marketTotal = 0) {
        const map = new Map();

        (rows || []).forEach(row => {
            const brandId = Number(row.brand_id || 0);
            if (!brandId) return;

            if (!map.has(brandId)) {
                map.set(brandId, {
                    brand_id: brandId,
                    brand_name: row.brand_name,
                    slug: row.brand_slug,
                    primary_color: row.primary_color,
                    total_sales: 0
                });
            }

            map.get(brandId).total_sales += Number(row.total_sales || 0);
        });

        return Array.from(map.values())
            .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'))
            .map((row, index) => {
                const previousSales = Number(previousBrandMap.get(row.brand_id) || 0);
                return {
                    ...row,
                    previous_sales: previousSales,
                    share_pct: marketTotal > 0 ? roundMetric((row.total_sales * 100) / marketTotal, 1) : 0,
                    yoy_pct: calculateYoY(row.total_sales, previousSales),
                    rank: index + 1
                };
            });
    }

    function aggregateProvinceMixRows(rows = [], valueGetter, totalBase = 0, labelKey = 'label') {
        const map = new Map();

        (rows || []).forEach(row => {
            const rawLabel = valueGetter(row);
            const label = rawLabel ? String(rawLabel) : 'belirsiz';
            if (!map.has(label)) map.set(label, 0);
            map.set(label, map.get(label) + Number(row.total_sales || 0));
        });

        return Array.from(map.entries())
            .map(([label, totalSales]) => ({
                [labelKey]: label,
                label,
                total_sales: totalSales,
                share_pct: totalBase > 0 ? roundMetric((totalSales * 100) / totalBase, 1) : 0
            }))
            .sort((left, right) => right.total_sales - left.total_sales || String(left.label || '').localeCompare(String(right.label || ''), 'tr'));
    }

    app.get('/api/province-intelligence/:province_id', authMiddleware, async (req, res) => {
        try {
            const provinceId = parseInt(req.params.province_id, 10);
            if (!Number.isFinite(provinceId)) {
                return res.status(400).json({ error: 'Geçerli province_id gerekli' });
            }

            const latestRes = await pool.query('SELECT MAX(year) as max_year, MIN(year) as min_year FROM sales_view');
            const maxYear = parseInt(latestRes.rows[0]?.max_year, 10) || new Date().getFullYear();
            const minYear = parseInt(latestRes.rows[0]?.min_year, 10) || maxYear;
            const requestedYear = req.query.year ? parseInt(req.query.year, 10) : maxYear;
            const targetYear = Number.isFinite(requestedYear) ? Math.min(Math.max(requestedYear, minYear), maxYear) : maxYear;
            const prevYear = targetYear - 1;
            const focusBrandId = req.user.role === 'admin'
                ? (req.query.brand_id ? parseInt(req.query.brand_id, 10) : null)
                : req.user.brand_id;

            const normalizedBrandExpr = `
                CASE
                    WHEN UPPER(tv.marka) = 'CASE IH' THEN 'CASE'
                    WHEN UPPER(tv.marka) = 'DEUTZ-FAHR' THEN 'DEUTZ'
                    WHEN UPPER(tv.marka) = 'KIOTI' THEN 'KİOTİ'
                    ELSE tv.marka
                END
            `;
            const categoryHintExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' AND LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'hibrit'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%bahce%' THEN 'bahce'
                    WHEN LOWER(COALESCE(tk.kullanim_alani, '')) LIKE '%tarla%' THEN 'tarla'
                    ELSE NULL
                END
            `;
            const hpRangeExpr = `
                CASE
                    WHEN tk.motor_gucu_hp IS NULL THEN NULL
                    WHEN tk.motor_gucu_hp <= 39 THEN '1-39'
                    WHEN tk.motor_gucu_hp <= 49 THEN '40-49'
                    WHEN tk.motor_gucu_hp <= 54 THEN '50-54'
                    WHEN tk.motor_gucu_hp <= 59 THEN '55-59'
                    WHEN tk.motor_gucu_hp <= 69 THEN '60-69'
                    WHEN tk.motor_gucu_hp <= 79 THEN '70-79'
                    WHEN tk.motor_gucu_hp <= 89 THEN '80-89'
                    WHEN tk.motor_gucu_hp <= 99 THEN '90-99'
                    WHEN tk.motor_gucu_hp <= 109 THEN '100-109'
                    WHEN tk.motor_gucu_hp <= 119 THEN '110-119'
                    WHEN tk.motor_gucu_hp > 119 THEN '120+'
                    ELSE NULL
                END
            `;
            const cabinTypeExpr = `
                CASE
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%kabin%' THEN 'kabinli'
                    WHEN LOWER(COALESCE(tk.koruma, '')) LIKE '%rops%' OR LOWER(COALESCE(tk.koruma, '')) LIKE '%roll%' THEN 'rollbar'
                    ELSE NULL
                END
            `;

            const provinceRes = await pool.query(`
                SELECT id, name, plate_code, region, latitude, longitude, population, agricultural_area_hectare,
                       primary_crops, soil_type, climate_zone, annual_rainfall_mm, avg_temperature, elevation_m
                FROM provinces
                WHERE id = $1
            `, [provinceId]);
            const provinceRow = provinceRes.rows[0];
            const province = enrichProvinceWithReference(provinceRow || {});
            if (!provinceRow) {
                return res.status(404).json({ error: 'İl bulunamadı' });
            }

            const regionReference = getProvinceReferenceArchetype(province);
            const referenceProfile = {
                label: regionReference.label,
                climate_zone: regionReference.climate_zone,
                soil_type: regionReference.soil_type,
                dominant_drive_type: regionReference.dominant_drive_type,
                dominant_tractor_type: regionReference.dominant_tractor_type,
                dominant_hp_range: regionReference.dominant_hp_range,
                primary_crops: regionReference.primary_crops,
                soil_layers: regionReference.soil_layers,
                climate_rows: buildProvinceReferenceClimateRows(regionReference, targetYear)
            };

            const cropYearRes = await pool.query(`
                SELECT COALESCE(
                    MAX(CASE WHEN year <= $2 THEN year END),
                    MAX(year)
                ) as crop_year
                FROM crop_data
                WHERE province_id = $1
            `, [provinceId, targetYear]);
            const cropYear = parseInt(cropYearRes.rows[0]?.crop_year, 10) || targetYear;

            const [
                soilRes,
                cropsRes,
                currentOverviewRes,
                previousOverviewRes,
                topBrandsRes,
                hpRes,
                categoryRes,
                driveRes,
                cabinRes,
                topModelsRes,
                currentTuikMixRes,
                previousTuikMixRes
            ] = await Promise.all([
                pool.query('SELECT * FROM soil_data WHERE province_id = $1 ORDER BY organic_matter_pct DESC NULLS LAST, soil_type ASC', [provinceId]),
                pool.query(
                    'SELECT * FROM crop_data WHERE province_id = $1 AND year = $2 ORDER BY cultivation_area_hectare DESC NULLS LAST, annual_production_tons DESC NULLS LAST',
                    [provinceId, cropYear]
                ),
                pool.query(
                    `SELECT COALESCE(SUM(quantity), 0)::int as total_sales, COUNT(DISTINCT brand_id)::int as active_brand_count
                     FROM sales_view
                     WHERE province_id = $1 AND year = $2`,
                    [provinceId, targetYear]
                ),
                pool.query(
                    `SELECT COALESCE(SUM(quantity), 0)::int as total_sales
                     FROM sales_view
                     WHERE province_id = $1 AND year = $2`,
                    [provinceId, prevYear]
                ),
                pool.query(`
                    WITH previous_brand AS (
                        SELECT brand_id, SUM(quantity)::int as previous_sales
                        FROM sales_view
                        WHERE province_id = $1 AND year = $3
                        GROUP BY brand_id
                    )
                    SELECT
                        b.id as brand_id,
                        b.name as brand_name,
                        b.slug,
                        b.primary_color,
                        SUM(s.quantity)::int as total_sales,
                        COALESCE(pb.previous_sales, 0)::int as previous_sales
                    FROM sales_view s
                    JOIN brands b ON s.brand_id = b.id
                    LEFT JOIN previous_brand pb ON pb.brand_id = b.id
                    WHERE s.province_id = $1 AND s.year = $2
                    GROUP BY b.id, b.name, b.slug, b.primary_color, pb.previous_sales
                    ORDER BY total_sales DESC, b.name ASC
                    LIMIT 12
                `, [provinceId, targetYear, prevYear]),
                pool.query(`
                    SELECT COALESCE(hp_range, 'belirsiz') as hp_range, SUM(quantity)::int as total_sales
                    FROM sales_view
                    WHERE province_id = $1 AND year = $2
                    GROUP BY hp_range
                    ORDER BY total_sales DESC, hp_range ASC
                `, [provinceId, targetYear]),
                pool.query(`
                    SELECT COALESCE(category, 'belirsiz') as label, SUM(quantity)::int as total_sales
                    FROM sales_view
                    WHERE province_id = $1 AND year = $2
                    GROUP BY category
                    ORDER BY total_sales DESC, label ASC
                `, [provinceId, targetYear]),
                pool.query(`
                    SELECT UPPER(COALESCE(drive_type, 'belirsiz')) as label, SUM(quantity)::int as total_sales
                    FROM sales_view
                    WHERE province_id = $1 AND year = $2
                    GROUP BY drive_type
                    ORDER BY total_sales DESC, label ASC
                `, [provinceId, targetYear]),
                pool.query(`
                    SELECT LOWER(COALESCE(cabin_type, 'belirsiz')) as label, SUM(quantity)::int as total_sales
                    FROM sales_view
                    WHERE province_id = $1 AND year = $2
                    GROUP BY cabin_type
                    ORDER BY total_sales DESC, label ASC
                `, [provinceId, targetYear]),
                pool.query(`
                    WITH model_totals AS (
                        SELECT
                            ${normalizedBrandExpr} as normalized_brand_name,
                            tv.marka,
                            tv.tuik_model_adi,
                            SUM(tv.satis_adet)::int as total_sales
                        FROM tuik_veri tv
                        WHERE tv.tescil_yil = $1
                          AND tv.sehir_kodu = $2
                        GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                        ORDER BY total_sales DESC, tv.marka ASC, tv.tuik_model_adi ASC
                        LIMIT 36
                    )
                    SELECT
                        b.id as brand_id,
                        b.name as brand_name,
                        b.slug as brand_slug,
                        b.primary_color,
                        COALESCE(NULLIF(tk.model, ''), mt.tuik_model_adi) as model_name,
                        mt.tuik_model_adi,
                        mt.total_sales,
                        ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                        ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                        ${categoryHintExpr} as category_hint,
                        LOWER(MAX(COALESCE(tk.cekis_tipi, ''))) as drive_type,
                        MAX(COALESCE(tk.koruma, '')) as protection,
                        MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                        MAX(COALESCE(tk.mensei, '')) as origin,
                        MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                        CASE
                            WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                            ELSE NULL
                        END as estimated_revenue_usd
                    FROM model_totals mt
                    JOIN brands b
                        ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                    LEFT JOIN teknik_veri tk
                        ON UPPER(mt.marka) = UPPER(tk.marka)
                       AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                    GROUP BY
                        b.id, b.name, b.slug, b.primary_color,
                        COALESCE(NULLIF(tk.model, ''), mt.tuik_model_adi),
                        mt.tuik_model_adi,
                        mt.total_sales,
                        ${categoryHintExpr}
                    ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
                    LIMIT 24
                `, [targetYear, parseInt(province.plate_code, 10)]),
                pool.query(`
                    WITH model_totals AS (
                        SELECT
                            ${normalizedBrandExpr} as normalized_brand_name,
                            tv.marka,
                            tv.tuik_model_adi,
                            SUM(tv.satis_adet)::int as total_sales
                        FROM tuik_veri tv
                        WHERE tv.tescil_yil = $1
                          AND tv.sehir_kodu = $2
                        GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                    )
                    SELECT
                        b.id as brand_id,
                        b.name as brand_name,
                        b.slug as brand_slug,
                        b.primary_color,
                        COALESCE(NULLIF(MAX(tk.model), ''), mt.tuik_model_adi) as model_name,
                        mt.tuik_model_adi,
                        mt.total_sales,
                        ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                        ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                        COALESCE(MAX(${categoryHintExpr}), 'belirsiz') as category_hint,
                        COALESCE(MAX(${hpRangeExpr}), 'belirsiz') as hp_range,
                        COALESCE(UPPER(MAX(NULLIF(tk.cekis_tipi, ''))), 'belirsiz') as drive_type,
                        COALESCE(MAX(${cabinTypeExpr}), 'belirsiz') as cabin_type,
                        MAX(COALESCE(tk.koruma, '')) as protection,
                        MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                        MAX(COALESCE(tk.mensei, '')) as origin,
                        MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                        CASE
                            WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                            ELSE NULL
                        END as estimated_revenue_usd
                    FROM model_totals mt
                    JOIN brands b
                        ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                    LEFT JOIN teknik_veri tk
                        ON UPPER(mt.marka) = UPPER(tk.marka)
                       AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                    GROUP BY
                        b.id, b.name, b.slug, b.primary_color,
                        mt.tuik_model_adi,
                        mt.total_sales
                    ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
                `, [targetYear, parseInt(province.plate_code, 10)]),
                pool.query(`
                    WITH model_totals AS (
                        SELECT
                            ${normalizedBrandExpr} as normalized_brand_name,
                            tv.marka,
                            tv.tuik_model_adi,
                            SUM(tv.satis_adet)::int as total_sales
                        FROM tuik_veri tv
                        WHERE tv.tescil_yil = $1
                          AND tv.sehir_kodu = $2
                        GROUP BY ${normalizedBrandExpr}, tv.marka, tv.tuik_model_adi
                    )
                    SELECT
                        b.id as brand_id,
                        b.name as brand_name,
                        b.slug as brand_slug,
                        b.primary_color,
                        COALESCE(NULLIF(MAX(tk.model), ''), mt.tuik_model_adi) as model_name,
                        mt.tuik_model_adi,
                        mt.total_sales,
                        ROUND(AVG(NULLIF(tk.motor_gucu_hp, 0))::numeric, 1) as avg_hp,
                        ROUND(AVG(NULLIF(tk.fiyat_usd, 0))::numeric, 2) as avg_price_usd,
                        COALESCE(MAX(${categoryHintExpr}), 'belirsiz') as category_hint,
                        COALESCE(MAX(${hpRangeExpr}), 'belirsiz') as hp_range,
                        COALESCE(UPPER(MAX(NULLIF(tk.cekis_tipi, ''))), 'belirsiz') as drive_type,
                        COALESCE(MAX(${cabinTypeExpr}), 'belirsiz') as cabin_type,
                        MAX(COALESCE(tk.koruma, '')) as protection,
                        MAX(COALESCE(tk.vites_sayisi, '')) as gear_config,
                        MAX(COALESCE(tk.mensei, '')) as origin,
                        MAX(COALESCE(tk.motor_marka, '')) as engine_brand,
                        CASE
                            WHEN AVG(NULLIF(tk.fiyat_usd, 0)) IS NOT NULL THEN ROUND((mt.total_sales * AVG(NULLIF(tk.fiyat_usd, 0)))::numeric, 2)
                            ELSE NULL
                        END as estimated_revenue_usd
                    FROM model_totals mt
                    JOIN brands b
                        ON UPPER(b.name) = UPPER(mt.normalized_brand_name)
                    LEFT JOIN teknik_veri tk
                        ON UPPER(mt.marka) = UPPER(tk.marka)
                       AND UPPER(mt.tuik_model_adi) = UPPER(tk.tuik_model_adi)
                    GROUP BY
                        b.id, b.name, b.slug, b.primary_color,
                        mt.tuik_model_adi,
                        mt.total_sales
                    ORDER BY mt.total_sales DESC, b.name ASC, model_name ASC
                `, [prevYear, parseInt(province.plate_code, 10)])
            ]);

            const mapProvinceModelRow = row => {
                const totalSales = parseInt(row.total_sales || 0, 10) || 0;
                return {
                    brand_id: parseInt(row.brand_id, 10),
                    brand_name: row.brand_name,
                    brand_slug: row.brand_slug || row.slug,
                    primary_color: row.primary_color,
                    model_name: row.model_name,
                    tuik_model_adi: row.tuik_model_adi,
                    total_sales: totalSales,
                    avg_hp: row.avg_hp != null ? Number(row.avg_hp) : null,
                    avg_price_usd: row.avg_price_usd != null ? Number(row.avg_price_usd) : null,
                    estimated_revenue_usd: row.estimated_revenue_usd != null ? Number(row.estimated_revenue_usd) : null,
                    category_hint: row.category_hint || null,
                    hp_range: row.hp_range || null,
                    drive_type: row.drive_type || null,
                    cabin_type: row.cabin_type || null,
                    protection: row.protection || null,
                    gear_config: row.gear_config || null,
                    origin: row.origin || null,
                    engine_brand: row.engine_brand || null
                };
            };

            const fallbackCurrentRows = currentTuikMixRes.rows.map(mapProvinceModelRow);
            const fallbackPreviousRows = previousTuikMixRes.rows.map(mapProvinceModelRow);

            let marketTotal = parseInt(currentOverviewRes.rows[0]?.total_sales || 0, 10);
            let previousTotal = parseInt(previousOverviewRes.rows[0]?.total_sales || 0, 10);
            let activeBrandCount = parseInt(currentOverviewRes.rows[0]?.active_brand_count || 0, 10);

            let topBrands = topBrandsRes.rows.map((row, index) => {
                const totalSales = parseInt(row.total_sales, 10) || 0;
                const previousSales = parseInt(row.previous_sales, 10) || 0;
                return {
                    brand_id: parseInt(row.brand_id, 10),
                    brand_name: row.brand_name,
                    slug: row.slug,
                    primary_color: row.primary_color,
                    total_sales: totalSales,
                    previous_sales: previousSales,
                    share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0,
                    yoy_pct: calculateYoY(totalSales, previousSales),
                    rank: index + 1
                };
            });

            const mapShareRows = (rows, labelKey = 'label') => rows.map(row => {
                const totalSales = parseInt(row.total_sales, 10) || 0;
                return {
                    label: row[labelKey],
                    total_sales: totalSales,
                    share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0
                };
            });

            let hpMix = hpRes.rows.map(row => {
                const totalSales = parseInt(row.total_sales, 10) || 0;
                return {
                    hp_range: row.hp_range,
                    total_sales: totalSales,
                    share_pct: marketTotal > 0 ? roundMetric((totalSales * 100) / marketTotal, 1) : 0
                };
            });
            let categoryMix = mapShareRows(categoryRes.rows);
            let driveMix = mapShareRows(driveRes.rows);
            let cabinMix = mapShareRows(cabinRes.rows);
            let topModels = topModelsRes.rows.map(row => ({
                ...mapProvinceModelRow(row),
                share_pct: marketTotal > 0 ? roundMetric(((parseInt(row.total_sales, 10) || 0) * 100) / marketTotal, 1) : 0
            }));
            let marketSource = 'sales_view';

            if (marketTotal <= 0 && fallbackCurrentRows.length > 0) {
                marketSource = 'tuik_veri';
                marketTotal = fallbackCurrentRows.reduce((sum, item) => sum + Number(item.total_sales || 0), 0);
                previousTotal = fallbackPreviousRows.reduce((sum, item) => sum + Number(item.total_sales || 0), 0);
                activeBrandCount = new Set(fallbackCurrentRows.map(item => Number(item.brand_id || 0)).filter(Boolean)).size;

                const previousBrandMap = fallbackPreviousRows.reduce((map, item) => {
                    const brandId = Number(item.brand_id || 0);
                    if (!brandId) return map;
                    map.set(brandId, (map.get(brandId) || 0) + Number(item.total_sales || 0));
                    return map;
                }, new Map());

                topBrands = aggregateProvinceBrandRows(fallbackCurrentRows, previousBrandMap, marketTotal).slice(0, 12);
                hpMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.hp_range || 'belirsiz', marketTotal, 'hp_range');
                categoryMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.category_hint || 'belirsiz', marketTotal);
                driveMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.drive_type || 'belirsiz', marketTotal);
                cabinMix = aggregateProvinceMixRows(fallbackCurrentRows, row => row.cabin_type || 'belirsiz', marketTotal);
                topModels = [...fallbackCurrentRows]
                    .sort((left, right) => right.total_sales - left.total_sales || String(left.brand_name || '').localeCompare(String(right.brand_name || ''), 'tr'))
                    .slice(0, 24)
                    .map(item => ({
                        ...item,
                        share_pct: marketTotal > 0 ? roundMetric((Number(item.total_sales || 0) * 100) / marketTotal, 1) : 0
                    }));
            }

            const dominantHpRange = hpMix[0]?.hp_range || referenceProfile.dominant_hp_range;
            const dominantCategory = categoryMix[0]?.label || referenceProfile.dominant_tractor_type;
            const dominantDrive = driveMix[0]?.label || referenceProfile.dominant_drive_type;
            const finalCropRows = cropsRes.rows.length
                ? cropsRes.rows
                : buildProvinceFallbackCrops(province, regionReference, targetYear);
            const finalSoilRows = soilRes.rows.length
                ? soilRes.rows
                : buildProvinceFallbackSoils(province, regionReference, dominantHpRange, dominantCategory, dominantDrive);
            const focusBrand = focusBrandId
                ? topBrands.find(item => item.brand_id === Number(focusBrandId)) || null
                : null;

            const weightedHpTotal = topModels.reduce((sum, item) => sum + ((item.avg_hp || 0) * item.total_sales), 0);
            const weightedSales = topModels.reduce((sum, item) => sum + item.total_sales, 0);
            const weightedAvgHp = weightedSales > 0 ? roundMetric(weightedHpTotal / weightedSales, 1) : null;
            const weightedPriceTotal = topModels.reduce((sum, item) => sum + ((item.avg_price_usd || 0) * item.total_sales), 0);
            const weightedAvgPrice = weightedSales > 0 ? roundMetric(weightedPriceTotal / weightedSales, 0) : null;

            res.json({
                province,
                period: {
                    year: targetYear,
                    previous_year: prevYear,
                    crop_year: cropYear,
                    max_year: maxYear,
                    min_year: minYear
                },
                overview: {
                    market_total_sales: marketTotal,
                    previous_total_sales: previousTotal,
                    yoy_pct: calculateYoY(marketTotal, previousTotal),
                    active_brand_count: activeBrandCount,
                    dominant_hp: hpMix[0]?.hp_range || null,
                    weighted_avg_hp: weightedAvgHp,
                    weighted_avg_price_usd: weightedAvgPrice,
                    top_brand_name: topBrands[0]?.brand_name || null,
                    top_brand_share_pct: topBrands[0]?.share_pct || 0
                },
                focus_brand: focusBrand,
                soil: finalSoilRows,
                crops: finalCropRows,
                top_brands: topBrands,
                hp_mix: hpMix,
                category_mix: categoryMix,
                drive_mix: driveMix,
                cabin_mix: cabinMix,
                top_models: topModels,
                reference_profile: {
                    ...referenceProfile,
                    soil_source: soilRes.rows.length ? 'soil_data' : 'province_reference_profile',
                    crop_source: cropsRes.rows.length ? 'crop_data' : 'province_reference_profile',
                    market_source: marketSource,
                    is_reference_active: !soilRes.rows.length || !cropsRes.rows.length || marketSource !== 'sales_view'
                },
                source_stack: Array.from(new Set([
                    marketSource,
                    'tuik_veri',
                    'teknik_veri',
                    soilRes.rows.length ? 'soil_data' : 'province_reference_profile',
                    cropsRes.rows.length ? 'crop_data' : 'province_reference_profile'
                ]))
            });
        } catch (err) {
            console.error('Province intelligence error:', err);
            res.status(500).json({ error: 'Sunucu hatası' });
        }
    });
};
