// Shape registry: one side-effect import per shape module, so loading this file
// registers every shape in the package. Imports only — no exports. `linked build`
// fails when a shape module is missing from this list.
// Extensionless on purpose: Metro does not map `.js` specifiers to `.ts` source.
import './Example';
