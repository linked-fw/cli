import {linkedPackage} from '@_linked/core/utils/Package';

// `linkedComponent` is deliberately not destructured here: it is not part of core's
// `LinkedPackageObject`. Component binding lives in `@_linked/react` — import
// `linkedComponent` from `@_linked/react/utils/LinkedComponent` in a package that needs it,
// so a package with no UI does not depend on React to declare its shapes.
export const {
  linkedShape,
  linkedUtil,
  registerOntologies,
  registerPackageExport,
  packageExports,
  packageName,
  getPackageShape

} = linkedPackage('${package_name}');
