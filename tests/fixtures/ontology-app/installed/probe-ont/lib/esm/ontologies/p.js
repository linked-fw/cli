const loadFiles = async (moduleUrl, files) => {
  const {readFile} = await import('node:fs/promises');
  return Promise.all(files.map((file) => readFile(new URL(file, moduleUrl), 'utf8')));
};
export const moduleUrl = () => import.meta.url;
export const loadData = () => loadFiles(import.meta.url, ['../data/p.ttl']);
