import env from "./config.ts";
import { base64url, sqlite } from './deps.ts';
import { AccessToken, HealthLink, HealthLinkConfig, HealthLinkConnection, HealthLinkFile } from './types.ts';
import { randomStringWithEntropy } from "./util.ts";

const { DB } = sqlite;

const db = new DB('./db/vaxx.db');
const schema = await Deno.readTextFile('./schema.sql');
db.execute(schema);

export const DbLinks = {
  create(link: HealthLink) {
    db.query(
      `INSERT INTO shlink (token, url, management_token, active, config_exp, config_pin, config_encrypted)
      values (:token, :url, :managementToken, :active, :exp, :pin, :encrypted)`,
      {
        token: link.token,
        url: link.url,
        managementToken: link.managementToken,
        active: link.active,
        exp: link.config.exp,
        pin: link.config.pin,
        encrypted: link.config.encrypted,
      },
    );
  },
  get(linkId: string): HealthLink {
    const linkRow = db.prepareQuery(`SELECT * from shlink where token=?`).oneEntry([linkId]);
    return {
      token: linkRow.token as string,
      active: linkRow.active as boolean,
      url: linkRow.url as string,
      managementToken: linkRow.management_token as string,
      config: {
        exp: linkRow.config_exp as number,
        encrypted: linkRow.encrypted as boolean,
        pin: linkRow.config_pin as string,
      },
    };
  },
  async addFile(linkId: string, file: HealthLinkFile): Promise<string> {
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
  addConnection(client: HealthLinkConnection) {
    db.query(
      `insert into shlink_client(id, active, shlink, registration_json) values (:clientId, :active, :shlink, :registration)`,
      {
        clientId: client.clientId,
        active: client.active,
        shlink: client.shlink,
        registration: JSON.stringify(client.registration),
      },
    );
  },
  fileNames(linkId: string): string[] {
    const files = db.queryEntries<{ content_hash: string }>(`select content_hash from shlink_file where shlink=?`, [
      linkId,
    ]);
    return files.map((r) => r.content_hash);
  },
  getFile(linkId: string, contentHash: string): HealthLinkFile {
    const fileRow = db.queryEntries<{ content_type: string; content: Uint8Array }>(
      `select content_type, content from shlink_file f join cas_item c on f.content_hash=c.hash
      where f.shlink=:linkId and f.content_hash=:contentHash`,
      { linkId, contentHash },
    );

    return {
      content: fileRow[0].content,
      contentType: fileRow[0].content_type,
    };
  },
  getClient(clientId: string) {
    const q = db.prepareQuery(`select * from shlink_client where id=?`);
    const clientRow = q.oneEntry([clientId]);
    const clientConnection: HealthLinkConnection = {
      shlink: clientRow.shlink as string,
      clientId: clientRow.id as string,
      active: clientRow.active as boolean,
      registration: JSON.parse(clientRow.registration_json as string),
      log: [],
    };
    return clientConnection;
  },
};

export const DbTokens = new Map<string, AccessToken>();


export function createDbLink(config: HealthLinkConfig): HealthLink {
  return {
    config,
    url: env.PUBLIC_URL,
    token: randomStringWithEntropy(32),
    managementToken: randomStringWithEntropy(32),
    active: true,
  };
}

export function lookupAuthzToken(authzToken: string, shlId: string) {
  const entry = DbTokens.get(authzToken);
  if (!entry || entry.exp < new Date().getTime() / 1000) {
    console.log('No token or expired', entry, authzToken, DbTokens);
    DbTokens.delete(authzToken);
    return null;
  }
  const shl = DbLinks.get(entry.shlink);
  if (shl?.token !== shlId) {
    return null;
  }
  return shl;
}

