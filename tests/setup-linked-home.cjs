// No unit test may touch the real ~/.linked (the machine-wide master port registry and locks):
// every test file starts with LINKED_HOME in a temp dir of its own; tests that check that state
// set their own.
const os = require('os');
const path = require('path');

process.env.LINKED_HOME = path.join(os.tmpdir(), `linked-home-jest-${process.pid}-${Date.now()}`);
