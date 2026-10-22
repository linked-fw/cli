// The client's entry imports the same ontology modules a page would, through
// their register modules.
import {register as appRegister} from './ontologies/probe.register.js';
import {register as packageRegister} from '@_linked/probe-ont/ontologies/p.register.js';

document.body.textContent = [appRegister(), packageRegister()].join(' ');
