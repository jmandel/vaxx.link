// deno-lint-ignore-file no-explicit-any
import env from '../config.ts';
import { jose } from '../deps.ts';
import * as types from '../types.ts';
import { randomStringWithEntropy } from '../util.ts';
import * as assertions from 'https://deno.land/std@0.133.0/testing/asserts.ts';

import app from '../server.ts';
await app;

Deno.test({
  name: 'App supports e2e flow',
  async fn(t) {
    const decrypt = randomStringWithEntropy(32);
    const key = jose.base64url.decode(decrypt);

    let shl: types.HealthLink;
    await t.step('Create a SHL', async function () {
      const shlResponse = await fetch(`${env.PUBLIC_URL}/api/shl`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pin: '1234',
        }),
      });

      assertions.assertEquals(shlResponse.status, 200);
      shl = (await shlResponse.json()) as types.HealthLink;
    });

    const plaintextFile = JSON.stringify({
      verifiableCredential: [
        'eyJ6aXAiOiJERUYiLCJhbGciOiJFUzI1NiIsImtpZCI6IjNLZmRnLVh3UC03Z1h5eXd0VWZVQUR3QnVtRE9QS01ReC1pRUxMMTFXOXMifQ.pZJLb9swEIT_SrC9ynrYSozq2PaQnBIgjx4KH2hqbbHgQ1hSbtxA_727jIMERZBLAB1EcvhxZsgnMDFCB0NKY-yqKo6oy-gUpQGVTUOpFfWxwkflRouxYvWEBAX47Q665qL9Wi_r1bItl-tVAQcN3ROk44jQ_Xpl_o_78jxYyIBRn9cZ5yZv_qpkgodNAZqwR5-MsrfT9jfqJLZ2g6EHpCiaDtqyLhuGyuy3yfcWRUMYw0Qa73IEOC0Up0igg7VME0IBfAAdOSeTJ2vvybLgZX9Xs-Bl8A74hq3yfulROXyGKGfsUQ6l8Ef4e3NALz1eW_4j2MycbGs4-g-VBLKsm_WibhZ1C_NcvGuj-djG1dveCohJpSnmnHLbCaX1g9LaePwe-kzQoTd-nx3HY0zoTo-H72Ww6zLQvpJKq2j6Sh8eGaDzTmjaC5g3cwHjKXu2s0NCL97eVseioPVEeUnC3hn3Gni1qM8ZOyLtAjkuRrwonQIJsjdxtEp6vP95dpkfydkN9kYlMpp72uRvnv8B.xMOa6WDbATD-kxUeCwPWFPOOy9vjERhr674vxlnganYP7LVgdLbyt4vyZzpimh-5Uxn-AZs5GuuXvbIq3wPyJg',
      ],
    });

    const encryptedFile = await new jose.CompactEncrypt(new TextEncoder().encode(plaintextFile))
      .setProtectedHeader({
        alg: 'dir',
        enc: 'A256GCM',
      })
      .encrypt(key);

    await t.step('Add a SHC file to SHL', async function () {
      const shlFileResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl!.id}/file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/smart-health-card',
          authorization: `Bearer ${shl.managementToken}`,
        },
        body: encryptedFile,
      });

      assertions.assertEquals(shlFileResponse.status, 200);
    });

    const sseTicketRequest = await fetch(`${env.PUBLIC_URL}/api/subscribe`, {
      method: 'POST',
      headers: {},
      body: JSON.stringify([
        {
          shlId: shl!.id,
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

    let manifestJson: any;
    await t.step('Obtain manifest from SHL server', async function () {
      const manifestResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl!.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pin: '1234',
          recipient: 'Test SHL Client',
        }),
      });

      assertions.assertEquals(manifestResponse.status, 200);
      manifestJson = await manifestResponse.json();
      // console.log('Access Token Response');
      // console.log(JSON.stringify(tokenResponseJson, null, 2));
    });

    await t.step('Ensure event subscriptions announce a new manifest request', async function () {
      const sseReader = sseRequest.body?.getReader();
      const readEvent = await sseReader?.read().then(function readChunk(v) {
        const [eventType, eventBody] = new TextDecoder().decode(v.value).split(/\n/, 2);
        return { type: eventType.split(': ', 2)[1], body: JSON.parse(eventBody.split(': ', 2)[1]) };
      });
      assertions.assert(readEvent?.type === 'status');
      assertions.assert(readEvent?.body.id === shl.id && readEvent.body.active);
    });

    await t.step('Download SHC file using access token', async function () {
      assertions.assert(manifestJson.files[0].contentType === 'application/smart-health-card');
      const fileResponse = await fetch(manifestJson.files[0].location);
      const file = await fileResponse.text();
      assertions.assert(file.length > 2);
    });
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  ignore: !Deno.env.get("TEST_SMART"),
  name: 'App supports SMART API Endpoints with Refresh',
  async fn(t) {
    const decrypt = randomStringWithEntropy(32);
    const key = jose.base64url.decode(decrypt);

    let shl: types.HealthLink;
    await t.step('Create a SHL', async function () {
      const shlResponse = await fetch(`${env.PUBLIC_URL}/api/shl`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pin: '1234',
        }),
      });

      assertions.assertEquals(shlResponse.status, 200);
      shl = (await shlResponse.json()) as types.HealthLink;
    });

    const accessConfig =  JSON.parse(await Deno.readTextFile("tests/smart-api-config.json"));

    const tokenResponse = { ...accessConfig.tokenResponse, referesh_token: undefined };
    const endpoint: types.HealthLinkEndpoint = {
      config: {
        clientId: accessConfig.clientId,
        clientSecret: accessConfig.clientSecret,
        key: decrypt,
        refreshToken: accessConfig.tokenResponse.refresh_token,
        tokenEndpoint: accessConfig.tokenUri,
      },
      endpointUrl: accessConfig.serverUrl.replace(/\/$/, ''),
      accessTokenResponse: tokenResponse,
    };

    await t.step('Add endpoint to SHL', async function () {
      const shlFileResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl!.id}/endpoint`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${shl.managementToken}`,
        },
        body: JSON.stringify(endpoint),
      });

      assertions.assertEquals(shlFileResponse.status, 200);
      console.log;
    });

    let manifestJson: types.SHLinkManifest;

    await t.step('Obtain manifest from SHL server', async function () {
      const manifestResponse = await fetch(`${env.PUBLIC_URL}/api/shl/${shl!.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          pin: '1234',
          recipient: 'Test SHL Client',
        }),
      });

      assertions.assertEquals(manifestResponse.status, 200);
      manifestJson = await manifestResponse.json();

      console.log('Manifest response');
      console.log(JSON.stringify(manifestJson, null, 2));
      assertions.assert(manifestJson.files.length === 1, 'Expected one endpoint in manifest');
    });

    async function fetchEndpoint(){
      assertions.assert(manifestJson.files[0].contentType === 'application/smart-api-access');
      const fileResponse = await fetch(manifestJson.files[0].location);
      const file = await fileResponse.text();

      const decrypted = await jose.compactDecrypt(file, key);
      const decoded = JSON.parse(new TextDecoder().decode(decrypted.plaintext));
      assertions.assertExists(decoded.access_token)
    }

    await t.step('Download SHC endpoint once', fetchEndpoint );
    await t.step('Download SHC endpoint again', fetchEndpoint );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
