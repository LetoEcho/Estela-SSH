import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';

// The same bundle serves the main window and the editor windows (#editor=<id>).
const root = location.hash.startsWith('#editor=')
  ? import('./app/editor-app').then((m) => m.EditorApp)
  : import('./app/app').then((m) => m.App);

root.then((c) => bootstrapApplication(c, appConfig)).catch((err) => console.error(err));
