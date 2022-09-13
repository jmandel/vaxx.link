import VaccinesIcon from '@mui/icons-material/Vaccines';
import Settings from '@mui/icons-material/Settings';
import ShareIcon from '@mui/icons-material/Share';
import { BottomNavigation, BottomNavigationAction } from '@mui/material';
import Container from '@mui/material/Container';
import produce from 'immer';
import QRCode from 'qrcode';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import useDeepCompareEffect from 'use-deep-compare-effect';
import * as jose from 'jose';

import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import * as shdc from 'smart-health-card-decoder/esm/index';
import './App.css';
import shcJwsFixtures from './fixtures';
import cvxConst from './fixtures/cvx.json';

const cvx: Record<string, string> = cvxConst;

interface StoredSHC {
  id: number;
  jws: string;
  payload?: {
    iss: string;
    nbf: number;
    vc: {
      type: string[];
      credentialSubject: {
        fhirVersion: string;
        fhirBundle: any;
      };
    };
  };
}

interface SHLinkConfig {
  passcode?: string;
  exp?: number;
}

interface SHLinkStatus {
  active: boolean;
  id: string;
  managementToken: string;
  recipients: {
    name: string;
  }[];
}

interface SHLink {
  id: number;
  label: string;
  serverConfig: SHLinkConfig;
  serverStatus?: SHLinkStatus;
  encryptionKey?: string;
  uploads: Record<StoredSHC['id'], 'need-delete' | 'need-add' | 'present'>;
}

function b64urlencode(source: string | Uint8Array) {
  let s = source;
  if (source instanceof Uint8Array) {
    let i,
      len = source.length,
      bStr = '';
    for (i = 0; i < len; i++) {
      bStr += String.fromCharCode(source[i]);
    }
    s = bStr;
  }
  return btoa(s as string)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateLinkUrl(shl: SHLink) {
  const {label} = shl;
  const truncatedLabel = label?.length > 80 ? (label.slice(0, 77) + "...") : label;
  const qrPayload = {
    label: truncatedLabel,
    url: realServerBaseUrl + '/shl/' + shl.serverStatus!.id,
    exp: shl.serverConfig.exp,
    flag: shl.serverConfig.passcode ? 'P' : '',
    decrypt: shl.encryptionKey,
  };

  const qrJson = JSON.stringify(qrPayload);
  const qrEncoded = b64urlencode(qrJson);

  const qrPrefixed = 'shlink:/' + qrEncoded;
  const hostedLandingPage = 'https://demo.vaxx.link/viewer#';
  const link = (hostedLandingPage || '') + qrPrefixed;
  return link;
}

interface DataSet {
  id: number;
  name: string;
  shcTypes?: string[];
  shcs?: number[];
  shlinks: Record<number, SHLink>;
}

interface DataServer {
  storeShc: (shl: SHLink, shc: StoredSHC) => Promise<SHLinkStatus>;
  createShl: (shl: SHLinkConfig) => Promise<SHLinkStatus>;
  deactivateShl: (shl: SHLinkStatus) => Promise<boolean>;
  subscribeToShls: (
    shls: { shlId: string; managementToken: string }[],
    reset?: () => void,
  ) => Promise<{ eventSource: EventSource; cleanup: () => void }>;
}

const fakeServerDb: Record<string, Omit<SHLink, 'id' | 'label' | 'encryptionKey'>> = {};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fakeServer: DataServer = {
  storeShc: async (shl, shc) => {
    const config = fakeServerDb[shl.serverStatus!.managementToken];
    return Promise.resolve(config.serverStatus!);
  },
  deactivateShl: async (shl) => {
    return true;
  },
  createShl: async (shl) => {
    let serverStatus = {
      id: '' + Math.random(),
      managementToken: '' + Math.random(),
      active: true,
      recipients: [],
    };
    fakeServerDb[serverStatus.managementToken] = {
      uploads: {},
      serverConfig: shl,
      serverStatus,
    };
    await new Promise((res) => setTimeout(() => res(null), 50));
    return Promise.resolve(JSON.parse(JSON.stringify(serverStatus)));
  },
  subscribeToShls: async (shls) => Promise.resolve(null as any),
};

const realServerBaseUrl = process.env.REACT_APP_REAL_SERVER_BASE || `http://localhost:8000/api`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const realServer: DataServer = {
  storeShc: async (shl, shc) => {
    let body = JSON.stringify({ verifiableCredential: [shc.jws] });
    if (shl.encryptionKey) {
      body = await new jose.CompactEncrypt(new TextEncoder().encode(body))
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', contentType: 'application/smart-health-card' })
        .encrypt(jose.base64url.decode(shl.encryptionKey));
    }
    const result = await fetch(`${realServerBaseUrl}/shl/${shl.serverStatus?.id}/file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/smart-health-card',
        authorization: `Bearer ${shl.serverStatus?.managementToken}`,
      },
      body,
    });
    return result.json();
  },
  createShl: async (shl) => {
    const result = await fetch(`${realServerBaseUrl}/shl`, {
      method: 'POST',
      body: JSON.stringify(shl),
    });
    return result.json();
  },
  deactivateShl: async (shl) => {
    let deletedResponse = await fetch(`${realServerBaseUrl}/shl/${shl.id}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${shl.managementToken}`,
      },
    });
    return JSON.parse(await deletedResponse.json()) as boolean;
  },
  subscribeToShls: async (shls, reset) => {
    console.log('new subscribe', shls);
    async function connectOnce() {
      const ticket = await fetch(`${realServerBaseUrl}/subscribe`, {
        method: 'POST',
        body: JSON.stringify(shls),
      });
      const ticketUrl = (await ticket.json()).subscribe;
      return new EventSource(ticketUrl);
    }

    while (true) {
      try {
        const es = await connectOnce();
        let keepaliveWatcher: NodeJS.Timer;
        let stale = true;
        es.addEventListener('keepalive', (e) => {
          stale = false;
        });
        keepaliveWatcher = setInterval(function () {
          if (stale) {
            console.log('Failed; using keepalive'); // TODO remove if this isn't used
            reset!();
          }
          stale = true;
        }, 30000);
        es.addEventListener('error', () => reset!());

        return {
          eventSource: es,
          cleanup: () => {
            es.close();
            clearInterval(keepaliveWatcher);
          },
        };
      } catch {
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  },
};

function filterForTypes(shcTypes?: string[]) {
  if (!shcTypes) {
    return () => true;
  }
  const targetTypes = shcTypes.map((t) => `https://smarthealth.cards${t}`);
  return (shc: StoredSHC) => !!shc?.payload?.vc?.type.some((t) => targetTypes.includes(t));
}

function filterForIds(shcIds? : number[]) {
  if (!shcIds) {
    return () => true;
  }
  return (shc: StoredSHC) => shcIds?.includes(shc.id);
}

let idGenerator = () => Math.random();
class ServerStateSync {
  dispatch: React.Dispatch<AppAction>;
  previousStore?: AppState;
  storeRef: { current: AppState };
  server: DataServer;
  constructor(
    stateRef: ServerStateSync['storeRef'],
    dispatch: ServerStateSync['dispatch'],
    server: ServerStateSync['server'],
  ) {
    this.dispatch = dispatch;
    this.storeRef = stateRef;
    this.server = server;
  }

  async createShl(label: string, datasetId: number, serverConfig: SHLinkConfig) {
    let serverStatus = await this.server.createShl(serverConfig);
    let newShlinkId = idGenerator();

    const encryptionKeyBytes = new Uint8Array(32);
    crypto.getRandomValues(encryptionKeyBytes);
    const encryptionKey = jose.base64url.encode(encryptionKeyBytes);

    const store = this.storeRef.current;
    const dsName = store.sharing[datasetId].name;

    this.dispatch({
      type: 'shl-add',
      datasetId,
      shlink: {
        id: newShlinkId,
        label,
        encryptionKey,
        serverConfig,
        serverStatus,
        uploads: {},
      },
    });
    return newShlinkId;
  }
  async appStateChange() {
    let store = this.storeRef.current;
    if (store.sharing !== this.previousStore?.sharing) {
      localStorage.setItem('shlinks', JSON.stringify(store.sharing));
    }

    this.deactivateShlsIfNeeded(store);
    this.uploadFilesIfNeeded(store);
    this.previousStore = store;
  }

  async deactivateShlsIfNeeded(store: AppState) {
    const shlIds = (store: AppState): SHLinkStatus[] =>
      Object.values(store.sharing || {}).flatMap((ds) =>
        Object.values(ds.shlinks || {}).map((shl) => shl.serverStatus!),
      );

    const previousShls: SHLinkStatus[] = shlIds(this.previousStore ?? {} as AppState);
    const currentShls: SHLinkStatus[] = shlIds(store);

    if (currentShls.length === previousShls.length) {
      return;
    }

    const toDelete = previousShls.filter((shl) => !currentShls.some((currShl) => currShl!.id === shl!.id));
    await Promise.all(toDelete.map((shl) => this.server.deactivateShl(shl)));
  }

  async uploadFilesIfNeeded(store: AppState) {
    let allCards = Object.values(store.vaccines);
    let serverRequestsNeeded: {
      datasetId: number;
      shlinkId: number;
      shcId: number;
      action: 'need-delete' | 'need-add';
    }[] = [];

    for (const ds of Object.values(store.sharing)) {
      const cardsForDs = allCards.filter(filterForTypes(ds.shcTypes)).filter(filterForIds(ds.shcs));
      for (const shl of Object.values(ds.shlinks)) {
        const cardsForShl = Object.keys(shl.uploads).map(Number);
        const needAdditions = cardsForDs.filter((c) => !cardsForShl.includes(c.id)).map((a) => a.id);
        const needDeletions = cardsForShl.filter((c) => !cardsForDs.map((shc) => shc.id).includes(c));
        serverRequestsNeeded = [
          ...serverRequestsNeeded,
          ...needAdditions.map((a) => ({
            datasetId: ds.id,
            shlinkId: shl.id,
            shcId: a,
            action: 'need-add' as const,
          })),
        ];
        serverRequestsNeeded = [
          ...serverRequestsNeeded,
          ...needDeletions.map((d) => ({
            datasetId: ds.id,
            shlinkId: shl.id,
            shcId: d,
            action: 'need-delete' as const,
          })),
        ];
      }
    }

    for (const r of serverRequestsNeeded) {
      const shl = store.sharing[r.datasetId].shlinks[r.shlinkId]!;
      const shc = store.vaccines[r.shcId];
      this.dispatch({ type: 'shl-shc-sync', ...r, status: r.action });
      if (r.action === 'need-add') {
        this.server.storeShc(shl, shc).then((shlServerStatus) => {
          this.dispatch({ type: 'shl-shc-sync', ...r, status: 'present', shlServerStatus });
        });
      }
      if (r.action === 'need-delete') {
        console.log('TODO: synchronize deleted SHCs to SHLs');
      }
    }
  }
}

const defaultDatasets: DataSet[] = [
  {
    id: 0,
    name: 'All Vaccines',
    shlinks: {},
  },
  {
    id: 1,
    name: 'School Vaccines',
    shcTypes: ['#immunization'],
    shlinks: {},
  }
];

const defaultImmunizations: Promise<StoredSHC[]> = Promise.all(
  shcJwsFixtures.map(async (jws, i) => {
    const context = new shdc.Context();
    context.compact = jws;
    const payload = (await shdc.low.decode.jws.compact(context)).jws.payload;
    return {
      id: i,
      jws,
      payload,
    };
  }),
);

export function SHLinkCreate() {
  let navigate = useNavigate();
  let { store, dispatch } = useStore();
  let [usePasscode, setUsePasscode] = useState(false);
  let [passcode, setPasscode] = useState('1234');
  let [datasetName, setDataSetName] = useState(`Custom Dataset ${Object.keys(store.sharing).length}`);
  let [expires, setExpires] = useState(false);

  const handleOnChange = (index: Number) => {
    const updatedCheck = isChecked.map((item: boolean, i: Number) => {
      return i === index ? !item : item
    });
    setIsChecked(updatedCheck);
  }

  let oneMonthExpiration = new Date(new Date().getTime() + 1000 * 3600 * 24 * 31);
  let [expiresDate, setExpiresDate] = useState(oneMonthExpiration.toISOString().slice(0, 10));
  let [searchParams] = useSearchParams();
  let custom = Boolean(searchParams.get('custom') === 'true');
  let datasetId = Number(searchParams.get('ds'));
  let ds = store.sharing[datasetId];
  let vaccines = (custom ? Object.values(store.vaccines) : Object.values(store.vaccines).filter(filterForTypes(ds.shcTypes)).filter(filterForIds(ds.shcs)));
  const defaultArray = new Array(vaccines.length).fill(false)
  // state for keeping track of checked/unchecked vaccines
  const [isChecked, setIsChecked] = useState<boolean[]>(defaultArray);

  async function activate() {
    if (custom) {
      const checkedVaccinations = vaccines.map(card => card.id).filter((card, i) => isChecked[i] === true);
      // create new DataSet using the checked vaccinations
      datasetId = Object.keys(store.sharing).length;
      const customDataSet : DataSet = {
        id: datasetId,
        name: datasetName,
        shcs: checkedVaccinations,
        shlinks: {}
      };
      dispatch({ type: 'dataset-add', ds: customDataSet });
    }

    const label = (custom ? datasetName : ds.name);
    await serverSyncer.createShl(label, datasetId, {
      passcode: usePasscode ? passcode : undefined,
      exp: expires ? new Date(expiresDate).getTime() / 1000 : undefined,
    });
    navigate(`/health-links`, { replace: true });
    // navigate(`/health-links/${ds.id}/${newShlinkId}`, { replace: true });
  }

  return (
    <>
      {' '}
      <h3>New SMART Health Link: {custom ? 'New Custom Dataset' : store.sharing[datasetId].name}</h3>{' '}
      <input
        type="checkbox"
        checked={usePasscode}
        onChange={() => {
          setUsePasscode(!usePasscode);
        }}
      />{' '}
      Use Passcode {usePasscode ? <input type="text" value={passcode} onChange={(e) => setPasscode(e.target.value)} /> : ''} <br></br>
      <input
        type="checkbox"
        checked={expires}
        onChange={() => {
          setExpires(!expires);
        }}
      />{' '}
      Link expires?{' '}
      {expires ? <input type="date" value={expiresDate} onChange={(e) => setExpiresDate(e.target.value)} /> : ''}{' '}
      <h4>Records to Share</h4>
      <ol>
        {vaccines.map((v, i) => {
          let fe = v.payload?.vc?.credentialSubject?.fhirBundle?.entry;
          let drug = cvx[fe[1].resource.vaccineCode.coding[0].code as string] || 'immunization';
          let location = fe[1].resource?.performer?.[0]?.actor?.display || 'location';
          if (custom) {
            return (
              <li key={i} style={{ fontFamily: 'monospace' }}>
              <input type="checkbox" checked={isChecked[i]} onChange={() => handleOnChange(i)}/>
                <label>
                {' '}
               {fe[1].resource.occurrenceDateTime} {fe[0].resource.name[0].given} {fe[0].resource.name[0].family}{' '}
               {drug.slice(0, 23)}
               {drug.length > 20 ? '...' : ''} at {location}
                </label>
            </li>
            )
          } else {
            return (
              <li key={i} style={{ fontFamily: 'monospace' }}>
                {fe[1].resource.occurrenceDateTime} {fe[0].resource.name[0].given} {fe[0].resource.name[0].family}{' '}
                {drug.slice(0, 23)}
                {drug.length > 20 ? '...' : ''} at {location}
              </li>
            );
          }
        })}
      </ol>
      {custom && 
      <>
        Custom Dataset Name: <input type='text' value={datasetName} onChange={(e) => setDataSetName(e.target.value)} /> <br></br>
      </>}
      <button onClick={activate}>Activate new sharing link</button>
    </>
  );
}

export function SHLinkDetail() {
  let params = useParams();
  return (
    <>
      Viewing SHL: {params.datasetId} :: {params.shlinkId}
    </>
  );
}

export function SHLinks() {
  let navigate = useNavigate();
  let { store, dispatch } = useStore();
  let [qrDisplay, setQrDisplay] = useState({} as Record<string | number, boolean> | null);
  let [qrData, setQrData] = useState({} as Record<number, string> | null);
  let [accessLogDisplay, setAccessLogDisplay] = useState({} as Record<number, boolean>);

  let allLinks = Object.values(store.sharing)
    .flatMap((r) => Object.values(r.shlinks))
    .map((l) => ({ id: l.id, link: generateLinkUrl(l) }));

  useDeepCompareEffect(() => {
    Promise.all(
      allLinks.map(async ({ id, link }) => [id, await QRCode.toDataURL(link, { errorCorrectionLevel: 'high' })]),
    ).then((qrs) => {
      setQrData(Object.fromEntries(qrs));
    });
  }, [allLinks]);

  return (
    <div>
      {Object.values(store.sharing ?? []).map((ds) => (
        <React.Fragment key={ds.id}>
          <h4>
            {ds.name}
            {Object.entries(ds.shlinks).length === 0 && (
              <button onClick={() => navigate('/health-links/new?ds=' + ds.id)}>Create new link</button>
            )}
          </h4>
          {Object.values(ds.shlinks).map((shl, i) => (
            <ul key={i}>
              <li>
                <em>Passcode {shl.serverConfig.passcode ? 'enabled 🔒' : 'disabled 🔓'}</em>
              </li>
              <li>
                <em>
                  {shl.serverConfig.exp
                    ? `Expires ${new Date(shl.serverConfig.exp * 1000).toLocaleDateString()}`
                    : 'Never expires'}
                </em>
              </li>
              <li>
                <em>Access count: {shl.serverStatus?.recipients?.length}</em>
                <br></br>
                <button
                  onClick={() => {
                    setAccessLogDisplay((ld) => ({ ...ld, [shl.id]: !ld[shl.id] }));
                  }}
                >
                  See acccess log
                </button>
                {accessLogDisplay[shl.id] && (
                  <ul>
                    {[...new Set(shl.serverStatus?.recipients?.map((c) => c.name))].map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                )}
              </li>
              <li>
                Share
                <br></br>
                <button
                  onClick={async () => {
                    setQrDisplay({ ...qrDisplay, [shl.id]: !qrDisplay?.[shl.id] });
                  }}
                >
                  {qrDisplay?.[shl.id] ? 'Hide' : 'Show'} QR
                </button>
                {qrDisplay?.[shl.id] && (
                  <div className="qr-box">
                    <img alt="QR code" className="qr" src={qrData?.[shl.id]} />
                    <img alt="SMART logo" className="qr-overlay" src="smart-logo.svg" />
                  </div>
                )}
                <br></br>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(generateLinkUrl(shl));
                    console.log('Copied');
                  }}
                >
                  Copy to clipboard
                </button>
              </li>
              <li>
                Manage
                <br></br>
                <button
                  onClick={() => {
                    //FIXME

                    dispatch({ type: 'shl-remove', datasetId: ds.id, shlinkId: shl.id });
                  }}
                >
                  Deactivate
                </button>
              </li>
            </ul>
          ))}
        </React.Fragment>
      ))}
      <h4>
        New Custom Data Set
        <button onClick={() => navigate('/health-links/new?custom=true')}>Create new dataset and link</button>
      </h4>
    </div>
  );
}

interface AppState {
  vaccines: Record<number, StoredSHC>;
  sharing: Record<number, DataSet>;
}

type AppAction =
  | {
      type: 'vaccine-add';
      vaccine: StoredSHC;
    }
  | {
      type: 'vaccine-delete';
      vaccine: StoredSHC;
    }
  | {
    type: 'dataset-add';
    ds: DataSet;
  }
  | {
      type: 'shl-add';
      datasetId: number;
      shlink: DataSet['shlinks'][number];
    }
  | {
      type: 'shl-remove';
      datasetId: number;
      shlinkId: number;
    }
  | {
      type: 'shl-status-update';
      datasetId: number;
      shlinkId: number;
      status: SHLinkStatus;
    }
  | {
      type: 'shl-connection-add';
      eventData: { shlId: string; recipient: string };
    }
  | {
      type: 'shl-shc-sync';
      datasetId: number;
      shlinkId: number;
      shcId: number;
      status: 'need-add' | 'need-delete' | 'present' | 'absent';
      shlServerStatus?: SHLinkStatus;
    };

function reducer(state: AppState, action: AppAction): AppState {
  if (action.type === 'dataset-add') {
    return produce(state, (state) => {
      state.sharing[action.ds.id] = action.ds;
    });
  }
  if (action.type === 'vaccine-add') {
    return produce(state, (state) => {
      state.vaccines[action.vaccine.id] = action.vaccine;
    });
  }
  if (action.type === 'shl-add') {
    return produce(state, (state) => {
      state.sharing[action.datasetId].shlinks[action.shlink.id] = action.shlink;
    });
  }
  if (action.type === 'shl-remove') {
    return produce(state, (state) => {
      delete state.sharing[action.datasetId].shlinks[action.shlinkId];
    });
  }
  if (action.type === 'shl-status-update') {
    return produce(state, (state) => {
      state.sharing[action.datasetId].shlinks[action.shlinkId].serverStatus = action.status;
    });
  }
  if (action.type === 'shl-connection-add') {
    const { shlId, recipient } = action.eventData;
    const datasetId = Object.values(state.sharing).filter((ds) =>
      Object.values(ds.shlinks).some((shl) => shl.serverStatus?.id === shlId),
    )[0].id;
    const shlinkId = Object.values(state.sharing[datasetId].shlinks).filter((shl) => shl.serverStatus?.id === shlId)[0]
      .id;
    return produce(state, (state) => {
      const serverStatus = state.sharing[datasetId].shlinks[shlinkId].serverStatus!;
      serverStatus.recipients = [...(serverStatus.recipients ?? []), { name: recipient }];
    });
  }
  if (action.type === 'shl-shc-sync') {
    return produce(state, (state) => {
      if (action.shlServerStatus) {
        state.sharing[action.datasetId].shlinks[action.shlinkId].serverStatus = action.shlServerStatus;
      }
      if (action.status === 'absent') {
        delete state.sharing[action.datasetId].shlinks[action.shlinkId].uploads[action.shcId];
      } else {
        state.sharing[action.datasetId].shlinks[action.shlinkId].uploads[action.shcId] = action.status;
      }
    });
  }

  return state;
}

export function SettingsPage() {
  return <>This site is a demonstration for SMART Health Links.
  <ul>
    <li><a href="https://docs.smarthealthit.org/smart-health-links/">About SHL</a></li>
    <li><a href="https://github.com/jmandel/vaxx.link">Source code</a></li>
  </ul>
  </>;
}

export function Vaccines() {
  let { store } = useStore();
  let vaccines = Object.values(store.vaccines);
  return (
    <ol>
      {vaccines.map((v, i) => {
        let fe = v.payload?.vc?.credentialSubject?.fhirBundle?.entry;
        let drug = cvx[fe[1].resource.vaccineCode.coding[0].code as string] || 'immunization';
        let location = fe[1].resource?.performer?.[0]?.actor?.display || 'location';
        return (
          <li key={i} style={{ fontFamily: 'monospace' }}>
            {fe[1].resource.occurrenceDateTime} {fe[0].resource.name[0].given} {fe[0].resource.name[0].family}{' '}
            {drug.slice(0, 23)}
            {drug.length > 20 ? '...' : ''} at {location}
          </li>
        );
      })}
    </ol>
  );
}

let serverSyncer: ServerStateSync;
let server = realServer;
function App() {
  let [store, dispatch] = useReducer(reducer, {
    vaccines: [],
    sharing: localStorage.getItem('shlinks')
      ? JSON.parse(localStorage.getItem('shlinks')!)
      : Object.fromEntries(defaultDatasets.map((o) => [o.id, o] as const)),
  });

  let storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
    serverSyncer && serverSyncer.appStateChange();
  }, [store]);

  const shls = Object.values(store.sharing)
    .flatMap((ds) => Object.values(ds.shlinks))
    .map((v) => ({ shlId: v.serverStatus!.id, managementToken: v.serverStatus?.managementToken! }));

  let [connectionCount, setConnectionCount] = useState(0);
  useDeepCompareEffect(() => {
    let cleanupAsync: () => void;
    (async function () {
      const { eventSource, cleanup } = await server.subscribeToShls(shls, () =>
        setConnectionCount(connectionCount + 1),
      );
      cleanupAsync = cleanup;
      eventSource.addEventListener('connection', (e) => {
        const data = JSON.parse(e.data) as { shlId: string; recipient: string };
        dispatch({ type: 'shl-connection-add', eventData: data });
        console.log('ES message cxn', data);
      });
    })();

    return () => {
      cleanupAsync && cleanupAsync();
    };
  }, [shls, connectionCount]);

  useEffect(() => {
    serverSyncer = new ServerStateSync(storeRef, dispatch, server);
    defaultImmunizations.then((vs) => vs.forEach((vaccine) => dispatch({ type: 'vaccine-add', vaccine })));
  }, []);

  let location = useLocation();
  let initialLocation = useRef(location);
  useEffect(() => {
    setTopNavValue(initialLocation.current.pathname!.split('/')[1]);
  }, [initialLocation]);

  let [topNavValue, setTopNavValue] = useState('vaccines');

  return (
    <Container maxWidth="sm">
      <BottomNavigation
        showLabels
        value={topNavValue}
        onChange={(event, newValue) => {
          setTopNavValue(newValue);
        }}
      >
        <BottomNavigationAction label="Vaccines" component={NavLink} to="/" value="" icon={<VaccinesIcon />} />
        <BottomNavigationAction
          label="Health Links"
          component={NavLink}
          value="health-links"
          to="/health-links"
          icon={<ShareIcon />}
        />
        <BottomNavigationAction
          label="About"
          component={NavLink}
          value="settings"
          to="/settings"
          icon={<Settings />}
        />
      </BottomNavigation>

      <Outlet context={{ store, dispatch, serverSyncer }} />
    </Container>
  );
}

export function useStore() {
  return useOutletContext<{
    store: AppState;
    dispatch: React.Dispatch<AppAction>;
    serverSyncer: ServerStateSync;
  }>();
}

export default App;
