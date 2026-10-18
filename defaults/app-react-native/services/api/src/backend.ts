import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
// Registers the Person shape the app's example components query. LinkedServer auto-loads only the workspace
// shape packages (app-shapes); a shape from an installed package must be imported here, or the API rejects
// queries for it ("Cannot resolve shape"). In the web app-template the page render imports it instead.
import '@_linked/schema/shapes/Person';

// No custom methods: the app's DSL queries reach Fuseki through @_linked/server's generic provider
// (select/create/update/delete forwarded to LinkedStorage). LinkedServer loads this through exports["./backend"].
export class Backend extends BackendProvider {}
