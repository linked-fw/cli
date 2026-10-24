import {Shape} from '@_linked/core/shapes/Shape';
import {linkedShape} from '../package.js';

/**
 * Add the target class and properties of this shape, e.g.
 *
 *   import * as schema from '@_linked/schema/ontologies/schema';
 *
 *   static targetClass = schema.Product;
 *
 *   @literalProperty({path: schema.name, maxCount: 1})
 *   get name(): string {
 *     return '';
 *   }
 *
 * Properties are getters only: a shape describes data, it does not hold it.
 */
@linkedShape
export class ${camel_name} extends Shape {}
