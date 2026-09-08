// Bundle Monaco locally instead of letting @monaco-editor/react fetch it from the
// jsdelivr CDN at runtime. The CDN loader can hang on "Loading…" (offline, blocked,
// or version-mismatch), which is why the Code tab's editor never appeared. Pointing
// the loader at the installed `monaco-editor` package makes it load from the app
// bundle - instant and offline-safe. Imported once from main.tsx before render.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Vite web-worker wiring for Monaco. Python/SPARQL use the core editor worker
// (tokenizer-based highlighting, no language service needed).
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
