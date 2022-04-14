import { jose } from './deps.ts';

export interface HealthLinkConnection {
  shlink: string;
  clientId: string;
  active: boolean;
  registration: {
    name: string;
    jwks: jose.JSONWebKeySet;
  };
  log: {
    url: string;
    date: number;
  }[];
}

export interface HealthLinkFile {
  contentType: string;
  content: Uint8Array;
}

export interface HealthLinkConfig {
  pin?: string;
  exp?: number;
  encrypted: boolean;
}

export interface HealthLink {
  config: HealthLinkConfig;
  active: boolean;
  url: string;
  token: string;
  managementToken: string;
}

export interface AccessToken{
  accessToken: string,
  exp: number,
  shlink: string
}

export interface ResourceAccessRight {
  type: "shlink-view",
  locations: string[]
}

export interface AccessTokenResponse {
    access_token: string,
    expires_in: number,
    authorization_details: ResourceAccessRight[]
}


export interface SHLinkAddFileRequest {
  id: string;
  files: HealthLinkFile[];
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

export interface SHLDecoded {
  oauth: {
    token: string,
    url: string
  }
}

export interface SHLClientConnectRequest {
  clientName: string,
  clientContact?: string,
  shl: string,
  pin?: string,
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
  shcs: {
    jws: string,
    decoded: unknown,
    validated: unknown
  }[]
}

