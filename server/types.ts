export interface HealthLinkFile {
  contentType: string;
  content: Uint8Array;
}

export interface HealthLinkConfig {
  pin?: string;
  exp?: number;
}

export interface HealthLink {
  config: HealthLinkConfig;
  active: boolean;
  id: string;
  managementToken: string;
  pinFailuresRemaining: number;
}

export interface HealthLinkManifestRequest {
 recipient: string,
 pin?: string,
}

export interface SHLinkManifestFile{
    contentType: "application/fhir+json" | "application/smart-health-card" | "application/smart-api-access",
    location: string
}

export interface SHLinkManifest {
  files: SHLinkManifestFile[]
}

export interface SHLinkAddFileRequest {
  id: string;
  files: HealthLinkFile[];
}

export interface SHLDecoded {
  url: string,
  flag: string,
  decrypt: string & {length: 43},
  exp?: number,
  label?: string
}