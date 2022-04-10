import { Router } from 'https://deno.land/x/oak@v10.5.1/router.ts';
import { createDbLink, DbLinks, DbTokens, lookupAuthzToken } from '../db.ts';
import { HealthLinkConfig } from '../types.ts';
export const shlApiRouter = new Router()
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
  });
