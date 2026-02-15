import { inspect } from 'node:util';

import * as core from '@actions/core';
import { Headers, HttpClient } from '@actions/http-client';
import { BearerCredentialHandler } from '@actions/http-client/lib/auth';
import { type RequestHandler } from '@actions/http-client/lib/interfaces';
import { getOctokit, type GitHub } from '@amezin/js-actions-octokit';
import { type RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { type OctokitResponse } from '@octokit/types';
import { Minimatch, type MinimatchOptions } from 'minimatch';
import { Temporal } from '@js-temporal/polyfill';

type PackageVersion =
    RestEndpointMethodTypes['packages']['getPackageVersionForAuthenticatedUser']['response']['data'];

abstract class Package {
    constructor(
        readonly github: GitHub,
        readonly owner: string,
        readonly name: string
    ) {}

    abstract listVersions(): AsyncIterable<OctokitResponse<PackageVersion[]>>;

    abstract deleteVersion(id: number): Promise<OctokitResponse<never>>;

    async getAllVersions(): Promise<PackageVersion[]> {
        const versions: PackageVersion[] = [];

        for await (const response of this.listVersions()) {
            versions.push(...response.data);
        }

        return versions;
    }

    async getAllVersionsStable(): Promise<PackageVersion[]> {
        const a = await this.getAllVersions();
        const b = await this.getAllVersions();

        if (
            a.length === b.length &&
            a.every((value, index) => value.id === b[index]?.id)
        ) {
            return b;
        }

        throw new Error(
            'Possible concurrent modification detected, pagination results may be incorrect'
        );
    }
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
    github: GitHub,
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
    readonly now: Temporal.ZonedDateTime;
    readonly matchingTagRetentionDeadline: Temporal.Instant | null;
    readonly mismatchingTagRetentionDeadline: Temporal.Instant | null;
    readonly untaggedRetentionDeadline: Temporal.Instant | null;

    constructor(
        readonly tagPatterns: Minimatch[],
        readonly matchingTagRetentionDuration: Temporal.Duration | null,
        readonly mismatchingTagRetentionDuration: Temporal.Duration | null,
        readonly untaggedRetentionDuration: Temporal.Duration | null
    ) {
        this.now = Temporal.Now.zonedDateTimeISO();

        this.matchingTagRetentionDeadline = matchingTagRetentionDuration
            ? this.now.subtract(matchingTagRetentionDuration).toInstant()
            : null;

        this.mismatchingTagRetentionDeadline = mismatchingTagRetentionDuration
            ? this.now.subtract(mismatchingTagRetentionDuration).toInstant()
            : null;

        this.untaggedRetentionDeadline = untaggedRetentionDuration
            ? this.now.subtract(untaggedRetentionDuration).toInstant()
            : null;
    }

    isMatchingTag(tag: string) {
        const match = this.tagPatterns.find(pattern => pattern.match(tag));

        return match && !match.negate;
    }

    getRetentionDeadline(version: PackageVersion) {
        const metadata = version.metadata?.container;

        if (!metadata) {
            throw new Error('Missing container metadata');
        }

        const { tags } = metadata;

        if (tags.length === 0) {
            return this.untaggedRetentionDeadline;
        }

        const matching = tags.filter(tag => this.isMatchingTag(tag));

        if (matching.length === 0) {
            return this.mismatchingTagRetentionDeadline;
        }

        if (tags.length === matching.length) {
            return this.matchingTagRetentionDeadline;
        }

        if (
            !this.matchingTagRetentionDeadline ||
            !this.mismatchingTagRetentionDeadline
        ) {
            return null;
        }

        return Temporal.Instant.compare(
            this.matchingTagRetentionDeadline,
            this.mismatchingTagRetentionDeadline
        ) === -1
            ? this.matchingTagRetentionDeadline
            : this.mismatchingTagRetentionDeadline;
    }

    isOutdated(version: PackageVersion) {
        const deadline = this.getRetentionDeadline(version);

        if (!deadline) {
            return false;
        }

        const updated = Temporal.Instant.from(version.updated_at);

        return Temporal.Instant.compare(updated, deadline) === -1;
    }
}

const indexTypes = [
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.index.v1+json',
];

const manifestTypes = [
    ...indexTypes,
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
];

type Descriptor = {
    mediaType?: string;
    digest?: string;
};

type Manifest = {
    mediaType?: string;
    manifests?: Descriptor[];
};

class DockerRepository {
    readonly auth: RequestHandler;
    readonly client: HttpClient;

    constructor(
        readonly token: string,
        readonly namespace: string,
        readonly repository: string
    ) {
        this.auth = new BearerCredentialHandler(
            Buffer.from(token).toString('base64')
        );
        this.client = new HttpClient(undefined, [this.auth], {
            keepAlive: true,
            allowRetries: true,
            maxRetries: 5,
        });
    }

    async fetchManifest(reference: string): Promise<Manifest> {
        const url = `https://ghcr.io/v2/${this.namespace}/${this.repository}/manifests/${reference}`;
        const headers = { [Headers.Accept]: manifestTypes };
        const response = await this.client.getJson<Manifest>(url, headers);
        const { result } = response;

        if (!result) {
            throw new Error(`Manifest not found: ${JSON.stringify(url)}`);
        }

        const { mediaType } = result;

        if (!mediaType || !manifestTypes.includes(mediaType)) {
            throw new Error(`Unknown mediaType: ${JSON.stringify(mediaType)}`);
        }

        return result;
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

    core.info(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Deleting images with matching tags not updated after ${policy.matchingTagRetentionDeadline}`
    );
    core.info(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Deleting images with mismatching tags not updated after ${policy.mismatchingTagRetentionDeadline}`
    );
    core.info(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Deleting untagged images not updated after ${policy.untaggedRetentionDuration}`
    );

    const github = getOctokit(token);
    const pkg = await getPackage(github, ownerName, packageName);
    const docker = new DockerRepository(token, ownerName, packageName);

    const versions = new Map<string, PackageVersion>();
    const manifests = new Map<string, Manifest>();
    const retained = new Set<string>();

    for (const version of await pkg.getAllVersionsStable()) {
        const { name } = version;

        if (versions.has(name)) {
            throw new Error(`Duplicate name: ${JSON.stringify(name)}`);
        }

        versions.set(name, version);
        manifests.set(name, await docker.fetchManifest(name));
    }

    function retain(name: string) {
        if (retained.has(name)) {
            return;
        }

        const manifest = manifests.get(name);

        if (!manifest) {
            throw new Error(`Missing manifest: ${name}`);
        }

        retained.add(name);

        const { mediaType } = manifest;

        if (mediaType && indexTypes.includes(mediaType)) {
            const childManifests = manifest.manifests ?? [];

            for (const childManifestDescriptor of childManifests) {
                const { digest } = childManifestDescriptor;

                if (!digest) {
                    throw new Error(
                        `Missing digest in descriptor of child manifest of ${name}`
                    );
                }

                retain(digest);
            }
        }
    }

    for (const [name, version] of versions.entries()) {
        if (!policy.isOutdated(version)) {
            retain(name);
        }
    }

    const deleted: PackageVersion[] = [];

    try {
        for (const [name, version] of versions.entries()) {
            if (retained.has(name)) {
                continue;
            }

            if (!dryRun) {
                await pkg.deleteVersion(version.id);
            }

            deleted.push(version);
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
