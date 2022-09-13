import { base64url, queryString, sqlite } from './deps.ts';
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

async function updateAccessToken(endpoint: types.HealthLinkEndpoint) {
  const accessTokenRequest = await fetch(endpoint.config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${endpoint.config.clientId}:${endpoint.config.clientSecret}`)}`,
    },
    body: queryString.stringify({ grant_type: 'refresh_token', refresh_token: endpoint.config.refreshToken }),
  });
  const accessTokenResponse = await accessTokenRequest.json();


  endpoint.accessTokenResponse = accessTokenResponse;
  if (endpoint?.accessTokenResponse?.refresh_token) {
    endpoint.config.refreshToken = endpoint.accessTokenResponse.refresh_token;
    delete endpoint.accessTokenResponse.refresh_token;
  }
  const TOKEN_LIFETIME_SECONDS = 300;
  endpoint.refreshTime = new Date(new Date().getTime() + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
}

export const DbLinks = {
  create(config: types.HealthLinkConfig) {
    const link = {
      config,
      id: randomStringWithEntropy(32),
      managementToken: randomStringWithEntropy(32),
      active: true,
    };
    db.query(
      `INSERT INTO shlink (id, management_token, active, config_exp, config_passcode)
      values (:id, :managementToken, :active, :exp, :passcode)`,
      {
        id: link.id,
        managementToken: link.managementToken,
        active: link.active,
        exp: link.config.exp,
        passcode: link.config.passcode,
      },
    );

    return link;
  },
  deactivate(shl: types.HealthLink) {
    db.query(`UPDATE shlink set active=false where id=?`, [shl.id]);
    return true;
  },
  getManagedShl(linkId: string, managementToken: string): types.HealthLink {
    const linkRow = db
      .prepareQuery(`SELECT * from shlink where id=? and management_token=?`)
      .oneEntry([linkId, managementToken]);

    return {
      id: linkRow.id as string,
      passcodeFailuresRemaining: linkRow.passcode_failures_remaining as number,
      active: Boolean(linkRow.active) as boolean,
      managementToken: linkRow.management_token as string,
      config: {
        exp: linkRow.config_exp as number,
        passcode: linkRow.config_passcode as string,
      },
    };
  },
  getShlInternal(linkId: string): types.HealthLink {
    const linkRow = db.prepareQuery(`SELECT * from shlink where id=?`).oneEntry([linkId]);
    return {
      id: linkRow.id as string,
      passcodeFailuresRemaining: linkRow.passcode_failures_remaining as number,
      active: Boolean(linkRow.active) as boolean,
      managementToken: linkRow.management_token as string,
      config: {
        exp: linkRow.config_exp as number,
        passcode: linkRow.config_passcode as string,
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
  async addEndpoint(linkId: string, endpoint: types.HealthLinkEndpoint): Promise<string> {
    const id = randomStringWithEntropy(32);

    await updateAccessToken(endpoint);
    db.query(
      `insert into shlink_endpoint(
          id, shlink, endpoint_url,
          config_key, config_client_id, config_client_secret, config_token_endpoint, config_refresh_token, refresh_time,
          access_token_response)
        values (
          :id, :linkId, :endpointUrl, :key, :clientId, :clientSecret, :tokenEndpoint, :refreshToken, :refreshTime, :accessTokenResponse
        )`,
      {
        id,
        linkId,
        endpointUrl: endpoint.endpointUrl,
        key: endpoint.config.key,
        clientId: endpoint.config.clientId,
        clientSecret: endpoint.config.clientSecret,
        tokenEndpoint: endpoint.config.tokenEndpoint,
        refreshTime: endpoint.refreshTime,
        refreshToken: endpoint.config.refreshToken,
        accessTokenResponse: JSON.stringify(endpoint.accessTokenResponse),
      },
    );

    return id;
  },
  async saveEndpoint(endpoint: types.HealthLinkEndpoint): Promise<boolean> {
    db.query(`update shlink_endpoint set config_refresh_token=?, refresh_time=?, access_token_response=? where id=?`, [
      endpoint.config.refreshToken,
      endpoint.refreshTime,
      JSON.stringify(endpoint.accessTokenResponse),
      endpoint.id,
    ]);
    return await true;
  },
  getManifestFiles(linkId: string, maxEmbedBytes?: number) {
    const files = db.queryEntries<{ content_type: string; content_hash: string, content?: Uint8Array }>(
      `select
      content_type,
      content_hash,
      (case when length(cas_item.content) <= ${maxEmbedBytes} then cas_item.content else NULL end) as content
      from shlink_file
      join cas_item on shlink_file.content_hash=cas_item.hash
      where shlink=?`,
      [linkId],
    );
    return files.map((r) => ({
      contentType: r.content_type as types.SHLinkManifestFile['contentType'],
      hash: r.content_hash,
      content: r.content
    }));
  },
  getManifestEndpoints(linkId: string) {
    const endpoints = db.queryEntries<{ id: string }>(`select id from shlink_endpoint where shlink=?`, [linkId]);
    return endpoints.map((e) => ({
      contentType: 'application/smart-api-access',
      id: e.id,
    }));
  },
  async getEndpoint(linkId: string, endpointId: string): Promise<types.HealthLinkEndpoint> {
    const endpointRow = db
      .prepareQuery<
        Array<unknown>,
        {
          id: string;
          endpoint_url: string;
          config_key: string;
          config_client_id: string;
          config_client_secret: string;
          config_token_endpoint: string;
          config_refresh_token: string;
          refresh_time: string;
          access_token_response: string;
        }
      >(
        `select
        id, endpoint_url,
        config_key, config_client_id, config_client_secret, config_token_endpoint, config_refresh_token,
        refresh_time, access_token_response
      from shlink_endpoint where shlink=? and id=?`,
      )
      .oneEntry([linkId, endpointId]);

    const endpoint: types.HealthLinkEndpoint = {
      id: endpointRow.id,
      endpointUrl: endpointRow.endpoint_url,
      config: {
        key: endpointRow.config_key,
        clientId: endpointRow.config_client_id,
        clientSecret: endpointRow.config_client_secret,
        refreshToken: endpointRow.config_refresh_token,
        tokenEndpoint: endpointRow.config_token_endpoint,
      },
      refreshTime: endpointRow.refresh_time,
      accessTokenResponse: JSON.parse(endpointRow.access_token_response),
    };

    if (new Date(endpoint.refreshTime!).getTime() < new Date().getTime()) {
      await updateAccessToken(endpoint);
      await DbLinks.saveEndpoint(endpoint);
    }

    return endpoint;
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
  recordPasscodeFailure(shlId: string) {
    const q = db.prepareQuery(`update shlink set passcode_failures_remaining = passcode_failures_remaining - 1 where id=?`);
    q.execute([shlId]);
  },
};
