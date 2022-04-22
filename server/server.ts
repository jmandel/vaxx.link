import { oak, cors } from './deps.ts';
import { shlApiRouter } from './routers/api.ts';
const { Application, Router } = oak;
const { oakCors } = cors;

const app = new Application({ logErrors: false });
app.use(oakCors());

const appRouter = new Router()
  .get('/', (context) => {
    context.response.body = 'Index';
  })
  .use(`/api`, shlApiRouter.routes(), shlApiRouter.allowedMethods())

app.use(appRouter.routes());
app.addEventListener('error', (evt) => {
  if (evt?.error.toString().startsWith('Http: connection closed before message completed')) {
    // normal expected behavior after a SSE connection dies
    // See https://github.com/oakserver/oak/issues/387
    return;
  }
  console.log('App', evt.type, '>', evt.message, '>', evt.error, '<<');
});

const port = parseInt(Deno.env.get('PORT') || '8000');
console.info('CORS-enabled web server listening on port ' + port);
app.listen({ port });
export default app;
