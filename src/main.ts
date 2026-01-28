import { inspect } from 'node:util';

import * as core from '@actions/core';
import { getOctokit } from '@amezin/js-actions-octokit';
import { type RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { type OctokitResponse } from '@octokit/types';

import { Minimatch, type MinimatchOptions } from 'minimatch';
import { Temporal } from '@js-temporal/polyfill';

type Octokit = ReturnType<typeof getOctokit>;
type PackageVersion =
    RestEndpointMethodTypes['packages']['getPackageVersionForAuthenticatedUser']['response']['data'];

abstract class Package {
    constructor(
        readonly github: Octokit,
        readonly owner: string,
        readonly name: string
    ) {}

    abstract listVersions(): AsyncIterable<OctokitResponse<PackageVersion[]>>;

    abstract deleteVersion(id: number): Promise<OctokitResponse<never>>;
}

class UserPackage extends Package {
    listVersions() {
        const { github } = this;

        return github.paginate.iterator(
            github.rest.packages.getAllPackageVersionsForPackageOwnedByUser,
            {
                username: this.owner,
                package_name: this.name,
                package_type: 'container',
                per_page: 100,
            }
        );
    }

    deleteVersion(id: number) {
        return this.github.rest.packages.deletePackageVersionForUser({
            username: this.owner,
            package_name: this.name,
            package_type: 'container',
            package_version_id: id,
        });
    }
}

class OrgPackage extends Package {
    listVersions() {
        return this.github.paginate.iterator(
            this.github.rest.packages.getAllPackageVersionsForPackageOwnedByOrg,
            {
                org: this.owner,
                package_name: this.name,
                package_type: 'container',
                per_page: 100,
            }
        );
    }

    deleteVersion(id: number) {
        return this.github.rest.packages.deletePackageVersionForOrg({
            org: this.owner,
            package_name: this.name,
            package_type: 'container',
            package_version_id: id,
        });
    }
}

async function getPackage(
    github: Octokit,
    ownerName: string,
    packageName: string
) {
    const packageTypes: Record<
        string,
        new (...args: ConstructorParameters<typeof Package>) => Package
    > = {
        User: UserPackage,
        Organization: OrgPackage,
    };

    const user = await github.rest.users.getByUsername({ username: ownerName });
    const packageType = packageTypes[user.data.type];

    if (!packageType) {
        throw new Error(
            `Owner type should be ${Object.keys(packageTypes).join(' or ')}. Got ${JSON.stringify(user.data.type)} instead`
        );
    }

    return new packageType(github, ownerName, packageName);
}

class RetentionPolicy {
    constructor(
        readonly tagPatterns: Minimatch[],
        readonly matchingTagRetentionDuration: Temporal.Duration | null,
        readonly mismatchingTagRetentionDuration: Temporal.Duration | null,
        readonly untaggedRetentionDuration: Temporal.Duration | null
    ) {}

    isMatchingTag(tag: string) {
        const match = this.tagPatterns.find(pattern => pattern.match(tag));

        return match && !match.negate;
    }

    getRetentionDuration(
        version: PackageVersion,
        relativeTo: Temporal.ZonedDateTimeLike
    ) {
        const metadata = version.metadata?.container;

        if (!metadata) {
            throw new Error('Missing container metadata');
        }

        const { tags } = metadata;

        if (tags.length === 0) {
            return this.untaggedRetentionDuration;
        }

        const matching = tags.filter(tag => this.isMatchingTag(tag));

        if (matching.length === 0) {
            return this.mismatchingTagRetentionDuration;
        }

        if (tags.length === matching.length) {
            return this.matchingTagRetentionDuration;
        }

        if (
            !this.matchingTagRetentionDuration ||
            !this.mismatchingTagRetentionDuration
        ) {
            return null;
        }

        return Temporal.Duration.compare(
            this.matchingTagRetentionDuration.negated(),
            this.mismatchingTagRetentionDuration.negated(),
            { relativeTo }
        ) === 1
            ? this.mismatchingTagRetentionDuration
            : this.matchingTagRetentionDuration;
    }
}

function parseDuration(value: string) {
    if (!value) {
        return null;
    }

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

async function processVersion(
    pkg: Package,
    version: PackageVersion,
    policy: RetentionPolicy,
    dryRun: boolean
) {
    const info = {
        name: version.name,
        url: version.url,
        html_url: version.html_url,
        updated_at: version.updated_at,
    };

    try {
        const tz = 'UTC';
        const now = Temporal.Now.zonedDateTimeISO(tz);
        const retentionDuration = policy.getRetentionDuration(version, now);
        const updated = Temporal.Instant.from(
            version.updated_at
        ).toZonedDateTimeISO(tz);

        Object.assign(info, { retentionDuration, age: updated.until(now) });

        if (
            retentionDuration &&
            Temporal.ZonedDateTime.compare(
                updated,
                now.subtract(retentionDuration)
            ) === -1
        ) {
            if (dryRun) {
                core.notice(`Would delete ${JSON.stringify(info, null, ' ')}`);
            } else {
                await pkg.deleteVersion(version.id);
                core.notice(`Deleted ${JSON.stringify(info, null, ' ')}`);
            }

            return true;
        }

        core.info(`Keeping ${JSON.stringify(info, null, ' ')}`);
    } catch (error) {
        core.error(
            `Processing ${JSON.stringify(info, null, ' ')} failed: ${inspect(error)}`
        );

        throw error;
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

    const matchingTagRetentionDuration = parseDuration(
        core.getInput('matching-tags-retention-duration', {
            required: false,
        })
    );

    const mismatchingTagRetentionDuration = parseDuration(
        core.getInput('mismatching-tags-retention-duration', {
            required: false,
        })
    );

    const untaggedRetentionDuration = parseDuration(
        core.getInput('untagged-retention-duration', {
            required: false,
        })
    );

    const minimatchOptions: MinimatchOptions = {
        platform: 'linux',
        dot: true,
        flipNegate: true,
    };

    const tagPatterns = core
        .getMultilineInput('tag-patterns', { required: false })
        .map(pattern => new Minimatch(pattern.trim(), minimatchOptions))
        .filter(pattern => !pattern.comment && !pattern.empty)
        .reverse();

    if (tagPatterns.length > 0) {
        const allNegated = !tagPatterns.some(pattern => !pattern.negate);

        if (allNegated) {
            tagPatterns.push(new Minimatch('**', minimatchOptions));
        }
    }

    const policy = new RetentionPolicy(
        tagPatterns,
        matchingTagRetentionDuration,
        mismatchingTagRetentionDuration,
        untaggedRetentionDuration
    );

    const github = getOctokit(token);
    const pkg = await getPackage(github, ownerName, packageName);
    const deleted: PackageVersion[] = [];

    try {
        for await (const response of pkg.listVersions()) {
            const results = await Promise.allSettled(
                response.data.map(version =>
                    processVersion(pkg, version, policy, dryRun).then(value => {
                        if (value) {
                            deleted.push(version);
                        }
                    })
                )
            );

            for (const result of results) {
                if (result.status === 'rejected') {
                    throw result.reason;
                }
            }
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
