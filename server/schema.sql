CREATE TABLE IF NOT EXISTS cas_item(
  hash VARCHAR(32) PRIMARY KEY UNIQUE,
  content BLOB UNIQUE,
  ref_count INTEGER DEFAULT(0)
);

CREATE TABLE IF NOT EXISTS shlink(
  id VARCHAR(43) PRIMARY KEY UNIQUE,
  pin_failures_remaining INTEGER DEFAULT(5),
  config_pin TEXT,
  config_exp DATETIME,
  active BOOLEAN NOT NULL DEFAULT(true),
  management_token VARCHAR(43) NOT NULL
);

CREATE TABLE IF NOT EXISTS shlink_file(
  shlink VARCHAR(43) REFERENCES shlink(id),
  content_type TEXT NOT NULL DEFAULT "application/json",
  content_hash TEXT REFERENCES cas_item(hash)
);

CREATE TABLE IF NOT EXISTS shlink_access(
  shlink VARCHAR(43) REFERENCES shlink(id),
  recipient TEXT NOT NULL,
  access_time DATETIME NOT NULL DEFAULT(DATETIME('now'))
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

create trigger if not exists disable_shlink_on_pin_failure
  after update on shlink
  for each row
    begin
        update shlink set active=false where new.pin_failures_remaining <= 0;
    end;