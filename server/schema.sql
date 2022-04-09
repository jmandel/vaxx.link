CREATE TABLE IF NOT EXISTS cas_item(
  hash VARCHAR(32) PRIMARY KEY UNIQUE,
  content BLOB UNIQUE,
  ref_count INTEGER DEFAULT(0)
);

CREATE TABLE IF NOT EXISTS shlink(
  token VARCHAR(43) PRIMARY KEY UNIQUE,
  url TEXT NOT NULL,
  config_pin TEXT,
  config_exp DATETIME,
  config_encrypted BOOLEAN NOT NULL DEFAULT(false),
  active BOOLEAN NOT NULL DEFAULT(true),
  management_token VARCHAR(43) NOT NULL
);

CREATE TABLE IF NOT EXISTS shlink_file(
  shlink VARCHAR(43) REFERENCES shlink(token),
  content_type TEXT NOT NULL DEFAULT "application/octet-stream",
  content_hash TEXT REFERENCES cas_item(hash)
);

CREATE TABLE IF NOT EXISTS shlink_client(
  id TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT(true),
  shlink TEXT REFERENCES shlink(token) ON DELETE CASCADE,
  registration_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shlink_client_access(
  client_id REFERENCES shlink_client(id) ON DELETE CASCADE,
  "when" DATETIME NOT NULL DEFAULT(DATETIME('now')),
  what TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS delete_cas_on_ref_count_0
  AFTER UPDATE OF ref_count ON cas_item
  FOR EACH ROW WHEN new.ref_count=0
    BEGIN
        delete from cas_item where hash=new.hash;
    END;

CREATE TRIGGER IF NOT EXISTS insert_link_to_cas
  AFTER INSERT ON shlink_file
  FOR EACH ROW
    BEGIN
        update cas_item set ref_count=ref_count+1 where hash=NEW.content_hash;
    END;
