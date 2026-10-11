CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, price REAL NOT NULL, image_key TEXT NOT NULL);
INSERT OR IGNORE INTO products VALUES ('demo-product','Orbit lamp','A warm ceramic lamp for your reading corner.',42.5,'orbit.svg'),('healthy-control','Fern planter','A small sculpted home for your favorite fern.',17.25,'fern.svg'),('trace-clock','Trace clock','Quiet timekeeping with a terracotta face.',29.0,'clock.svg');
CREATE TABLE IF NOT EXISTS demo_control (id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL, expires_at INTEGER NOT NULL, release TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thumbnail_jobs (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT);
CREATE TABLE IF NOT EXISTS demo_events (id TEXT PRIMARY KEY, release TEXT NOT NULL, phase TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS demo_event_delivery (event_id TEXT PRIMARY KEY, delivered_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS heartbeats (day TEXT PRIMARY KEY, completed_at INTEGER NOT NULL, trace_id TEXT NOT NULL, source TEXT NOT NULL);
