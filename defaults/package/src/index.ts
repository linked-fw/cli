import './types.js';
// Registers the ontology. This MUST be the `.register.js` sibling, not the terms module
// itself: importing the terms module alone never calls `linkedOntology()`, so the ontology
// is silently never registered. See the comment in the register file for why registration
// cannot live in the terms module.
import './ontologies/${hyphen_name}.register.js';

//SHAPES FIRST — all shapes register via the barrel
import './shapes/index.js';

//THEN COMPONENTS
// import './components/YourComponent';
