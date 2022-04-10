import env from './config.ts';
import { jose, oak, cors, base64url, queryString } from './deps.ts';
import { inflate } from 'https://deno.land/x/denoflate@1.2.1/mod.ts';

import {
  AccessToken as AccessTokenStored,
  AccessTokenResponse,
  HealthLink,
  HealthLinkConfig,
  OAuthRegisterPayload,
  OAuthRegisterResponse,
  SHLClientConnectRequest,
  SHLClientRetrieveRequest,
  SHLClientRetrieveResponse,
  SHLClientStateDecoded,
  SHLDecoded,
} from './types.ts';

import { decodeBase64urlToJson, decodeToJson, randomStringWithEntropy } from './util.ts';
import { DbLinks } from './db.ts';

const { Application, Router } = oak;
const { oakCors } = cors;

const DbTokens = new Map<string, AccessTokenStored>();

function createDbLink(config: HealthLinkConfig): HealthLink {
  return {
    config,
    url: env.PUBLIC_URL,
    token: randomStringWithEntropy(32),
    managementToken: randomStringWithEntropy(32),
    active: true,
  };
}

function lookupAuthzToken(authzToken: string, shlId: string) {
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

const oauthRouter = new Router()
  .post('/register', async (context) => {
    const config: OAuthRegisterPayload = await context.request.body({ type: 'json' }).value;

    if (config.token_endpoint_auth_method !== 'private_key_jwt') {
      throw 'Cannot support token endpoint auth method ' + config.token_endpoint_auth_method;
    }

    if (config.grant_types.length !== 1 || config.grant_types[0] !== 'client_credentials') {
      throw 'Cannot support grant_types ' + JSON.stringify(config.grant_types);
    }

    const shlId = context.request.headers.get('authorization')!.split(/bearer /i)[1];
    const shl = DbLinks.get(shlId);
    if (!shl) {
      throw 'Cannot authorize; SHL does not exist';
    }

    if (!shl.active) {
      throw 'Cannot authorize; SHL is not active';
    }

    const clientId = randomStringWithEntropy(32);
    DbLinks.addConnection({
      shlink: shl.token,
      active: true,
      clientId,
      log: [],
      registration: {
        name: config.client_name!,
        jwks: config.jwks,
      },
    });

    context.response.body = {
      client_id: clientId,
      grant_types: ['client_credentials'],
      jwks: config.jwks,
      client_name: config.client_name,
      contacts: config.contacts,
      token_endpoint_auth_method: config.token_endpoint_auth_method,
    };
  })
  .post('/token', async (context) => {
    const config = await context.request.body({ type: 'form' }).value;
    const [_scope, grantType, clientAssertionType, clientAssertion] = [
      'scope',
      'grant_type',
      'client_assertion_type',
      'client_assertion',
    ].map((k) => config.get(k)!);

    if (grantType !== 'client_credentials') {
      throw 'Unrecognized grant_type ' + grantType;
    }

    if (clientAssertionType !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
      throw 'Unrecognized client_assertion__type ' + clientAssertionType;
    }

    const clientIdUnchecked = jose.decodeJwt(clientAssertion).iss!;
    const clientUnchecked = DbLinks.getClient(clientIdUnchecked);
    const clientJwks = clientUnchecked!.registration.jwks;
    const joseJwks = jose.createLocalJWKSet(clientJwks);

    const _tokenVerified = await jose.jwtVerify(clientAssertion, joseJwks, {
      clockTolerance: '5 minutes',
      audience: `${env.PUBLIC_URL}/oauth/token`,
    });

    const client = clientUnchecked!; // rename to affirm validated status
    const token: AccessTokenStored = {
      accessToken: randomStringWithEntropy(32),
      exp: new Date().getTime() / 1000 + 300,
      shlink: client.shlink,
    };

    DbTokens.set(token.accessToken, token);
    const acccssTokenResponse: AccessTokenResponse = {
      access_token: token.accessToken,
      expires_in: 300,
      authorization_details: [
        {
          type: 'shlink-view',
          locations: DbLinks.fileNames(client.shlink).map(
            (f, _i) => `${env.PUBLIC_URL}/api/shl/${client.shlink}/file/${f}`,
          ),
        },
      ],
    };
    context.response.body = acccssTokenResponse;
  });

const shlApiRouter = new Router()
  .post('/shl', async (context) => {
    const config: HealthLinkConfig = await context.request.body({ type: 'json' }).value;
    const newLink = createDbLink(config);
    DbLinks.create(newLink);
    context.response.body = {
      ...newLink,
      files: undefined,
      config: undefined,
    };
  })
  .get('/shl/:shlId/file/:fileIndex', (context) => {
    const authzToken = context.request.headers.get('authorization')!.split(/bearer /i)[1];
    const shl = lookupAuthzToken(authzToken, context.params.shlId);
    if (!shl) {
      console.log('Invalid token', authzToken, DbTokens.get(authzToken));
      return (context.response.status = 401);
    }

    const file = DbLinks.getFile(shl.token, context.params.fileIndex);
    context.response.headers.set('content-type', file.contentType);
    context.response.body = file.content;
  })
  .get('/shl/:shlId', (context) => {
    //TODO Remove this debugging function
    const shl = DbLinks.get(context.params.shlId)!;
    context.response.headers.set('content-type', 'application/json');
    context.response.body = {
      ...shl,
      files: undefined,
      config: undefined,
    };
  })
  .post('/shl/:shlId/file', async (context) => {
    const managementToken = await context.request.headers.get('authorization')?.split(/bearer /i)[1];
    const newFileBody = await context.request.body({ type: 'bytes' });

    const shl = DbLinks.get(context.params.shlId)!;
    if (!shl || managementToken !== shl.managementToken) {
      throw new Error(`Can't manage SHLink ` + context.params.shlId);
    }

    const newFile = {
      contentType: context.request.headers.get('content-type')!,
      content: await newFileBody.value,
    };

    const added = DbLinks.addFile(shl.token, newFile);
    context.response.body = {
      ...shl,
      added,
    };
  })
  .get('/jwt-demo', async (context) => {
    const key = await jose.generateKeyPair('ES384');
    context.response.body = {
      jws: await new jose.SignJWT({ a: 1, b: 2 })
        .setIssuer('https://issuer.example.org')
        .setProtectedHeader({ alg: 'ES384' })
        .sign(key.privateKey),
    };
  });

const shlClientRouter = new Router()
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

const app = new Application();
app.use(oakCors());

const appRouter = new Router()
  .get('/', (context) => {
    context.response.body = 'Index';
  })
  .use(`/api`, shlApiRouter.routes(), shlApiRouter.allowedMethods())
  .use(`/client`, shlClientRouter.routes(), shlClientRouter.allowedMethods())
  .use(`/oauth`, oauthRouter.routes(), oauthRouter.allowedMethods())
  .get(`/.well-known/smart-configuration`, (context) => {
    context.response.body = {
      issuer: env.PUBLIC_URL,
      token_endpoint: `${env.PUBLIC_URL}/oauth/token`,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      grant_types_supported: ['client_credentials'],
      registration_endpoint: `${env.PUBLIC_URL}/oauth/register`,
      scopes_supported: ['__shlinks'],
      response_types_supported: ['token'],
      capabilities: ['shlinks'],
    };
  });

app.use(appRouter.routes());
export const controller = new AbortController();
console.info('CORS-enabled web server listening on port 8000');
app.listen({ port: parseInt(Deno.env.get('PORT') || '8000'), signal: controller.signal });
export default app;
