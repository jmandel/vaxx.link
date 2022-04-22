import env from '../config.ts';
import { oak } from '../deps.ts';
import * as db from '../db.ts';
import * as types from '../types.ts';
import { randomStringWithEntropy } from '../util.ts';

type SubscriptionTicket = string;
type SubscriptionSet = string[];
const subscriptionTickets: Map<SubscriptionTicket, SubscriptionSet> = new Map();

const accessLogSubscriptions: Map<string, oak.ServerSentEventTarget[]> = new Map();
interface ClientConnectionMessage {
  shlId: string;
  recipient: string;
}
export const clientConnectionListener = (cxn: ClientConnectionMessage) => {
  (accessLogSubscriptions.get(cxn.shlId) || []).forEach((t, _i) => {
    t.dispatchEvent(new oak.ServerSentEvent('connection', cxn));
  });
};

interface FileTicket {
  shlId: string;
}
const fileTickets: Map<string, FileTicket> = new Map();

export const shlApiRouter = new oak.Router()
  .post('/shl', async (context) => {
    const config: types.HealthLinkConfig = await context.request.body({ type: 'json' }).value;
    const newLink = db.DbLinks.create(config);
    context.response.body = {
      ...newLink,
      files: undefined,
      config: undefined,
    };
  })
  .post('/shl/:shlId', async (context) => {
    const config: types.HealthLinkManifestRequest = await context.request.body({ type: 'json' }).value;

    const shl = db.DbLinks.getShlInternal(context.params.shlId);
    if (!shl) {
      throw 'Cannot resolve manifest; SHL does not exist';
    }

    if (!shl.active) {
      throw 'Cannot resolve manifest; SHL is not active';
    }

    if (shl.config.pin && shl.config.pin !== config.pin) {
      db.DbLinks.recordPinFailure(shl.id);
      throw 'Cannot resolve manifest; invalid PIN';
    }

    const ticket = randomStringWithEntropy(32);
    fileTickets.set(ticket, {
      shlId: shl.id,
    })
    setTimeout(() => {
      fileTickets.delete(ticket);
    }, 60000)
    db.DbLinks.recordAccess(shl.id, config.recipient);

    context.response.body = {
      files: db.DbLinks.getManifestFiles(shl.id).map((f, _i) => ({
        contentType: f.contentType,
        location: `${env.PUBLIC_URL}/api/shl/${shl.id}/file/${f.hash}?ticket=${ticket}`,
      })),
    };

  })
  .get('/shl/:shlId/file/:fileIndex', (context) => {
    const fileTicket = fileTickets.get(context.request.url.searchParams.get('ticket')!);
    if (!fileTicket) {
      console.log('Cannot request SHL without a valid ticket');
      return (context.response.status = 401);
    }

    if (fileTicket.shlId !== context.params.shlId) {
      console.log('Ticket is not valid for ' + context.params.shlId);
      return (context.response.status = 401);
    }

    const file = db.DbLinks.getFile(context.params.shlId, context.params.fileIndex);
    context.response.headers.set('content-type', "application/jose");
    context.response.body = file.content;
  })
  .post('/shl/:shlId/file', async (context) => {
    const managementToken = await context.request.headers.get('authorization')?.split(/bearer /i)[1]!;
    const newFileBody = await context.request.body({ type: 'bytes' });

    const shl = db.DbLinks.getManagedShl(context.params.shlId, managementToken)!;
    if (!shl) {
      throw new Error(`Can't manage SHLink ` + context.params.shlId);
    }

    const newFile = {
      contentType: context.request.headers.get('content-type')!,
      content: await newFileBody.value,
    };

    const added = db.DbLinks.addFile(shl.id, newFile);
    context.response.body = {
      ...shl,
      added,
    };
  })
  .post('/subscribe', async (context) => {
    const shlSet: { shlId: string; managementToken: string }[] = await context.request.body({ type: 'json' }).value;
    const managedLinks = shlSet.map((req) => db.DbLinks.getManagedShl(req.shlId, req.managementToken));


    const ticket = randomStringWithEntropy(32, 'subscription-ticket-');
    subscriptionTickets.set(
      ticket,
      managedLinks.map((l) => l.id),
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
      target.dispatchEvent(new oak.ServerSentEvent('status', db.DbLinks.getShlInternal(shl)));
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

/*
  .post('/register', (context) => {
  })
  /*
    files: DbLinks.fileNames(client.shlink).map(
            (f, _i) => ({contentType: f.contentType, location: `${env.PUBLIC_URL}/api/shl/${client.shlink}/file/${f}`}),
    ),

  */
