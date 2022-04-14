import { jose, oak, base64url, queryString, inflate } from '../deps.ts';

import {
  AccessTokenResponse,
  OAuthRegisterResponse,
  SHLClientConnectRequest,
  SHLClientRetrieveRequest,
  SHLClientRetrieveResponse,
  SHLClientStateDecoded,
  SHLDecoded,
} from '../types.ts';

import { decodeBase64urlToJson, decodeToJson, randomStringWithEntropy } from '../util.ts';
const { Router } = oak;

export const shlClientRouter = new Router()
  .post('/connect', async (context) => {
    const config: SHLClientConnectRequest = await context.request.body({ type: 'json' }).value;
    const shlBody = config.shl.split(/^(?:.+:\/.+#)?shlink:\//)[1];
    const parsedShl: SHLDecoded = decodeBase64urlToJson(shlBody);
    const clientKey = await jose.generateKeyPair('ES256', { extractable: true });
    const discoveryResponse = await fetch(`${parsedShl.oauth.url}/.well-known/smart-configuration`);
    const discovery: { token_endpoint: string; registration_endpoint: string } = await discoveryResponse.json();
    const registeredResponse = await fetch(`${discovery!.registration_endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${parsedShl.oauth.token}`,
      },
      body: JSON.stringify({
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['client_credentials'],
        jwks: {
          keys: [await jose.exportJWK(clientKey.publicKey)],
        },
        client_name: config.clientName, // optional
        contacts: config.clientContact ? [config.clientContact] : undefined,
      }),
    });

    const registered = (await registeredResponse.json()) as OAuthRegisterResponse;
    const stateDecoded: SHLClientStateDecoded = {
      tokenEndpoint: discovery.token_endpoint,
      clientId: registered.client_id,
      privateJwk: await jose.exportJWK(clientKey.privateKey),
    };
    const state = base64url.encode(JSON.stringify(stateDecoded));
    context.response.body = { state };
  })
  .post('/retrieve', async (context) => {
    const config: SHLClientRetrieveRequest = await context.request.body({ type: 'json' }).value;
    const state: SHLClientStateDecoded = decodeBase64urlToJson<SHLClientStateDecoded>(config.state);
    const clientKey = await jose.importJWK(state.privateJwk, 'ES256');
    const clientAssertion = await new jose.SignJWT({})
      .setIssuer(state.clientId)
      .setSubject(state.clientId)
      .setAudience(state.tokenEndpoint)
      .setExpirationTime('3 minutes')
      .setProtectedHeader({ alg: 'ES256' })
      .setJti(randomStringWithEntropy(32))
      .sign(clientKey);

    const tokenResponse = await fetch(`${state.tokenEndpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'Shlink-Pin': '1234',
      },
      body: queryString.stringify({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion,
      }),
    });

    const tokenResponseJson = (await tokenResponse.json()) as AccessTokenResponse;

    const allFiles = await Promise.all(
      tokenResponseJson.authorization_details
        .flatMap((a) => a.locations)
        .map(
          (l) =>
            fetch(l, {
              headers: {
                authorization: `Bearer ${tokenResponseJson.access_token}`,
              },
            }).then((f) => f.text()), // TODO deal with other content types
        ),
    );

    const allShcJws = allFiles.flatMap((f) => JSON.parse(f)['verifiableCredential'] as string);

    const result: SHLClientRetrieveResponse = {
      shcs: allShcJws.map((jws) => {
        const compressed = base64url.decode(jws.split('.')[1]);
        const decompressed = decodeToJson(inflate(compressed));
        return {
          jws,
          decoded: decompressed,
          validated: false,
        };
      }),
    };

    context.response.body = result;
  });

