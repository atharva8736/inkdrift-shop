-- Device-specific products. Every sellable item ("SKU") is one wallpaper, one pack or the whole collection for ONE device
-- (or, for a single wallpaper, all devices). base_id points at the wallpaper / pack the SKU sells.
ALTER TABLE products ADD COLUMN base_id TEXT;
ALTER TABLE products ADD COLUMN device TEXT;

-- The real files that exist: one row per wallpaper and device, with its true pixel size.
CREATE TABLE variants (
  wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id),
  device       TEXT NOT NULL CHECK (device IN ('iphone','android','windows','mac')),
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  source_w     INTEGER NOT NULL,                          -- size of the original picture this was cut from
  source_h     INTEGER NOT NULL,
  upscale      REAL NOT NULL,                             -- how much the crop was enlarged to reach width x height
  file         TEXT NOT NULL,                             -- path under private/variants
  PRIMARY KEY (wallpaper_id, device)
);

-- The old pack/bundle products are replaced by per-device ones. Keep the rows so old orders still read correctly.
UPDATE products SET active = 0 WHERE base_id IS NULL AND type IN ('pack','bundle');
