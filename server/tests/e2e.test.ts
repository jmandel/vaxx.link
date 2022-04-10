import env from '../config.ts';
import { jose, queryString, base64url } from '../deps.ts';
import { HealthLink, OAuthRegisterResponse, AccessTokenResponse, SHLClientConnectResponse } from '../types.ts';
import { randomStringWithEntropy } from '../util.ts';
import * as assertions from 'https://deno.land/std@0.133.0/testing/asserts.ts';

import app from '../server.ts';
await app;

Deno.test({
  name: 'App supports e2e flow',
  async fn(t) {
    const clientKey = await jose.generateKeyPair('ES256');

    let shl: HealthLink;
    await t.step('Create a SHL', async function () {
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

      assertions.assertEquals(shlResponse.status, 200);
      shl = (await shlResponse.json()) as HealthLink;
    });

    await t.step('Add a SHC file to SHL', async function () {
      const shlFileResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl!.token}/file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${shl.managementToken}`,
        },
        body: JSON.stringify({
          verifiableCredential: [
            'eyJ6aXAiOiJERUYiLCJhbGciOiJFUzI1NiIsImtpZCI6IjNLZmRnLVh3UC03Z1h5eXd0VWZVQUR3QnVtRE9QS01ReC1pRUxMMTFXOXMifQ.pZJLb9swEIT_SrC9ynrYSozq2PaQnBIgjx4KH2hqbbHgQ1hSbtxA_727jIMERZBLAB1EcvhxZsgnMDFCB0NKY-yqKo6oy-gUpQGVTUOpFfWxwkflRouxYvWEBAX47Q665qL9Wi_r1bItl-tVAQcN3ROk44jQ_Xpl_o_78jxYyIBRn9cZ5yZv_qpkgodNAZqwR5-MsrfT9jfqJLZ2g6EHpCiaDtqyLhuGyuy3yfcWRUMYw0Qa73IEOC0Up0igg7VME0IBfAAdOSeTJ2vvybLgZX9Xs-Bl8A74hq3yfulROXyGKGfsUQ6l8Ef4e3NALz1eW_4j2MycbGs4-g-VBLKsm_WibhZ1C_NcvGuj-djG1dveCohJpSnmnHLbCaX1g9LaePwe-kzQoTd-nx3HY0zoTo-H72Ww6zLQvpJKq2j6Sh8eGaDzTmjaC5g3cwHjKXu2s0NCL97eVseioPVEeUnC3hn3Gni1qM8ZOyLtAjkuRrwonQIJsjdxtEp6vP95dpkfydkN9kYlMpp72uRvnv8B.xMOa6WDbATD-kxUeCwPWFPOOy9vjERhr674vxlnganYP7LVgdLbyt4vyZzpimh-5Uxn-AZs5GuuXvbIq3wPyJg',
          ],
        }),
      });

      assertions.assertEquals(shlFileResponse.status, 200);
    });

    let discovery: { token_endpoint: string; registration_endpoint: string };
    await t.step('Resolve discovery document for SHL server', async function () {
      const discoveryResponse = await fetch(`${shl.url}/.well-known/smart-configuration`);
      discovery = await discoveryResponse.json();
      assertions.assertExists(discovery.registration_endpoint);
      assertions.assertExists(discovery.token_endpoint);
    });

    const sseTicketRequest = await fetch(`${env.PUBLIC_URL}/api/subscribe`, {
      method: 'POST',
      headers: {},
      body: JSON.stringify([
        {
          token: shl!.token,
          managementToken: shl!.managementToken,
        },
      ]),
    });

    const sseTicket = await sseTicketRequest.json();

    const sseRequest = await fetch(sseTicket.subscribe, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
      },
    });

    let registered: any;
    await t.step('Register with SHL Server', async function () {
      const pk = await jose.exportJWK(clientKey.publicKey);
      const registeredResponse = await fetch(`${discovery!.registration_endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${shl.token}`,
        },
        body: JSON.stringify({
          token_endpoint_auth_method: 'private_key_jwt',
          grant_types: ['client_credentials'],
          jwks: {
            keys: [pk],
          },
          client_name: "Dr. B's Quick Response Squared", // optional
          contacts: ['drjones@clinic.com'], // optional
        }),
      });

      assertions.assertEquals(registeredResponse.status, 200);
      registered = (await registeredResponse.json()) as OAuthRegisterResponse;
    });

    await t.step('Ensure event subscriptions announce a new client', async function () {
      const sseReader = sseRequest.body?.getReader();
      const readEvent = await sseReader?.read().then(function readChunk(v) {
        const [eventType, eventBody] = new TextDecoder().decode(v.value).split(/\n/, 2);
        return {type: eventType.split(": ", 2)[1], body: JSON.parse(eventBody.split(": ", 2)[1])}
      });
      assertions.assert(readEvent?.type === "status");
      assertions.assert(readEvent?.body.token === shl.token && readEvent.body.active);
    });

    let tokenResponseJson: any;
    await t.step('Obtain access token from SHL server', async function () {
      const clientAssertion = await new jose.SignJWT({})
        .setIssuer(registered.client_id)
        .setSubject(registered.client_id)
        .setAudience(`${env.PUBLIC_URL}/oauth/token`)
        .setExpirationTime('3 minutes')
        .setProtectedHeader({ alg: 'ES256' })
        .setJti(randomStringWithEntropy(32))
        .sign(clientKey.privateKey);

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

      assertions.assertEquals(tokenResponse.status, 200);
      tokenResponseJson = (await tokenResponse.json()) as AccessTokenResponse;
      // console.log('Access Token Response');
      // console.log(JSON.stringify(tokenResponseJson, null, 2));
    });

    await t.step('Download SHC file using access token', async function () {
      const fileResponse = await fetch(tokenResponseJson.authorization_details[0].locations[0], {
        headers: {
          Authorization: `Bearer ${tokenResponseJson.access_token}`,
        },
      });

      const file = await fileResponse.text();
      assertions.assert(file.length > 2);
      // console.log('got filef', fileResponse.status, file);
    });

    const shlClientConnectionResponse = await fetch(`${env.PUBLIC_URL}/client/connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Test Client',
        shl: `shlink:/${base64url.encode(
          JSON.stringify({
            oauth: {
              url: `${env.PUBLIC_URL}`,
              token: shl!.token,
            },
          }),
        )}`,
      }),
    });

    const shlClientConnection: SHLClientConnectResponse = await shlClientConnectionResponse.json();
    const shlClientRetrieveResponse = await fetch(`${env.PUBLIC_URL}/client/retrieve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        state: shlClientConnection.state,
        validateSHCs: false,
        acceptExampleSHCs: true,
      }),
    });
    assertions.assertEquals(shlClientConnectionResponse.status, 200);
    const shlClientRetrieve = await shlClientRetrieveResponse.json();
    assertions.assertEquals(shlClientRetrieve.shcs[0].decoded.iss, 'https://spec.smarthealth.cards/examples/issuer');

  },
  sanitizeOps: false,
  sanitizeResources: false,
});
