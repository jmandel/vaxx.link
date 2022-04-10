import env from './config.ts';
import { oak, cors } from './deps.ts';
import { shlClientRouter } from './routers/client.ts';
import { shlApiRouter } from './routers/api.ts';
import { oauthRouter } from './routers/oauth.ts';
const { Application, Router } = oak;
const { oakCors } = cors;

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
const port = parseInt(Deno.env.get('PORT') || '8000');
console.info('CORS-enabled web server listening on port ' + port);
app.listen({ port });
export default app;
