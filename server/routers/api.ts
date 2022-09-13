import env from '../config.ts';
import { jose, oak } from '../deps.ts';
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

interface ManifestAccessTicket {
  shlId: string;
}
const manifestAccessTickets: Map<string, ManifestAccessTicket> = new Map();

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
    const embedMaxBytes = Math.min(env.EMBED_MAX_BYTES, config.embedMaxBytes !== undefined ? config.embedMaxBytes : Infinity);

    const shl = db.DbLinks.getShlInternal(context.params.shlId);
    if (!shl) {
      throw 'Cannot resolve manifest; SHL does not exist';
    }

    if (!shl.active) {
      throw 'Cannot resolve manifest; SHL is not active';
    }

    if (shl.config.passcode && shl.config.passcode !== config.passcode) {
      db.DbLinks.recordPasscodeFailure(shl.id);
      context.response.status = 401;
      context.response.body = { remainingAttempts: shl.passcodeFailuresRemaining - 1 };
      return;
    }

    const ticket = randomStringWithEntropy(32);
    manifestAccessTickets.set(ticket, {
      shlId: shl.id,
    });
    setTimeout(() => {
      manifestAccessTickets.delete(ticket);
    }, 60000);
    db.DbLinks.recordAccess(shl.id, config.recipient);

    context.response.headers.set('expires', new Date().toUTCString());
    context.response.body = {
      files: db.DbLinks.getManifestFiles(shl.id, embedMaxBytes)
        .map((f, _i) => ({
          contentType: f.contentType,
          embedded: f.content?.length ? new TextDecoder().decode(f.content) : undefined,
          location: `${env.PUBLIC_URL}/api/shl/${shl.id}/file/${f.hash}?ticket=${ticket}`,
        }))
        .concat(
          db.DbLinks.getManifestEndpoints(shl.id).map((e) => ({
            contentType: 'application/smart-api-access',
            embedded: undefined,
            location: `${env.PUBLIC_URL}/api/shl/${shl.id}/endpoint/${e.id}?ticket=${ticket}`,
          })),
        ),
    };
  })
  .get('/shl/:shlId/file/:fileIndex', (context) => {
    const ticket = manifestAccessTickets.get(context.request.url.searchParams.get('ticket')!);
    if (!ticket) {
      console.log('Cannot request SHL without a valid ticket');
      return (context.response.status = 401);
    }

    if (ticket.shlId !== context.params.shlId) {
      console.log('Ticket is not valid for ' + context.params.shlId);
      return (context.response.status = 401);
    }

    const file = db.DbLinks.getFile(context.params.shlId, context.params.fileIndex);
    context.response.headers.set('content-type', 'application/jose');
    context.response.body = file.content;
  })
  .get('/shl/:shlId/endpoint/:endpointId', async (context) => {
    const ticket = manifestAccessTickets.get(context.request.url.searchParams.get('ticket')!);
    if (!ticket) {
      console.log('Cannot request SHL without a valid ticket');
      return (context.response.status = 401);
    }

    if (ticket.shlId !== context.params.shlId) {
      console.log('Ticket is not valid for ' + context.params.shlId);
      return (context.response.status = 401);
    }

    const endpoint = await db.DbLinks.getEndpoint(context.params.shlId, context.params.endpointId);
    context.response.headers.set('content-type', 'application/jose');
    const payload = JSON.stringify({
      aud: endpoint.endpointUrl,
      ...endpoint.accessTokenResponse,
    });
    const encrypted = await new jose.CompactEncrypt(new TextEncoder().encode(payload))
      .setProtectedHeader({
        alg: 'dir',
        enc: 'A256GCM',
      })
      .encrypt(jose.base64url.decode(endpoint.config.key));
    context.response.body = encrypted;
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
  .post('/shl/:shlId/endpoint', async (context) => {
    const managementToken = await context.request.headers.get('authorization')?.split(/bearer /i)[1]!;
    const config: types.HealthLinkEndpoint = await context.request.body({ type: 'json' }).value;

    const shl = db.DbLinks.getManagedShl(context.params.shlId, managementToken)!;
    if (!shl) {
      throw new Error(`Can't manage SHLink ` + context.params.shlId);
    }

    const added = await db.DbLinks.addEndpoint(shl.id, config);
    console.log("Added", added)
    context.response.body = {
      ...shl,
      added,
    };
  })
  .delete('/shl/:shlId', async (context) => {
    const managementToken = await context.request.headers.get('authorization')?.split(/bearer /i)[1]!;
    const shl = db.DbLinks.getManagedShl(context.params.shlId, managementToken)!;
    if (!shl) {
      throw new Error(`Can't manage SHLink ` + context.params.shlId);
    }
    const deactivated = db.DbLinks.deactivate(shl);
    context.response.body = deactivated;
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
