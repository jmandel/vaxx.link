import  base64url from 'base64url';
import * as jose from "jose";
import * as querystring from "querystring";
import {inflateRaw, deflateRaw} from "pako";
import * as shcDecoder from 'smart-health-card-decoder'

export interface SHLClientConnectRequest {
  clientName: string,
  clientContact?: string,
  shl: string,
  pin?: string
}

export interface SHLClientStateDecoded {
  tokenEndpoint: string,
  clientId: string,
  privateJwk: jose.JWK
}

export interface SHLClientConnectResponse {
  state: string
}

export interface SHLClientRetrieveRequest {
  state: string;
  validateSHCs: boolean;
  acceptExampleSHCs: boolean;
}

export interface SHLClientRetrieveResponse {
  shcs: string[]
}



export interface SHLDecoded {
  flags?: string,
  oauth: {
    token: string,
    url: string
  }
}

export interface OAuthRegisterPayload {
  token_endpoint_auth_method: 'private_key_jwt';
  grant_types: ['client_credentials'];
  jwks: jose.JSONWebKeySet;
  client_name?: string;
  contacts?: string[];
}

export interface OAuthRegisterResponse extends OAuthRegisterPayload {
  client_id: string;
}


export function randomStringWithEntropy(entropy: number) {
  const b = new Uint8Array(entropy);
  crypto.getRandomValues(b);
  return base64url.encode(b.buffer as Buffer);
}

export function decodeBase64urlToJson<T>(s: string): T {
  return JSON.parse(base64url.decode(s)) as T;
}

export function decodeToJson<T>(s: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(s)) as T;
}

export interface AccessTokenResponse {
    access_token: string,
    expires_in: number,
    authorization_details: ResourceAccessRight[]
}

export interface ResourceAccessRight {
  type: "shlink-view",
  locations: string[]
}

async function needPin(config: {shl: string}){
    const shlBody = config.shl.split(/^(?:.+:\/.+#)?shlink:\//)[1];
    const parsedShl: SHLDecoded = decodeBase64urlToJson(shlBody);
    if (parsedShl.flags?.includes("P")) {
      return true
    }

    return false

}

async function connect(config: SHLClientConnectRequest){
    const shlBody = config.shl.split(/^(?:.+:\/.+#)?shlink:\//)[1];
    const parsedShl: SHLDecoded = decodeBase64urlToJson(shlBody);
    const clientKey = await jose.generateKeyPair('ES256', { extractable: true });
    const discoveryResponse = await fetch(`${parsedShl.oauth.url}/.well-known/smart-configuration`);
    const discovery: { token_endpoint: string; registration_endpoint: string } = await discoveryResponse.json();
    const registeredResponse = await fetch(`${discovery!.registration_endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${parsedShl.oauth.token}`,
      },
      body: JSON.stringify({
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['client_credentials'],
        jwks: {
          keys: [await jose.exportJWK(clientKey.publicKey)],
        },
        client_name: config.clientName, // optional
        contacts: config.clientContact ? [config.clientContact] : undefined,
      }),
    });

    const registered = (await registeredResponse.json()) as OAuthRegisterResponse;
    const stateDecoded: SHLClientStateDecoded = {
      tokenEndpoint: discovery.token_endpoint,
      clientId: registered.client_id,
      privateJwk: await jose.exportJWK(clientKey.privateKey),
    };
    const state = base64url.encode(JSON.stringify(stateDecoded));
    return {state};
  }

async function pull(config: SHLClientRetrieveRequest){
    const state: SHLClientStateDecoded = decodeBase64urlToJson<SHLClientStateDecoded>(config.state);
    const clientKey = await jose.importJWK(state.privateJwk, "ES256");
    const clientAssertion = await new jose.SignJWT({ })
      .setIssuer(state.clientId)
      .setSubject(state.clientId)
      .setAudience(state.tokenEndpoint)
      .setExpirationTime('3 minutes')
      .setProtectedHeader({ alg: 'ES256' })
      .setJti(randomStringWithEntropy(32))
      .sign(clientKey);

    const tokenResponse = await fetch(`${state.tokenEndpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'Shlink-Pin': '1234',
      },
      body: querystring.stringify({
        scope: '__shlinks',
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion,
      }),
    });

    const tokenResponseJson = (await tokenResponse.json()) as AccessTokenResponse;

    const allFiles = await Promise.all(
      tokenResponseJson.authorization_details
        .flatMap((a) => a.locations)
        .map(
          (l) =>
            fetch(l, {
              headers: {
                authorization: `Bearer ${tokenResponseJson.access_token}`,
              },
            }).then(f => f.text()) // TODO deal with other content types
        ),
    );

    const allShcJws = allFiles.flatMap((f) => JSON.parse(f)['verifiableCredential'] as string);

    const result: SHLClientRetrieveResponse = {
      shcs: allShcJws.map((jws) => {
        const compressed = base64url.toBuffer(jws.split('.')[1]);
        const decompressed = decodeToJson(inflateRaw(compressed));
        return jws;
      }),
    };

    return result;

};

export {
   needPin,
   connect,
   pull,
}
