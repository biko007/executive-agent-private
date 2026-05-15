-- V031__heating_pellets.sql — Sprint 5d.1 Patch: Pellets in heating Enums
-- Erweitert properties.heating_type um 'pellets'
-- Erweitert property_heating_config.heating_system um 'central_pellets'

ALTER TABLE properties
  DROP CONSTRAINT properties_heating_type_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_heating_type_check
  CHECK (heating_type IS NULL OR heating_type IN
    ('gas','oil','heat_pump','district','electric','none','pellets'));

ALTER TABLE property_heating_config
  DROP CONSTRAINT property_heating_config_heating_system_check;
ALTER TABLE property_heating_config
  ADD CONSTRAINT property_heating_config_heating_system_check
  CHECK (heating_system IN
    ('central_gas','central_oil','district','heat_pump','electric','none','central_pellets'));

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('assets', 31)
  ON CONFLICT (module, version) DO NOTHING;
