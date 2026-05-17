-- V036: Add property polish fields (construction_year, primary_energy, market_value, rent_override)
-- Sprint Polish-1

ALTER TABLE properties
  ADD COLUMN construction_year INTEGER
    CHECK (construction_year IS NULL OR (construction_year >= 1800 AND construction_year <= 2100)),
  ADD COLUMN primary_energy_kwh_m2 NUMERIC(7,2)
    CHECK (primary_energy_kwh_m2 IS NULL OR primary_energy_kwh_m2 >= 0),
  ADD COLUMN current_market_value NUMERIC(14,2)
    CHECK (current_market_value IS NULL OR current_market_value >= 0),
  ADD COLUMN monthly_rent_override NUMERIC(10,2)
    CHECK (monthly_rent_override IS NULL OR monthly_rent_override >= 0);
