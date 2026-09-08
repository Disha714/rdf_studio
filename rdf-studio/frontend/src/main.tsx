import React from 'react';
import ReactDOM from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './theme';
import { notifyError, ToastProvider } from './toast';
import './monacoSetup';
import './styles.css';

const client = new QueryClient({
  queryCache: new QueryCache({ onError: error => notifyError(error, 'Data loading failed') }),
  mutationCache: new MutationCache({ onError: error => notifyError(error, 'Action failed') }),
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemeProvider><ToastProvider><QueryClientProvider client={client}><BrowserRouter><App/></BrowserRouter></QueryClientProvider></ToastProvider></ThemeProvider></React.StrictMode>);
