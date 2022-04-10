import { Router } from 'https://deno.land/x/oak@v10.5.1/router.ts';
import env from "../config.ts";
import { DbLinks, DbTokens } from '../db.ts';
import { jose } from "../deps.ts";
import { AccessToken, AccessTokenResponse, OAuthRegisterPayload } from '../types.ts';
import { randomStringWithEntropy } from "../util.ts";

import {clientConnectionListener} from "./api.ts"

export const oauthRouter = new Router()
  .post('/register', async (context) => {
    const config: OAuthRegisterPayload = await context.request.body({ type: 'json' }).value;

    if (config.token_endpoint_auth_method !== 'private_key_jwt') {
      throw 'Cannot support token endpoint auth method ' + config.token_endpoint_auth_method;
    }

    if (config.grant_types.length !== 1 || config.grant_types[0] !== 'client_credentials') {
      throw 'Cannot support grant_types ' + JSON.stringify(config.grant_types);
    }

    const shlId = context.request.headers.get('authorization')!.split(/bearer /i)[1];
    const shl = DbLinks.getShlInternal(shlId);
    if (!shl) {
      throw 'Cannot authorize; SHL does not exist';
    }

    if (!shl.active) {
      throw 'Cannot authorize; SHL is not active';
    }

    const clientId = randomStringWithEntropy(32);
    DbLinks.addConnection({
      shlink: shl.token,
      active: true,
      clientId,
      log: [],
      registration: {
        name: config.client_name!,
        jwks: config.jwks,
      },
    });

    context.response.body = {
      client_id: clientId,
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
    const clientUnchecked = DbLinks.getClient(clientIdUnchecked);
    const clientJwks = clientUnchecked!.registration.jwks;
    const joseJwks = jose.createLocalJWKSet(clientJwks);

    const _tokenVerified = await jose.jwtVerify(clientAssertion, joseJwks, {
      clockTolerance: '5 minutes',
      audience: `${env.PUBLIC_URL}/oauth/token`,
    });

    const client = clientUnchecked!; // rename to affirm validated status
    const token: AccessToken = {
      accessToken: randomStringWithEntropy(32),
      exp: new Date().getTime() / 1000 + 300,
      shlink: client.shlink,
    };

    DbTokens.set(token.accessToken, token);
    const acccssTokenResponse: AccessTokenResponse = {
      access_token: token.accessToken,
      expires_in: 300,
      authorization_details: [
        {
          type: 'shlink-view',
          locations: DbLinks.fileNames(client.shlink).map(
            (f, _i) => `${env.PUBLIC_URL}/api/shl/${client.shlink}/file/${f}`,
          ),
        },
      ],
    };
    context.response.body = acccssTokenResponse;
  });

