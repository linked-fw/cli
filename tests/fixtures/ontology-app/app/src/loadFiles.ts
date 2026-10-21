// A stand-in for `@_linked/core/ontology/loadOntologyFiles`: reads each file
// relative to the calling module's own URL, server side only.
export const loadFiles = async (moduleUrl: string, files: string[]): Promise<string[]> => {
  const {readFile} = await import('node:fs/promises');
  return Promise.all(files.map((file) => readFile(new URL(file, moduleUrl), 'utf8')));
};
