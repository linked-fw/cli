// Loaded by `linked start` (Vite SSR) before the server starts: registers the graph store and the file store.
import datasetsConfig from './linked.backend.datasets.json' with { type: 'json' };
import { parseDatasetsConfig } from '@_linked/core/utils/parseDatasetsConfig';
import { loadStores } from '@_linked/core/utils/loadStores';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import type { FusekiStore } from '@_linked/fuseki/shapes/FusekiStore';
import { S3FileStore } from '@_linked/s3/shapes/S3FileStore';
import { LocalFileStore } from '@_linked/server/shapes/filestores/LocalFileStore';
import { withAccess } from '@_linked/server-utils/utils/QueryAccess';
import { getSuperShapesClasses } from '@_linked/core/utils/ShapeClass';
import { Person } from '@_linked/schema/shapes/Person';
import { hasS3Env } from './src/fileStoreEnv';
import { allowsAnonymousExampleWrites, exampleAccess } from './src/exampleAccess';

const env = process.env;

const stores = await loadStores(parseDatasetsConfig(datasetsConfig, env));
const appData = stores.appData as FusekiStore;
// Creates the dataset on first start; its type comes from FUSEKI_DB_TYPE (tdb2 for dev, mem for tests).
// Awaited so the first query never races the creation.
await appData.ensureDatasetExists();

// Who may query this store from the client (see src/exampleAccess.ts).
// Without a rule every write, and once rpcExposure is 'enforce' every read,
// needs a signed-in session, which this template has no way to create. This
// rule opens exactly the example screen: anonymous reads of Person, and
// anonymous writes of Person only under NODE_ENV=development. Everything else
// still needs a session. Remove it with the example.
const exampleShapes = new Set(
  [Person, ...getSuperShapesClasses(Person)]
    .map((shape) => shape.shape?.id)
    .filter((id): id is string => !!id),
);
withAccess(appData, exampleAccess(exampleShapes, allowsAnonymousExampleWrites(env.NODE_ENV)));
LinkedStorage.setDefaultDataset(appData);

// The S3 branch is not yet verified against a real bucket.
// LocalFileStore's name only forms its URI. Its directory is `data/uploads`, relative to the working directory, and
// `linked start` runs in services/api, so files land in services/api/data/uploads/ (gitignored).
const fileStore = hasS3Env(env)
  ? new S3FileStore('files', {
      bucketName: env.S3_FILES_BUCKET_NAME,
      clientConfig: {
        endpoint: env.S3_BUCKET_ENDPOINT,
        region: env.AWS_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : new LocalFileStore(`${env.NODE_ENV || 'development'}-files`);
LinkedFileStorage.setDefaultDataset(fileStore);
