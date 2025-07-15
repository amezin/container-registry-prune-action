import { inspect } from 'node:util';
import * as core from '@actions/core';

async function main() {}

main().catch((error: unknown) => {
    core.setFailed(String(error));
    core.debug(inspect(error));
});
