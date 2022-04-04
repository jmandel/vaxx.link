import { base64url, jose, oak, cors } from './deps.ts';
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
  await Promise.all(
    Object.entries(defaultEnv).map(async ([k, v]) => [k, await envOrDefault(k, v)]),
  ),
) as typeof defaultEnv;

const authzUrl = env.PUBLIC_URL + '/authorize';

function randomStringWithEntropy(entropy: number) {
  const b = new Uint8Array(entropy);
  crypto.getRandomValues(b);
  return encode(b.buffer);
}

interface HealthLinkConnection {
  name: string;
  active: boolean;
  jwk: Record<string, unknown>;
  log: {
    url: string;
    date: number;
  };
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

function createDbLink(config: HealthLinkConfig): HealthLink {
  return {
    config,
    url: authzUrl,
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

const router = new Router()
  .get('/', async (context) => {
    await send(context, context.request.url.pathname, {
      root: `${Deno.cwd()}/static/`,
      index: 'index.html',
    });
  })
  .post('/shl', async (context) => {
    const config: HealthLinkConfig = await context.request.body({ type: 'json' }).value;
    const newLink = createDbLink(config);
    DbLinks.set(newLink.token, newLink);
    context.response.body = {
      ...newLink,
      files: undefined,
    };
  })
  .get('/shl/:shlId/file/:fileIndex', (context) => {
    // TODO add authz ;-)
    const shl = DbLinks.get(context.params.shlId)!;
    const file = shl.files![Number(context.params.fileIndex)];
    context.response.headers.set('content-type', file.contentType);
    context.response.body = file.content;
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
app.use(router.routes());

console.info('CORS-enabled web server listening on port 8000');
await app.listen({ port: parseInt(Deno.env.get('PORT') || '8000') });
