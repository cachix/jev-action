import { runAction } from './action.js';
runAction().then((exitCode) => {
    process.exitCode = exitCode;
}, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Jev action: ${message.replaceAll(/[\r\n]/g, ' ')}`);
    process.exitCode = 1;
});
