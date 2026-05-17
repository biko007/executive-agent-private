ALTER TABLE vehicles
  ADD COLUMN fuel_type TEXT
    CHECK (fuel_type IS NULL OR fuel_type = ANY (ARRAY[
      'gasoline','diesel','electric','hybrid','plugin_hybrid','lpg','cng','hydrogen'
    ]));
