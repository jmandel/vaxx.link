import React, { useEffect, useReducer, useRef, useState } from 'react';
import produce from 'immer';
import './App.css';
import { Outlet, NavLink, useParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useOutletContext } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';

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
        fhirBundle: object;
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
  accessToken: string;
  managementToken: string;
  rar: {
    type: 'shlink-view';
    url: string;
    hash?: string;
  }[];
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
  encryptionKey?: Uint8Array[32];
  uploads: Record<StoredSHC['id'], 'need-delete' | 'need-add' | 'present'>;
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
    config.serverStatus!.rar.push({
      type: 'shlink-view',
      url: 'https://sefver/' + Math.random(),
      hash: `hash-of-todo(${shc.jws.slice(0, 10)})`,
    });
    return Promise.resolve(config.serverStatus!);
  },
  createShl: async (shl) => {
    let serverStatus = {
      accessToken: '123',
      managementToken: '' + Math.random(),
      active: true,
      log: [],
      rar: [],
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
    this.dispatch({
      type: 'shl-add',
      datasetId,
      shlink: {
        id: newShlinkId,
        name: 'TODO remove names',
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

async function createFakeData(
  datasetId: number,
  shlinks: SHLink[],
  store: AppState,
  dispatch: React.Dispatch<AppAction>,
  server: DataServer,
) {
  for (let shlink of shlinks) {
    const ds = store.sharing[datasetId];
    let serverStatus = await server.createShl(shlink.serverConfig);
    dispatch({
      type: 'shl-add',
      datasetId: ds.id,
      shlink: { ...shlink, serverStatus },
    });
  }
  return;
}

const defaultShlinks: SHLink[] = [
  {
    id: 0,
    name: "Josh's School Vaccines",
    serverConfig: {
      encrypted: false,
    },
    uploads: {},
  },
];

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
const defaultImmunizations: StoredSHC[] = [
  {
    id: 0,
    jws: 'COVID-19 Vaccine dose 1',
    payload: {
      iss: 'hospital',
      nbf: 0,
      vc: { type: ['https://smarthealth.cards#immunization'], credentialSubject: { fhirBundle: {}, fhirVersion: '' } },
    },
  },
  {
    id: 1,
    jws: 'COVID-19 Vaccine dose 2',
    payload: {
      iss: 'hospital',
      nbf: 0,
      vc: { type: ['https://smarthealth.cards#immunization'], credentialSubject: { fhirBundle: {}, fhirVersion: '' } },
    },
  },
];

export function SHLinkCreate() {
  let navigate = useNavigate();
  let location = useLocation();
  let { store, dispatch } = useStore();
  let [usePin, setUsePin] = useState(true);
  let [pin, setPin] = useState('1234');
  let [expires, setExpires] = useState(false);

  let oneMonthExpiration = new Date(new Date().getTime() + 1000 * 3600 * 24 * 31);
  let [expiresDate, setExpiresDate] = useState(oneMonthExpiration.toISOString().slice(0, 10));
  let [searchParams, setSearchParams] = useSearchParams();
  let datasetId = Number(searchParams.get('ds'));
  let ds = store.sharing[datasetId];
  let vaccines = Object.values(store.vaccines).filter(ds.shcFilter ?? (() => true));

  async function activate() {
    const newShlinkId = await serverSyncer.createShl(datasetId, {
      encrypted: false,
      pin: usePin ? pin : undefined,
      exp: expires ? new Date(expiresDate).getTime() / 1000 : undefined,
    });
    navigate(`/health-links/${ds.id}/${newShlinkId}`, { replace: true });
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
      <h4>Current Records to Share</h4>
      <ol>
        {vaccines.map((v, i) => (
          <li key={i}>{v.jws}</li>
        ))}
      </ol>
      <button onClick={activate}>Activate new sharing link</button>
    </>
  );
}

export function SHLink() {
  let navigate = useNavigate();
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

  return (
    <div>
      {Object.values(store.sharing ?? []).map((ds) => (
        <React.Fragment key={ds.id}>
          <h4>
            {ds.name}
            <button onClick={() => navigate('/health-links/new?ds=' + ds.id)}>Create new link</button>
          </h4>
          <ul>
            {Object.values(ds.shlinks).map((shl, i) => (
              <li key={i}>
                "{shl.name}"
                <ul>
                  <li>
                    <em>Expires: {shl.serverConfig.exp ?? 'never'}</em>
                  </li>
                  <li>
                    <em>Access count: {shl.serverStatus?.log.flatMap((l) => l.whenEpochSeconds).length}</em>
                  </li>
                  <li>
                    <em>PIN enabled? {shl.serverConfig.pin ? '🔒' : '🔓'}</em>
                  </li>
                  <li>
                    <button>See acccess log</button>
                  </li>
                  <li>
                    <button>Show QR</button>
                  </li>
                  <li>
                    <button>Copy to clipboard</button>
                  </li>
                  <li>
                    <button>Deactivate</button>
                  </li>
                </ul>
              </li>
            ))}
          </ul>
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
  lastShlinkId?: number;
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
  if (action.type == 'vaccine-add') {
    return produce(state, (state) => {
      state.vaccines[action.vaccine.id] = action.vaccine;
    });
  }
  if (action.type == 'shl-add') {
    return produce(state, (state) => {
      state.sharing[action.datasetId].shlinks[action.shlink.id] = action.shlink;
      state.lastShlinkId = action.shlink.id;
    });
  }
  if (action.type == 'shl-status-update') {
    return produce(state, (state) => {
      state.sharing[action.datasetId].shlinks[action.shlinkId].serverStatus = action.status;
    });
  }

  if (action.type == 'shl-shc-sync') {
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

let serverSyncer: ServerStateSync;

function App() {
  let [store, dispatch] = useReducer(reducer, {
    vaccines: Object.fromEntries(defaultImmunizations.map((o) => [o.id, o] as const)),
    sharing: Object.fromEntries(defaultDatasets.map((o) => [o.id, o] as const)),
  });

  let storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
    serverSyncer && serverSyncer.appStateChange();
  }, [store]);

  console.log(store);

  useEffect(() => {
    createFakeData(0, defaultShlinks, store, dispatch, fakeServer);
    serverSyncer = new ServerStateSync(storeRef, dispatch, fakeServer);
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <NavLink
          to="/"
          className={(al: any) => {
            return 'classone';
          }}
        >
          Vaccines
        </NavLink>
        <NavLink to="/health-links">Health Links</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </header>
      <Outlet context={{ store, dispatch, serverSyncer }} />
    </div>
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
