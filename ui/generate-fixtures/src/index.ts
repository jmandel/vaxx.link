/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import jose, { JWK } from 'node-jose';
import pako from 'pako';
import issuerPrivateKeys from './config/issuer.jwks.private.json';

import examples from '../gsheet.json';
import templateBundle from './skeleton-bundle.json';

const ISSUER_URL = process.env.ISSUER_URL || 'https://spec.smarthealth.cards/examples/issuer';

interface Bundle {
  id?: string;
  meta?: Record<string, unknown>;
  entry: {
    fullUrl: string;
    resource: {
      meta?: Record<string, unknown>;
      id?: string;
      [k: string]: unknown;
    };
  }[];
}

export interface HealthCard {
  iss: string;
  nbf: number;
  exp?: number;
  vc: {
    type: string[];
    credentialSubject: {
      fhirVersion: string;
      fhirBundle: Bundle;
    };
    rid?: string;
  };
}

export class Signer {
  public keyStore: jose.JWK.KeyStore;
  public signingKey: JWK.Key;

  constructor({ keyStore, signingKey }: { signingKey: JWK.Key; keyStore?: JWK.KeyStore }) {
    this.keyStore = keyStore || jose.JWK.createKeyStore();
    this.signingKey = signingKey;
  }

  async signJws(idTokenPayload: Record<string, unknown>, deflate = true): Promise<string> {
    const bodyString = JSON.stringify(idTokenPayload);
    const fields = deflate ? { zip: 'DEF' } : {};
    const body = deflate ? pako.deflateRaw(bodyString) : bodyString;
    const signed = await jose.JWS.createSign({ format: 'compact', fields }, this.signingKey)
      .update(Buffer.from(body))
      .final();
    return (signed as unknown) as string;
  }
}

function createHealthCardJwsPayload(
  templateBundle: Bundle,
  substitutions: Record<string, string>,
  types: string[],
): Record<string, unknown> {
  let fhirBundle = JSON.parse(
    Object.entries(substitutions).reduce((acc, [k, v]) => acc.replace(k, v), JSON.stringify(templateBundle)),
  );
  let payload: HealthCard = {
    iss: ISSUER_URL,
    nbf: new Date().getTime() / 1000,
    vc: {
      type: ['https://smarthealth.cards#health-card', ...types],
      credentialSubject: {
        fhirVersion: '4.0.1',
        fhirBundle,
      },
    },
  };
  return (payload as unknown) as Record<string, unknown>;
}

async function createHealthCard(substitutions: Record<string, string>) {
  let payload = createHealthCardJwsPayload(templateBundle, substitutions, [
    'https://smarthealth.cards#health-card',
    'https://smarthealth.cards#immunization',
  ]);
  const signer = new Signer({ signingKey: await JWK.asKey(issuerPrivateKeys.keys[0]) });
  const signed = await signer.signJws(payload);
  return signed;
}

async function generate() {
  const out = []
  for (const e of examples.table.rows) {
    const subs = {
      $given: e.c[0]!.v as string,
      $family: e.c[1]!.v as string,
      $birthdate: e.c[2]!.f as string,
      $vaccinedate: e.c[3]!.f as string,
      $cvx: e.c[6]!.v as string,
      $location: e.c[7]!.v as string,
    };
    out.push(await createHealthCard(subs))
  }
  console.log(JSON.stringify(out, null, 2))
};

generate()
