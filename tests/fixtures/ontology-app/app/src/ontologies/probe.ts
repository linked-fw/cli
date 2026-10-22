import {loadFiles} from '../loadFiles.js';

export const moduleUrl = () => import.meta.url;
export const loadData = () => loadFiles(import.meta.url, ['../data/probe.ttl']);
