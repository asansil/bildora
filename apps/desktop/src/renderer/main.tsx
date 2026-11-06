import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@bildora/panel-sdk/theme.css';
import type { ShellApi } from '../preload/api.js';
import { App } from './App.js';
import './styles/shell.css';

declare global {
  interface Window {
    readonly bildora: ShellApi;
  }
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
