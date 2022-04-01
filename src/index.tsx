import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { HashRouter, Routes, Route } from "react-router-dom";

import './index.css';
import App from './App';
import {SHLink, SHLinks, SHLinkCreate} from './App';
import reportWebVitals from './reportWebVitals';

let root = ReactDOMClient.createRoot(document.getElementById('root')!);

root.render(
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route path="health-links/new" element={<SHLinkCreate />} />
          <Route path="health-links" element={<SHLinks />} />
          <Route path="health-links/:datasetId/:shlinkId" element={<SHLink />} />
        </Route>
      </Routes>
    </HashRouter>
  
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
