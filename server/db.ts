import { base64url, sqlite } from './deps.ts';
import { clientConnectionListener } from './routers/api.ts';
import * as types from './types.ts';
import { randomStringWithEntropy } from './util.ts';

const { DB } = sqlite;

const db = new DB('./db/vaxx.db');
const schema = await Deno.readTextFile('./schema.sql');
schema.split(/\n\n/).forEach((q) => {
  try {
    db.execute(q);
  } catch (e) {
    if (!q.match('ok_to_fail')) throw e;
  }
});

export const DbLinks = {
  create(config: types.HealthLinkConfig) {
    const link = {
      config,
      id: randomStringWithEntropy(32),
      managementToken: randomStringWithEntropy(32),
      active: true,
    };
    db.query(
      `INSERT INTO shlink (id, management_token, active, config_exp, config_pin)
      values (:id, :managementToken, :active, :exp, :pin)`,
      {
        id: link.id,
        managementToken: link.managementToken,
        active: link.active,
        exp: link.config.exp,
        pin: link.config.pin,
      },
    );

    return link;
  },
  getManagedShl(linkId: string, managementToken: string): types.HealthLink {
    const linkRow = db
      .prepareQuery(`SELECT * from shlink where id=? and management_token=?`)
      .oneEntry([linkId, managementToken]);

    return {
      id: linkRow.id as string,
      active: Boolean(linkRow.active) as boolean,
      managementToken: linkRow.management_token as string,
      config: {
        exp: linkRow.config_exp as number,
        pin: linkRow.config_pin as string,
      },
    };
  },
  getShlInternal(linkId: string): types.HealthLink {
    const linkRow = db.prepareQuery(`SELECT * from shlink where id=?`).oneEntry([linkId]);
    return {
      id: linkRow.id as string,
      active: Boolean(linkRow.active) as boolean,
      managementToken: linkRow.management_token as string,
      config: {
        exp: linkRow.config_exp as number,
        pin: linkRow.config_pin as string,
      },
    };
  },
  async addFile(linkId: string, file: types.HealthLinkFile): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', file.content);
    const hashEncoded = base64url.encode(hash);
    db.query(`insert or ignore into cas_item(hash, content) values(:hashEncoded, :content)`, {
      hashEncoded,
      content: file.content,
    });

    db.query(
      `insert into shlink_file(shlink, content_type, content_hash) values (:linkId, :contentType, :hashEncoded)`,
      {
        linkId,
        contentType: file.contentType,
        hashEncoded,
      },
    );

    return hashEncoded;
  },
  getManifestFiles(linkId: string) {
    const files = db.queryEntries<{ content_type: string; content_hash: string }>(
      `select content_type, content_hash from shlink_file where shlink=?`,
      [linkId],
    );
    return files.map((r) => ({
      contentType: r.content_type as types.SHLinkManifestFile['contentType'],
      hash: r.content_hash,
    }));
  },
  getFile(shlId: string, contentHash: string): types.HealthLinkFile {
    const fileRow = db.queryEntries<{ content_type: string; content: Uint8Array }>(
      `select content_type, content from shlink_file f join cas_item c on f.content_hash=c.hash
      where f.shlink=:shlId and f.content_hash=:contentHash`,
      { shlId, contentHash },
    );

    return {
      content: fileRow[0].content,
      contentType: fileRow[0].content_type,
    };
  },
  recordAccess(shlId: string, recipient: string) {
    const q = db.prepareQuery(`insert into  shlink_access(shlink, recipient) values (?, ?)`);
    q.execute([shlId, recipient]);

    clientConnectionListener({
      shlId,
      recipient,
    });
  },
  recordPinFailure(shlId: string) {
    const q = db.prepareQuery(`update shlink set pin_failures_remaining = pin_failures_remaining - 1 where id=?`);
    q.execute([shlId]);
  },
};
