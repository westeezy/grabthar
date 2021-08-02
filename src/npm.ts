/* eslint const-immutable/no-mutation: off */
import { join } from 'path';

import { ensureDir, move, exists, readdir } from 'fs-extra';
import download from 'download';
import fetch from 'node-fetch';

import type { CacheType, LoggerType } from './types';
import {
    NPM_REGISTRY,
    CDN_REGISTRY_INFO_FILENAME,
    CDN_REGISTRY_INFO_CACHEBUST_URL_TIME,
    INFO_MEMORY_CACHE_LIFETIME
} from './config';
import { NODE_MODULES, PACKAGE, PACKAGE_JSON, LOCK } from './constants';
import {
    sanitizeString,
    cacheReadWrite,
    rmrf,
    withFileSystemLock,
    isValidDependencyVersion,
    memoizePromise,
    tryRmrf,
    getTemporaryDirectory
} from './util';

process.env.NO_UPDATE_NOTIFIER = 'true';
export type Package = {
    name: string;
    versions: Record<
        string,
        {
            dependencies: Record<string, string>;
            dist: {
                tarball: string;
            };
        }
    >;
    'dist-tags': Record<string, string>;
};

function extractInfo(moduleInfo: Package): Package {
    const { name, versions: npmVersions, 'dist-tags': distTags } = moduleInfo;
    const versions = {};

    for (const version of Object.keys(npmVersions)) {
        const versionData = npmVersions[version];
        const { dependencies, dist } = versionData;
        const { tarball } = dist;
        (versions as Record<string, any>)[version] = {
            dependencies,
            dist: {
                tarball
            }
        };
    }

    return {
        name,
        versions,
        'dist-tags': distTags
    };
}

type InfoOptions = {
    cache: CacheType | null | undefined;
    logger: LoggerType;
    registry: string;
    cdnRegistry: string | null | undefined;
};
type InfoResults = {
    moduleInfo: Package;
    fetchedFromCDNRegistry: boolean;
};
export const info = memoizePromise(
    async (moduleName: string, opts: InfoOptions): Promise<InfoResults> => {
        const { logger, cache, registry = NPM_REGISTRY, cdnRegistry } = opts;
        const sanitizedName = sanitizeString(moduleName);
        const sanitizedCDNRegistry = sanitizeString(cdnRegistry || 'npm');
        const cacheKey = `grabthar_npm_info_${ sanitizedName }_${ sanitizedCDNRegistry }`;
        const {
            name,
            versions,
            fetchedFromCDNRegistry,
            'dist-tags': distTags
        } = await cacheReadWrite(
            cacheKey,
            async () => {
                let res;
                let isFromCDNRegistry = false;

                if (cdnRegistry) {
                    res = await fetch(
                        `${ cdnRegistry }/${ moduleName.replace(
                            '@',
                            ''
                        ) }/${ CDN_REGISTRY_INFO_FILENAME }?cache-bust=${ Math.floor(
                            Date.now() / CDN_REGISTRY_INFO_CACHEBUST_URL_TIME
                        ) }`
                    );

                    if (res.ok) {
                        isFromCDNRegistry = true;
                    } else {
                        logger.warn(`grabthar_cdn_registry_failure`, {
                            cdnRegistry,
                            moduleName,
                            status: res.status
                        });
                        res = null;
                    }
                }

                if (!res) {
                    res = await fetch(`${ registry }/${ moduleName }`);
                }

                if (!res.ok) {
                    throw new Error(
                        `npm returned status ${
                            res.status || 'unknown'
                        } for ${ registry }/${ moduleName }`
                    );
                }

                const infoResults = extractInfo(await res.json());
                return {
                    ...infoResults,
                    fetchedFromCDNRegistry: isFromCDNRegistry
                };
            },
            {
                logger,
                cache
            }
        );
        return {
            moduleInfo: {
                name,
                versions,
                'dist-tags': distTags
            },
            fetchedFromCDNRegistry
        };
    },
    {
        lifetime: INFO_MEMORY_CACHE_LIFETIME
    }
);
type InstallOptions = {
    logger: LoggerType;
    cache?: CacheType | null | undefined;
    dependencies?: boolean;
    registry: string;
    cdnRegistry: string | null | undefined;
    prefix: string;
    childModules: ReadonlyArray<string> | null | undefined;
};
export const installSingle = memoizePromise(
    async (
        moduleName: string,
        version: string,
        opts: InstallOptions
    ): Promise<void> => {
        if (!isValidDependencyVersion(version)) {
            throw new Error(
                `Invalid version for single install: ${ moduleName }@${ version }`
            );
        }

        const {
            cache,
            logger,
            registry = NPM_REGISTRY,
            cdnRegistry,
            prefix
        } = opts;
        const { moduleInfo, fetchedFromCDNRegistry } = await info(moduleName, {
            cache,
            logger,
            registry,
            cdnRegistry
        });
        const versionInfo = moduleInfo.versions[version];

        if (!versionInfo) {
            throw new Error(
                `No version found for ${ moduleName } @ ${ version } - found ${ Object.keys(
                    moduleInfo.versions
                ).join(', ') }`
            );
        }

        if (!prefix) {
            throw new Error(`Prefix required for flat install`);
        }

        const initialTarball = versionInfo.dist.tarball;

        if (!initialTarball) {
            throw new Error(`Can not find tarball for ${ moduleInfo.name }`);
        }

        const nodeModulesDir = join(prefix, NODE_MODULES);
        const packageName = `${ PACKAGE }.tar.gz`;
        let tarball = initialTarball;

        if (
            cdnRegistry &&
            fetchedFromCDNRegistry &&
            !tarball.includes(cdnRegistry)
        ) {
            try {
                const initialTarballPathname = new URL(tarball).pathname;
                const newTarballOrigin = new URL(cdnRegistry).origin;
                tarball = new URL(
                    initialTarballPathname,
                    newTarballOrigin
                ).toString();
            } catch (err) {
                throw new Error(
                    `Failed to parse tarball url ${ tarball }\n\n${ err.stack }`
                );
            }

            logger.info(
                `grabthar_npm_install_dependency_update_tarball_location`,
                {
                    cdnRegistry,
                    initialTarball,
                    newTarball: tarball
                }
            );
        }

        const tmpDir = await getTemporaryDirectory(moduleName);
        const packageDir = join(tmpDir, PACKAGE);
        const moduleDir = join(nodeModulesDir, moduleInfo.name);
        const modulePackageDir = join(moduleDir, PACKAGE_JSON);
        const moduleParentDir = join(moduleDir, '..');

        // TODO: exists is deprecated. This will be an issue for tsc so we should update this to use fs.stat or fs.access
        // @ts-ignore - fs-extra types are incorrect for pify'ed exists
        if (await exists(modulePackageDir)) {
            return;
        }

        await withFileSystemLock(async () => {
            await ensureDir(tmpDir);
            await ensureDir(prefix);
            await ensureDir(nodeModulesDir);
            await ensureDir(moduleParentDir);

            // TODO: exists is deprecated. This will be an issue for tsc so we should update this to use fs.stat or fs.access
            // @ts-ignore - fs-extra types are incorrect for pify'ed exists
            if (await exists(moduleDir)) {
                for (const file of await readdir(moduleDir)) {
                    if (file === LOCK) {
                        continue;
                    }

                    await rmrf(join(moduleDir, file));
                }
            }

            await ensureDir(moduleDir);

            try {
                await download(tarball, tmpDir, {
                    extract: true,
                    filename:packageName
                });
                await move(packageDir, moduleDir, {
                    overwrite: true
                });

                // TODO: exists is deprecated and technically is void return type. This will be an issue for tsc so we should update this to use fs.stat or fs.access
                // @ts-ignore
                if (!(await exists(modulePackageDir))) {
                    throw new Error(`Package not found at ${ modulePackageDir }`);
                }
            } catch (err) {
                await rmrf(moduleDir);
                throw new Error(
                    `Failed to download ${ tarball }\n\n${ err.stack }`
                );
            }

            await tryRmrf(tmpDir);
        }, moduleDir);
    }
);
export const install = async (
    moduleName: string,
    version: string,
    opts: InstallOptions
): Promise<void> => {
    return await withFileSystemLock(async () => {
        const {
            cache,
            logger,
            dependencies = false,
            registry = NPM_REGISTRY,
            cdnRegistry,
            childModules
        } = opts;
        const sanitizedName = sanitizeString(moduleName);
        const tasks = [];

        if (dependencies) {
            const { moduleInfo } = await info(moduleName, {
                cache,
                logger,
                registry,
                cdnRegistry
            });
            const dependencyVersions =
                moduleInfo.versions[version].dependencies;
            logger.info(`grabthar_npm_install_dependencies_${ sanitizedName }`, {
                version,
                registry,
                dependencies: Object.keys(dependencyVersions).join(',')
            });

            for (const dependencyName of Object.keys(dependencyVersions)) {
                const dependencyVersion = dependencyVersions[dependencyName];

                if (!isValidDependencyVersion(dependencyVersion)) {
                    throw new Error(
                        `Invalid dependency version for flat single install: ${ dependencyName }@${ dependencyVersion }`
                    );
                }
            }

            for (const dependencyName of Object.keys(dependencyVersions)) {
                if (
                    childModules &&
                    childModules.indexOf(dependencyName) === -1
                ) {
                    continue;
                }

                const dependencyVersion = dependencyVersions[dependencyName];
                tasks.push(
                    installSingle(dependencyName, dependencyVersion, opts)
                );
            }
        }

        logger.info(`grabthar_npm_install_${ sanitizedName }`, {
            version,
            registry
        });
        tasks.push(installSingle(moduleName, version, opts));

        try {
            await Promise.all(tasks);
        } catch (err) {
            logger.error(`grabthar_npm_install_${ sanitizedName }_error`, {
                err: err.stack || err.toString()
            });
            throw err;
        }
    });
};
export function clearCache(): void {
    cacheReadWrite.clear();
}
