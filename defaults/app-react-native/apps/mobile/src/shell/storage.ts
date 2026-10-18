// Sends every Linked query to the API (services/api). Import @_linked/server by subpath only: the root barrel
// pulls express, webpack and react-dom.
// ./env comes first: RemoteDataset without a `url` goes through Server.call, which reads SITE_ROOT once.
import './env';

import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { RemoteDataset } from '@_linked/server/shapes/quadstores/RemoteDataset';

// No `url`: services/api is this app's own backend, reached through SITE_ROOT like any custom Server.call. The
// `{ url, token }` form is for a separate data server that takes a bearer token.
LinkedStorage.setDefaultDataset(new RemoteDataset({ name: 'appData' }));
