import {linkedPackage} from '@_linked/core/utils/Package';

// An ontology package declares one ontology and nothing else: its generated modules need
// `registerOntologies` (src/ontologies/index.ts), and `packageName` names it. Shapes, utils and
// components belong in an asset package.
export const {registerOntologies, packageName} = linkedPackage('${package_name}');
