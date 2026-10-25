import {Shape} from '@_linked/core/shapes/Shape';
import {literalProperty} from '@_linked/core/shapes/SHACL';
import {createNameSpace} from '@_linked/core/utils/NameSpace';
import * as schema from '@_linked/schema/ontologies/schema';
// Extensionless on purpose: Metro does not map `.js` specifiers to `.ts` source.
import {linkedShape} from '../package';

// The app's own terms. Reuse a vocabulary's terms where one fits, as `name` does.
const ns = createNameSpace('https://example.com/app/');

@linkedShape
export class Example extends Shape {
  static targetClass = ns('Example');

  @literalProperty({path: schema.name, maxCount: 1})
  get name(): string {
    return '';
  }
}
