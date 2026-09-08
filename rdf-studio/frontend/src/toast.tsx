import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';

type Toast = { id: number; title: string; message: string };
type ToastContextValue = { pushError: (error: unknown, title?: string) => void; dismiss: (id: number) => void };

const ToastContext = createContext<ToastContextValue | null>(null);
const listeners = new Set<(error: unknown, title?: string) => void>();
const recent = new Map<string, number>();

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message);
  return String(error || 'Something went wrong.');
}

// Known-benign Monaco DiffEditor teardown race (upstream @monaco-editor/react bug,
// triggered by React StrictMode's double mount/unmount in dev): the widget's model
// gets reset after the underlying TextModel is already disposed. Doesn't affect
// app state, so don't alarm the user with it.
const isBenignMonacoDisposeRace = (message: string) => message.includes('TextModel got disposed before DiffEditorWidget model got reset');

export function notifyError(error: unknown, title = 'Error') {
  const message = errorMessage(error);
  if (isBenignMonacoDisposeRace(message)) return;
  const key = `${title}:${message}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 900) return;
  recent.set(key, now);
  listeners.forEach(listener => listener(error, title));
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);
  const pushError = useCallback((error: unknown, title = 'Error') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts(current => [...current, { id, title, message: errorMessage(error) }].slice(-5));
    window.setTimeout(() => dismiss(id), 10_000);
  }, [dismiss]);

  useEffect(() => {
    listeners.add(pushError);
    const onError = (event: ErrorEvent) => notifyError(event.error || event.message, 'Application error');
    const onUnhandled = (event: PromiseRejectionEvent) => notifyError(event.reason, 'Unhandled error');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      listeners.delete(pushError);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, [pushError]);

  const value = useMemo(() => ({ pushError, dismiss }), [pushError, dismiss]);

  return <ToastContext.Provider value={value}>
    {children}
    <div className="toast-region" role="region" aria-label="Notifications">
      {toasts.map(toast => <div className="toast error-toast" role="alert" key={toast.id}>
        <AlertTriangle size={18} />
        <div><strong>{toast.title}</strong><p>{toast.message}</p></div>
        <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={16} /></button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
