import env from '../config.ts';
import { oak } from '../deps.ts';
import { createDbLink, DbLinks, DbTokens, lookupAuthzToken } from '../db.ts';
import { HealthLinkConfig, HealthLinkConnection } from '../types.ts';
import { randomStringWithEntropy } from '../util.ts';

type SubscriptionTicket = string;
type SubscriptionSet = string[];
const subscriptionTickets: Map<SubscriptionTicket, SubscriptionSet> = new Map();

const accessLogSubscriptions: Map<string, oak.ServerSentEventTarget[]> = new Map();
export const clientConnectionListener = (cxn: HealthLinkConnection) => {
  const shl = cxn.shlink;
  (accessLogSubscriptions.get(shl) || []).forEach((t, i) => {
    t.dispatchEvent(new oak.ServerSentEvent('connection', cxn));
  });
};

export const shlApiRouter = new oak.Router()
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
  .post('/shl/:shlId/file', async (context) => {
    const managementToken = await context.request.headers.get('authorization')?.split(/bearer /i)[1]!;
    const newFileBody = await context.request.body({ type: 'bytes' });

    const shl = DbLinks.getManagedShl(context.params.shlId, managementToken)!;
    if (!shl) {
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
  .post('/subscribe', async (context) => {
    const shlSet: { token: string; managementToken: string }[] = await context.request.body({ type: 'json' }).value;
    const managedLinks = shlSet.map((req) => DbLinks.getManagedShl(req.token, req.managementToken));
    const ticket = randomStringWithEntropy(32, 'subscription-ticket-');
    subscriptionTickets.set(
      ticket,
      managedLinks.map((l) => l.token),
    );
    setTimeout(() => {
      subscriptionTickets.delete(ticket);
    }, 10000);
    context.response.body = { subscribe: `${env.PUBLIC_URL}/api/subscribe/${ticket}` };
  })
  .get('/subscribe/:ticket', (context) => {
    const validForSet = subscriptionTickets.get(context.params.ticket);
    if (!validForSet) {
      throw 'Invalid ticket for SSE subscription';
    }

    const target = context.sendEvents();
    for (const shl of validForSet) {
      if (!accessLogSubscriptions.has(shl)) {
        accessLogSubscriptions.set(shl, []);
      }
      accessLogSubscriptions.get(shl)!.push(target);
      target.dispatchEvent(new oak.ServerSentEvent('status', DbLinks.getShlInternal(shl)));
    }

    const keepaliveInterval = setInterval(() => {
      target.dispatchEvent(new oak.ServerSentEvent('keepalive', JSON.stringify({ shlCount: validForSet.length })));
    }, 15000);

    target.addEventListener('close', () => {
      clearInterval(keepaliveInterval);
      for (const shl of validForSet) {
        const idx = accessLogSubscriptions.get(shl)!.indexOf(target);
        accessLogSubscriptions.get(shl)!.splice(idx, 1);
      }
    });
  });
