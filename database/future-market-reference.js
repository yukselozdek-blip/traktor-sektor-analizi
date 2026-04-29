const commodityYearBase = {
    WHEAT: { 2022: 100, 2023: 118, 2024: 129, 2025: 135 },
    CORN: { 2022: 100, 2023: 123, 2024: 137, 2025: 144 },
    SUNFLOWER: { 2022: 100, 2023: 114, 2024: 126, 2025: 132 },
    COTTON: { 2022: 100, 2023: 131, 2024: 146, 2025: 154 },
    SUGAR_BEET: { 2022: 100, 2023: 109, 2024: 118, 2025: 124 },
    BARLEY: { 2022: 100, 2023: 116, 2024: 127, 2025: 134 }
};

const monthlySeasonality = [0.96, 0.97, 0.99, 1.00, 1.01, 1.03, 1.05, 1.06, 1.03, 1.01, 0.98, 0.96];

const regionClimateScenarioReference = {
    Akdeniz: {
        reference_base: { 2030: { temp_change_c: 1.10, rainfall_change_pct: -4.5, drought_risk_pct: 6.0 }, 2035: { temp_change_c: 1.35, rainfall_change_pct: -6.5, drought_risk_pct: 9.0 } },
        reference_stress: { 2030: { temp_change_c: 1.35, rainfall_change_pct: -6.0, drought_risk_pct: 9.0 }, 2035: { temp_change_c: 1.70, rainfall_change_pct: -8.5, drought_risk_pct: 13.0 } }
    },
    Ege: {
        reference_base: { 2030: { temp_change_c: 1.00, rainfall_change_pct: -3.5, drought_risk_pct: 5.0 }, 2035: { temp_change_c: 1.25, rainfall_change_pct: -5.5, drought_risk_pct: 7.0 } },
        reference_stress: { 2030: { temp_change_c: 1.25, rainfall_change_pct: -5.0, drought_risk_pct: 7.0 }, 2035: { temp_change_c: 1.55, rainfall_change_pct: -7.5, drought_risk_pct: 10.0 } }
    },
    'İç Anadolu': {
        reference_base: { 2030: { temp_change_c: 1.15, rainfall_change_pct: -3.0, drought_risk_pct: 6.5 }, 2035: { temp_change_c: 1.45, rainfall_change_pct: -5.0, drought_risk_pct: 9.5 } },
        reference_stress: { 2030: { temp_change_c: 1.40, rainfall_change_pct: -4.5, drought_risk_pct: 9.0 }, 2035: { temp_change_c: 1.80, rainfall_change_pct: -7.0, drought_risk_pct: 13.5 } }
    },
    'Güneydoğu Anadolu': {
        reference_base: { 2030: { temp_change_c: 1.20, rainfall_change_pct: -5.0, drought_risk_pct: 7.0 }, 2035: { temp_change_c: 1.55, rainfall_change_pct: -7.5, drought_risk_pct: 10.5 } },
        reference_stress: { 2030: { temp_change_c: 1.50, rainfall_change_pct: -7.0, drought_risk_pct: 10.5 }, 2035: { temp_change_c: 1.95, rainfall_change_pct: -10.0, drought_risk_pct: 15.0 } }
    },
    'Doğu Anadolu': {
        reference_base: { 2030: { temp_change_c: 0.90, rainfall_change_pct: -2.0, drought_risk_pct: 3.0 }, 2035: { temp_change_c: 1.15, rainfall_change_pct: -3.5, drought_risk_pct: 5.5 } },
        reference_stress: { 2030: { temp_change_c: 1.15, rainfall_change_pct: -3.5, drought_risk_pct: 5.0 }, 2035: { temp_change_c: 1.50, rainfall_change_pct: -5.5, drought_risk_pct: 8.0 } }
    },
    Karadeniz: {
        reference_base: { 2030: { temp_change_c: 0.70, rainfall_change_pct: 0.5, drought_risk_pct: 1.0 }, 2035: { temp_change_c: 0.95, rainfall_change_pct: -0.5, drought_risk_pct: 2.0 } },
        reference_stress: { 2030: { temp_change_c: 0.95, rainfall_change_pct: -1.5, drought_risk_pct: 2.5 }, 2035: { temp_change_c: 1.30, rainfall_change_pct: -3.0, drought_risk_pct: 4.5 } }
    },
    Marmara: {
        reference_base: { 2030: { temp_change_c: 0.80, rainfall_change_pct: -1.5, drought_risk_pct: 2.0 }, 2035: { temp_change_c: 1.05, rainfall_change_pct: -2.5, drought_risk_pct: 3.5 } },
        reference_stress: { 2030: { temp_change_c: 1.05, rainfall_change_pct: -2.5, drought_risk_pct: 3.5 }, 2035: { temp_change_c: 1.35, rainfall_change_pct: -4.0, drought_risk_pct: 6.0 } }
    }
};

module.exports = {
    commodityYearBase,
    monthlySeasonality,
    regionClimateScenarioReference
};
