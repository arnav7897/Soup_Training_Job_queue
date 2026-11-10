import { loadConfig } from './config';
loadConfig(process.env);
console.log('Worker scaffold started; job processing is not implemented yet.');
setInterval(() => {}, 60_000);
