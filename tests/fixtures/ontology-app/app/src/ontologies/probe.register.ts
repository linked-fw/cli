import {loadData} from './probe.js';

export const register = () => `probe:${typeof loadData}`;
