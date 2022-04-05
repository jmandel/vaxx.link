import { base64url, jose, oak, cors, queryString } from './deps.ts';
const { Application, Router, send } = oak;
const { oakCors } = cors;
const { encode } = base64url;

const defaultEnv = {
  PUBLIC_URL: 'http://localhost:8000',
} as const;

async function envOrDefault(variable: string, defaultValue: string) {
  const havePermission = (await Deno.permissions.query({ name: 'env', variable })).state === 'granted';
  return (havePermission && Deno.env.get(variable)) || defaultValue;
}

const env = Object.fromEntries(
  await Promise.all(Object.entries(defaultEnv).map(async ([k, v]) => [k, await envOrDefault(k, v)])),
) as typeof defaultEnv;

function randomStringWithEntropy(entropy: number) {
  const b = new Uint8Array(entropy);
  crypto.getRandomValues(b);
  return encode(b.buffer);
}

interface HealthLinkConnection {
  clientId: string;
  active: boolean;
  registration: {
    name: string;
    jwks: jose.JSONWebKeySet;
  };
  log: {
    url: string;
    date: number;
  }[];
}

interface HealthLinkFile {
  contentType: string;
  content: Uint8Array;
}

interface HealthLinkConfig {
  pin?: string;
  exp?: number;
  encrypted: boolean;
}

interface HealthLink {
  config: HealthLinkConfig;
  active: boolean;
  url: string;
  token: string;
  managementToken: string;
  files?: HealthLinkFile[];
  connections: HealthLinkConnection[];
}

const DbLinks = new Map<string, HealthLink>();

interface AccessToken{
  accessToken: string,
  exp: number,
  shlink: string
}

interface ResourceAccessRight {
  type: "shlink-view",
  locations: string[]
}

interface AccessTokenResponse {
    scope: "__shlinks",
    access_token: string,
    expires_in: number,
    access: ResourceAccessRight[]
}

const DbTokens = new Map<string, AccessToken>();
function createDbLink(config: HealthLinkConfig): HealthLink {
  return {
    config,
    url: env.PUBLIC_URL,
    token: randomStringWithEntropy(32),
    managementToken: randomStringWithEntropy(32),
    active: true,
    files: [],
    connections: [],
  };
}
interface SHLinkAddFileRequest {
  id: string;
  files: HealthLinkFile[];
}

interface OAuthRegisterPayload {
  token_endpoint_auth_method: 'private_key_jwt';
  grant_types: ['client_credentials'];
  jwks: jose.JSONWebKeySet;
  client_name?: string;
  contacts?: string[];
}

interface OAuthRegisterResponse extends OAuthRegisterPayload {
  client_id: string;
}

function lookupClientId(clientId: string) {
  for (const l of DbLinks.values()) {
    for (const c of l.connections) {
      if (c.clientId === clientId) {
        return { shl: l, client: c };
      }
    }
  }
  return null;
}

function lookupAuthzToken(authzToken: string, shlId: string){
  const entry = DbTokens.get(authzToken);
  if (!entry || entry.exp < new Date().getTime()/1000) {
    console.log("No token or expired", entry, authzToken, DbTokens)
    DbTokens.delete(authzToken);
    return null
  }
  const shl = DbLinks.get(entry.shlink)
  if (shl?.token !== shlId) {
    return null;
  }
  return  shl;
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
    shl.connections = shl.connections.concat([
      {
        active: true,
        clientId,
        log: [],
        registration: {
          name: config.client_name!,
          jwks: config.jwks,
        },
      },
    ]);

    context.response.body = {
      client_id: clientId,
      scope: '__shlinks',
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
    const clientUnchecked = lookupClientId(clientIdUnchecked);
    const clientJwks = clientUnchecked!.client.registration.jwks;
    const joseJwks = jose.createLocalJWKSet(clientJwks);


    const { payload: tokenPayload, protectedHeader: tokenProtectedHeader } = await jose.jwtVerify(
      clientAssertion,
      joseJwks,
      {
        clockTolerance: '5 minutes',
        audience: `${env.PUBLIC_URL}/oauth/token`,
      },
    );

    console.log('validated', tokenPayload, tokenProtectedHeader);

    const client = clientUnchecked! // rename to clarify status
    const token: AccessToken = {
      accessToken: randomStringWithEntropy(32),
      exp: new Date().getTime() / 1000 + 300,
      shlink: client.shl.token
    }

    DbTokens.set(token.accessToken, token)
    console.log("Dbt", DbTokens)

    context.response.body = {
      scope: "__shlinks",
      access_token: token.accessToken,
      expires_in: 300,
      access: (client.shl.files || []).map((_f, i) => ({
        type: "shlink-view",
        locations: [`${env.PUBLIC_URL}/api/shl/${client.shl.token}/file/${i}`],
      }))
    }
  });

const shlApiRouter = new Router()
  .post('/shl', async (context) => {
    const config: HealthLinkConfig = await context.request.body({ type: 'json' }).value;
    const newLink = createDbLink(config);
    DbLinks.set(newLink.token, newLink);
    context.response.body = {
      ...newLink,
      files: undefined,
      config: undefined,
    };
  })
  .get('/shl/:shlId/file/:fileIndex', (context) => {
    const authzToken = context.request.headers.get("authorization")!.split(/bearer /i)[1];
    const shl = lookupAuthzToken(authzToken, context.params.shlId);
    if (!shl) {
      console.log("Invalid token", authzToken, DbTokens.get(authzToken))
      return context.response.status = 401;
    }

    const file = shl.files![Number(context.params.fileIndex)];
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

    shl.files = shl.files!.concat({
      contentType: context.request.headers.get('content-type')!,
      content: await newFileBody.value,
    });

    context.response.body = {
      ...shl,
      files: undefined,
      addedFiles: shl.files.length,
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

const app = new Application();
app.use(oakCors());

const appRouter = new Router()
  .get('/', async (context) => {
    await send(context, context.request.url.pathname, {
      root: `${Deno.cwd()}/static/`,
      index: 'index.html',
    });
  })
  .use(`/api`, shlApiRouter.routes(), shlApiRouter.allowedMethods())
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

console.info('CORS-enabled web server listening on port 8000');
app.listen({ port: parseInt(Deno.env.get('PORT') || '8000') });

async function test() {
  console.log('Testing server');
  const clientKey = await jose.generateKeyPair('ES256');

  const shlResponse = await fetch(`${env.PUBLIC_URL}/api/shl`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      encrypted: true,
      pin: '1234',
    }),
  });

  const shl = (await shlResponse.json()) as HealthLink;
  console.log('SHL', shl);

 const shlFileResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl.token}/file`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${shl.managementToken}`
    },
    body: JSON.stringify({arbitrary: true, answer: 42}),
  });

  const shlFile = await shlFileResponse.json();
  console.log("SHL file response", shlFile)
  

  const discoveryResponse = await fetch(`${shl.url}/.well-known/smart-configuration`);
  const discovery: { token_endpoint: string; registration_endpoint: string } = await discoveryResponse.json();

  const registeredResponse = await fetch(`${discovery.registration_endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${shl.token}`,
    },
    body: JSON.stringify({
      token_endpoint_auth_method: 'private_key_jwt',
      grant_types: ['client_credentials'],
      jwks: {
        keys: [await jose.exportJWK(clientKey.publicKey)],
      },
      client_name: "Dr. B's Quick Response Squared", // optional
      contacts: ['drjones@clinic.com'], // optional
    }),
  });

  const registered = (await registeredResponse.json()) as OAuthRegisterResponse;
  console.log('Registered', JSON.stringify(registered, null, 2));

  const clientAssertion = await new jose.SignJWT({
    sub_jwk: await jose.exportJWK(clientKey.publicKey),
  })
    .setIssuer(registered.client_id)
    .setSubject(registered.client_id)
    .setAudience(`${env.PUBLIC_URL}/oauth/token`)
    .setExpirationTime('3 minutes')
    .setProtectedHeader({ alg: 'ES256' })
    .setJti(randomStringWithEntropy(32))
    .sign(clientKey.privateKey);

  console.log('Generated assertion', clientAssertion);
  const tokenResponse = await fetch(`${discovery.token_endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Shlink-Pin': '1234',
    },
    body: queryString.stringify({
      scope: '__shlinks',
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    }),
  });

  const tokenResponseJson = await tokenResponse.json() as AccessTokenResponse;
  console.log("Access Token Response", tokenResponseJson)

  const fileResponse = await fetch(tokenResponseJson.access[0].locations[0], {
    headers: {
      'Authorization': `Bearer ${tokenResponseJson.access_token}`
    }
  })

  const file = await fileResponse.text()
  console.log("got filef", fileResponse.status, file)
}

test();
