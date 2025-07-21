import { inspect } from 'node:util';

import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { requestLog } from '@octokit/plugin-request-log';
import { type RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { throttling, type ThrottlingOptions } from '@octokit/plugin-throttling';
import { type OctokitResponse } from '@octokit/types';

import { Temporal } from '@js-temporal/polyfill';

type Octokit = ReturnType<typeof getOctokit>;
type PackageVersion =
    RestEndpointMethodTypes['packages']['getPackageVersionForAuthenticatedUser']['response']['data'];

abstract class Owner {
    constructor(
        readonly github: Octokit,
        readonly name: string
    ) {}

    abstract getPackage(packageName: string): Package;
}

abstract class Package {
    constructor(
        readonly owner: Owner,
        readonly name: string
    ) {}

    get github() {
        return this.owner.github;
    }

    abstract listVersions(): AsyncIterableIterator<
        OctokitResponse<PackageVersion[]>
    >;

    abstract deleteVersion(id: number): Promise<OctokitResponse<never>>;
}

class UserPackage extends Package {
    listVersions() {
        const { github } = this;

        return github.paginate.iterator(
            github.rest.packages.getAllPackageVersionsForPackageOwnedByUser,
            {
                username: this.owner.name,
                package_name: this.name,
                package_type: 'container',
                per_page: 100,
            }
        );
    }

    deleteVersion(id: number) {
        return this.github.rest.packages.deletePackageVersionForUser({
            username: this.owner.name,
            package_name: this.name,
            package_type: 'container',
            package_version_id: id,
        });
    }
}

class User extends Owner {
    getPackage(packageName: string): Package {
        return new UserPackage(this, packageName);
    }
}

class OrgPackage extends Package {
    listVersions() {
        return this.github.paginate.iterator(
            this.github.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
            {
                org: this.owner.name,
                package_name: this.name,
                package_type: 'container',
                per_page: 100,
            }
        );
    }

    deleteVersion(id: number) {
        return this.github.rest.packages.deletePackageVersionForOrg({
            org: this.owner.name,
            package_name: this.name,
            package_type: 'container',
            package_version_id: id,
        });
    }
}

class Organization extends Owner {
    getPackage(packageName: string): Package {
        return new OrgPackage(this, packageName);
    }
}

async function getOwner(github: Octokit, name: string) {
    const ownerTypes: Record<
        string,
        new (...args: ConstructorParameters<typeof Owner>) => Owner
    > = {
        User,
        Organization,
    };

    const user = await github.rest.users.getByUsername({ username: name });
    const ownerType = ownerTypes[user.data.type];

    if (!ownerType) {
        throw new Error(
            `Owner type should be ${Object.keys(ownerTypes).join(' or ')}. Got ${JSON.stringify(name)} instead`
        );
    }

    return new ownerType(github, name);
}

function parseDuration(value: string) {
    try {
        return Temporal.Duration.from(
            /^[Pp+-]/.test(value) ? value : `P${value}`
        );
    } catch (ex) {
        throw new Error(
            `Can't parse ${JSON.stringify(value)} as duration: ${String(ex)}`
        );
    }
}

function isVersionOutdated(
    version: PackageVersion,
    untaggedRetentionDuration: Temporal.Duration
) {
    const metadata = version.metadata?.container;

    if (!metadata) {
        throw new Error('Missing container metadata');
    }

    const now = Temporal.Now.instant();
    const age = Temporal.Instant.from(version.updated_at).until(now);

    return (
        metadata.tags.length === 0 &&
        Temporal.Duration.compare(age, untaggedRetentionDuration) === 1
    );
}

async function processVersion(
    pkg: Package,
    version: PackageVersion,
    untaggedRetentionDuration: Temporal.Duration,
    dryRun: boolean
) {
    try {
        if (isVersionOutdated(version, untaggedRetentionDuration)) {
            if (dryRun) {
                core.notice(`Would delete ${pkg.name} ${version.name}`);
            } else {
                await pkg.deleteVersion(version.id);
                core.notice(`Deleted ${pkg.name} ${version.name}`);
            }

            return true;
        }

        core.info(`Keeping ${pkg.name} ${version.name}`);
    } catch (ex) {
        core.error(
            `Processing ${pkg.name} ${version.name} failed: ${String(ex)}`
        );
    } finally {
        core.debug(JSON.stringify(version, null, ' '));
    }

    return false;
}

async function main() {
    const token = core.getInput('github-token', { required: true });
    const dryRun = core.getBooleanInput('dry-run', { required: true });
    const ownerName = core.getInput('owner', { required: true });
    const packageName = core.getInput('name', { required: true });
    const untaggedRetentionDuration = parseDuration(
        core.getInput('untagged-retention-duration', {
            required: true,
        })
    );

    const log = {
        debug: core.isDebug()
            ? console.debug.bind(console)
            : (..._args: unknown[]) => {},
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    const throttle: ThrottlingOptions = {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
            const baseWarn = `Request quota exhausted for request ${options.method} ${options.url}`;

            if (retryCount < 1) {
                octokit.log.warn(
                    `${baseWarn}. Will retry after ${retryAfter} seconds!`
                );
                return true;
            } else {
                octokit.log.warn(`${baseWarn}. Retry limit exceeded!`);
            }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            octokit.log.warn(
                `Secondary rate limit detected for request ${options.method} ${options.url}`
            );
        },
    };

    const github = getOctokit(token, { log, throttle }, requestLog, throttling);
    const owner = await getOwner(github, ownerName);
    const pkg = owner.getPackage(packageName);
    const deleted: PackageVersion[] = [];

    try {
        for await (const response of pkg.listVersions()) {
            await Promise.allSettled(
                response.data.map(version =>
                    processVersion(
                        pkg,
                        version,
                        untaggedRetentionDuration,
                        dryRun
                    ).then(value => {
                        if (value) {
                            deleted.push(version);
                        }
                    })
                )
            );
        }
    } finally {
        core.setOutput('deleted-count', deleted.length);
        core.setOutput('deleted-json', JSON.stringify(deleted, null, ' '));
    }
}

main().catch((error: unknown) => {
    core.setFailed(String(error));
    core.debug(inspect(error));
});
