#!/usr/bin/env node
// git's askpass program for the cli's remote git calls (src/integration/credentials.ts sets
// GIT_ASKPASS to this file only when LINKED_GIT_TOKEN is set). git runs it with its prompt as the
// one argument and reads the answer from stdout: "Username for 'https://github.com': " gets
// LINKED_GIT_USERNAME or x-access-token, "Password for '…': " gets LINKED_GIT_TOKEN. Anything
// else, or a missing token, exits 1, so git fails rather than waits.
// Plain, unbuilt CommonJS with Node built-ins only, like the other files in hooks/.
'use strict';

/** The answer to `prompt`, or null when there is none to give. */
function answer(prompt, env) {
  const token = env.LINKED_GIT_TOKEN;
  if (!token) return null;
  if (/^\s*username\b/i.test(prompt)) return env.LINKED_GIT_USERNAME || 'x-access-token';
  if (/^\s*password\b/i.test(prompt)) return token;
  return null;
}

module.exports = {answer};

if (require.main === module) {
  const reply = answer(process.argv[2] || '', process.env);
  if (reply === null) process.exit(1);
  process.stdout.write(reply + '\n');
}
