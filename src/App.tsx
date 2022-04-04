import RestoreIcon from '@mui/icons-material/Restore';
import Settings from '@mui/icons-material/Settings';
import ShareIcon from '@mui/icons-material/Share';
import { BottomNavigation, BottomNavigationAction } from '@mui/material';
import Container from '@mui/material/Container';
import produce from 'immer';
import QRCode from 'qrcode';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams
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
  pin?: string;
  exp?: number;
  encrypted: boolean;
}

interface SHLinkStatus {
  active: boolean;
  url: string;
  token: string;
  managementToken: string;
  log: {
    name: string;
    whenEpochSeconds: number[];
  }[];
}

interface SHLink {
  id: number;
  name: string;
  serverConfig: SHLinkConfig;
  serverStatus?: SHLinkStatus;
  encryptionKey?: Uint8Array;
  uploads: Record<StoredSHC['id'], 'need-delete' | 'need-add' | 'present'>;
}

function b64urlencode(source: string | Uint8Array) {
  let s = source;
  if (source.constructor === Uint8Array) {
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
  const qrPayload = {
    oauth: {
      url: shl.serverStatus?.url,
      token: shl.serverStatus?.token,
    },
    exp: shl.serverConfig.exp,
    flags: shl.serverConfig.pin ? 'P' : '',
    decrypt: shl.encryptionKey ? b64urlencode(shl.encryptionKey) : undefined,
  };

  const qrJson = JSON.stringify(qrPayload);
  const qrEncoded = b64urlencode(qrJson);

  const qrPrefixed = 'shclink:/' + qrEncoded;
  const hostedLandingPage = 'https://shared.vaxx.link#';
  const link = (hostedLandingPage || '') + qrPrefixed;
  return link;
}

interface DataSet {
  id: number;
  name: string;
  shcFilter?: (shc: StoredSHC) => boolean;
  shlinks: Record<number, SHLink>;
}

interface DataServer {
  storeShc: (shl: SHLink, shc: StoredSHC) => Promise<SHLinkStatus>;
  createShl: (shl: SHLink['serverConfig']) => Promise<SHLinkStatus>;
}

const fakeServerDb: Record<string, Omit<SHLink, 'id' | 'name' | 'encryptionKey'>> = {};
const fakeServer: DataServer = {
  storeShc: async (shl, shc) => {
    const config = fakeServerDb[shl.serverStatus!.managementToken];
    return Promise.resolve(config.serverStatus!);
  },
  createShl: async (shl) => {
    let fakeAccessToken = new Uint8Array(32);
    crypto.getRandomValues(fakeAccessToken);

    let serverStatus = {
      url: 'https://fakeserver-with-a-long-url.example.org/oauth/v3/intenral-routing-path-segments/authorize',
      token: b64urlencode(fakeAccessToken),
      managementToken: '' + Math.random(),
      active: true,
      log: [],
    };
    fakeServerDb[serverStatus.managementToken] = {
      uploads: {},
      serverConfig: shl,
      serverStatus,
    };
    await new Promise((res) => setTimeout(() => res(null), 50));
    return Promise.resolve(JSON.parse(JSON.stringify(serverStatus)));
  },
};

let idGenerator = 100;
class ServerStateSync {
  dispatch: React.Dispatch<AppAction>;
  previousState?: AppState;
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

  async createShl(datasetId: number, serverConfig: SHLinkConfig) {
    let serverStatus = await this.server.createShl(serverConfig);
    let newShlinkId = idGenerator++;
    let encryptionKey;
    if (serverConfig.encrypted) {
      encryptionKey = new Uint8Array(32);
      crypto.getRandomValues(encryptionKey);
    }
    this.dispatch({
      type: 'shl-add',
      datasetId,
      shlink: {
        id: newShlinkId,
        name: 'TODO remove names',
        encryptionKey,
        serverConfig,
        serverStatus,
        uploads: {},
      },
    });
    return newShlinkId;
  }
  async appStateChange() {
    console.log('sync up');
    let store = this.storeRef.current;
    let allCards = Object.values(store.vaccines);

    let serverRequestsNeeded: {
      datasetId: number;
      shlinkId: number;
      shcId: number;
      action: 'need-delete' | 'need-add';
    }[] = [];

    for (const ds of Object.values(store.sharing)) {
      const cardsForDs = allCards.filter(ds.shcFilter ?? (() => true));
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
    shcFilter: (_shc) => true,
    shlinks: {},
  },
  {
    id: 1,
    name: 'School Vaccines',
    shcFilter: (shc) => !!shc?.payload?.vc?.type.includes('https://smarthealth.cards#immunization'),
    shlinks: {},
  },
];

const defaultImmunizations: Promise<StoredSHC[]> = Promise.all(
  shcJwsFixtures.map(async (jws) => {
    const context = new shdc.Context();
    context.compact = jws;
    const payload = (await shdc.low.decode.jws.compact(context)).jws.payload;
    return {
      id: idGenerator++,
      jws,
      payload,
    };
  }),
);

export function SHLinkCreate() {
  let navigate = useNavigate();
  let { store } = useStore();
  let [usePin, setUsePin] = useState(true);
  let [pin, setPin] = useState('1234');
  let [expires, setExpires] = useState(false);

  let oneMonthExpiration = new Date(new Date().getTime() + 1000 * 3600 * 24 * 31);
  let [expiresDate, setExpiresDate] = useState(oneMonthExpiration.toISOString().slice(0, 10));
  let [searchParams] = useSearchParams();
  let datasetId = Number(searchParams.get('ds'));
  let ds = store.sharing[datasetId];
  let vaccines = Object.values(store.vaccines).filter(ds.shcFilter ?? (() => true));

  async function activate() {
    await serverSyncer.createShl(datasetId, {
      encrypted: true,
      pin: usePin ? pin : undefined,
      exp: expires ? new Date(expiresDate).getTime() / 1000 : undefined,
    });
    navigate(`/health-links`, { replace: true });
    // navigate(`/health-links/${ds.id}/${newShlinkId}`, { replace: true });
  }

  return (
    <>
      {' '}
      <div>Create new: {store.sharing[datasetId].name}</div>{' '}
      <input
        type="checkbox"
        checked={usePin}
        onChange={() => {
          setUsePin(!usePin);
        }}
      />{' '}
      Use PIN {usePin ? <input type="text" value={pin} onChange={(e) => setPin(e.target.value)} /> : ''} <br></br>
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
          return (
            <li key={i} style={{ fontFamily: 'monospace' }}>
              {fe[1].resource.occurrenceDateTime} {fe[0].resource.name[0].given} {fe[0].resource.name[0].family}{' '}
              {drug.slice(0, 23)}
              {drug.length > 20 ? '...' : ''} at {location}
            </li>
          );
        })}
      </ol>
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
  let [qrDisplay, setQrDisplay] = useState({} as Record<number, boolean> | null);
  let [qrData, setQrData] = useState({} as Record<number, string> | null);

  useEffect(() => {
    console.log('SHLinks changed; rerender QR');
    let allLinks = Object.values(store.sharing).flatMap((r) => Object.values(r.shlinks));
    Promise.all(
      allLinks.map(async (l) => [l.id, await QRCode.toDataURL(generateLinkUrl(l), { errorCorrectionLevel: 'medium' })]),
    ).then((qrs) => {
      setQrData(Object.fromEntries(qrs));
      setQrDisplay(Object.fromEntries(qrs.map(([l, _]) => [l, false])));
    });
  }, [store.sharing]);

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
                <em>PIN {shl.serverConfig.pin ? 'enabled 🔒' : 'disabled 🔓'}</em>
              </li>
              <li>
                <em>
                  {shl.serverConfig.exp
                    ? `Expires ${new Date(shl.serverConfig.exp * 1000).toLocaleDateString()}`
                    : 'Never expires'}
                </em>
              </li>
              <li>
                <em>Access count: {shl.serverStatus?.log.flatMap((l) => l.whenEpochSeconds).length}</em>
                <br></br>
                <button>See acccess log</button>
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
        Custom Data Set
        <button>Create new link</button>
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
      type: 'shl-shc-sync';
      datasetId: number;
      shlinkId: number;
      shcId: number;
      status: 'need-add' | 'need-delete' | 'present' | 'absent';
      shlServerStatus?: SHLinkStatus;
    };

function reducer(state: AppState, action: AppAction): AppState {
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
  return <>TODO</>;
}

let serverSyncer: ServerStateSync;

function App() {
  let [store, dispatch] = useReducer(reducer, {
    vaccines: [],
    sharing: Object.fromEntries(defaultDatasets.map((o) => [o.id, o] as const)),
  });

  let storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
    serverSyncer && serverSyncer.appStateChange();
  }, [store]);

  useEffect(() => {
    serverSyncer = new ServerStateSync(storeRef, dispatch, fakeServer);
    defaultImmunizations.then((vs) => vs.forEach((vaccine) => dispatch({ type: 'vaccine-add', vaccine })));
  }, []);

  let location = useLocation()
  let initialLocation = useRef(location)
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
        <BottomNavigationAction label="Vaccines" component={NavLink} to="/" value="" icon={<RestoreIcon />} />
        <BottomNavigationAction
          label="Health Links"
          component={NavLink}
          value="health-links"
          to="/health-links"
          icon={<ShareIcon />}
        />
        <BottomNavigationAction
          label="Settings"
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
