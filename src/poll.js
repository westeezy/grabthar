/* @flow */

import { join } from 'path';

import compareVersions from 'compare-versions';
import { readFile } from 'fs-extra';

import { install, installFlat, type NpmOptionsType, info, type Package } from './npm';
import { poll, createHomeDirectory, memoize, resolveNodeModulesDirectory } from './util';
import { MODULE_ROOT_NAME, NPM_POLL_INTERVAL } from './config';
import { DIST_TAG, NODE_MODULES, STABILITY, PACKAGE_JSON, DIST_TAGS } from './constants';

type InstallResult = {|
    nodeModulesPath : string,
    modulePath : string,
    dependencies : {
        [string] : {
            version : string,
            path : string
        }
    }
|};

function cleanName(name : string) : string {
    return name.replace(/\//g, '-');
}

async function installVersion({ moduleInfo, version, flat = false, npmOptions = {} } : { moduleInfo : Package, version : string, flat? : boolean, npmOptions : NpmOptionsType }) : Promise<InstallResult> {
    let newRoot = await createHomeDirectory(MODULE_ROOT_NAME, `${ cleanName(moduleInfo.name) }_${ version }`);

    if (flat) {
        await installFlat(moduleInfo, version, { ...npmOptions, prefix: newRoot });
    } else {
        await install(moduleInfo.name, version, { ...npmOptions, prefix: newRoot });
    }
    
    let nodeModulesPath = join(newRoot, NODE_MODULES);
    let modulePath = join(nodeModulesPath, moduleInfo.name);
    let dependencies = {};

    let versionInfo = moduleInfo.versions[version];

    for (let dependencyName of Object.keys(versionInfo.dependencies)) {
        dependencies[dependencyName] = {
            version: versionInfo.dependencies[dependencyName],
            path:    join(nodeModulesPath, dependencyName)
        };
    }

    return {
        nodeModulesPath,
        modulePath,
        dependencies
    };
}

type ModuleDetails = {
    nodeModulesPath : string,
    modulePath : string,
    version : string,
    dependencies : {
        [string] : {
            version : string,
            path : string
        }
    }
};

type DistPoller = {
    result : () => Promise<ModuleDetails>,
    stop : () => void,
    markStable : (string) => void,
    markUnstable : (string) => void
};

function getMajorVersion(version : string) : string {
    return version.split('.')[0];
}

function pollInstallDistTag({ name, onError, tag, period = 20, flat = false, npmOptions = {} } :
    { name : string, tag : string, onError : ?(Error) => void, period? : number, flat? : boolean, npmOptions : NpmOptionsType }) : DistPoller {
    
    let stability : { [string] : string } = {};

    let installedModule;

    let poller = poll({
        handler: async () => {
            const moduleInfo = await info(name, npmOptions.registry);

            let distTagVersion = moduleInfo[DIST_TAGS][tag];
            const moduleVersions = Object.keys(moduleInfo.versions)
                .filter(ver => ver.match(/^\d+\.\d+\.\d+$/))
                .sort(compareVersions)
                .reverse();

            stability[distTagVersion] = stability[distTagVersion] || STABILITY.STABLE;
            let majorVersion = getMajorVersion(distTagVersion);

            let eligibleVersions = moduleVersions.filter(ver => {

                // Do not allow versions that are not the major version of the dist-tag
                if (getMajorVersion(ver) !== majorVersion) {
                    return false;
                }

                // Do not allow versions ahead of the current dist-tag
                if (compareVersions(ver, distTagVersion) === 1) {
                    return false;
                }

                // Do not allow versions marked as unstable
                if (stability[ver] === STABILITY.UNSTABLE) {
                    return false;
                }

                return true;
            });

            if (!eligibleVersions.length) {
                throw new Error(`No eligible versions found for module ${ name } -- from [ ${ moduleVersions.join(', ') } ]`);
            }


            let stableVersions = eligibleVersions.filter(ver => {

                if (stability[ver] !== STABILITY.STABLE) {
                    return false;
                }

                return true;
            });

            let previousVersion = stableVersions.length ? stableVersions[0] : eligibleVersions[0];

            if (stability[distTagVersion] === STABILITY.UNSTABLE) {
                distTagVersion = previousVersion;
            }

            if (!installedModule || installedModule.version !== distTagVersion) {
                const version = distTagVersion;
                const { nodeModulesPath, modulePath, dependencies } = await installVersion({ moduleInfo, version, flat, npmOptions });

                installedModule = {
                    nodeModulesPath,
                    modulePath,
                    version,
                    previousVersion,
                    dependencies
                };
            }

            return installedModule;
        },
        period: period * 1000,
        onError
    }).start();

    return {
        stop:       () => { poller.stop(); },
        result:     async () => await poller.result(),
        markStable: (version : string) => {
            stability[version] = STABILITY.STABLE;
        },
        markUnstable: (version : string) => {
            stability[version] = STABILITY.UNSTABLE;
        }
    };
}

type NpmWatcher<T : Object> = {
    get : (tag? : string) => Promise<ModuleDetails>,
    import : (?string) => Promise<T>,
    cancel : () => void,
    markStable : (string) => void,
    markUnstable : (string) => void
};

type NPMPollOptions = {
    name : string,
    tags? : Array<string>,
    onError? : (Error) => void,
    period? : number,
    npmOptions? : NpmOptionsType,
    flat? : boolean,
    fallback? : boolean
};

export function getFallback(name : string) : ModuleDetails {

    const nodeModulesPath = resolveNodeModulesDirectory(name);

    if (!nodeModulesPath) {
        throw new Error(`Can not find node modules path for fallback for ${ name }`);
    }

    const modulePath = join(nodeModulesPath, name);
    // $FlowFixMe
    const pkg = require(join(modulePath, PACKAGE_JSON)); // eslint-disable-line security/detect-non-literal-require
    const version = pkg.version;
    let dependencies = {};

    for (const dependencyName of Object.keys(pkg.dependencies || {})) {
        const dependencyPath = join(nodeModulesPath, dependencyName);
        // $FlowFixMe
        const dependencyPkg = require(join(dependencyPath, PACKAGE_JSON)); // eslint-disable-line security/detect-non-literal-require

        dependencies[dependencyName] = {
            version: dependencyPkg.version,
            path:    dependencyPath
        };
    }

    return {
        nodeModulesPath,
        modulePath,
        version,
        dependencies
    };
}

export function npmPoll({ name, tags = [ DIST_TAG.LATEST ], onError, period = NPM_POLL_INTERVAL, flat = false, npmOptions = {}, fallback = true } : NPMPollOptions) : NpmWatcher<Object> {

    let pollers = {};

    for (let tag of tags) {
        pollers[tag] = pollInstallDistTag({ name, tag, onError, period, flat, npmOptions });
    }

    async function pollerGet(tag? : string) : Promise<ModuleDetails> {
        if (tag && !pollers[tag]) {
            throw new Error(`Invalid tag: ${ tag }`);
        }

        if (!tag) {
            if (tags.length === 1) {
                tag = tags[0];
            } else if (pollers[DIST_TAG.LATEST]) {
                tag = DIST_TAG.LATEST;
            } else {
                throw new Error(`Please specify tag: one of ${ tags.join(', ') }`);
            }
        }

        const poller = pollers[tag || DIST_TAG.LATEST];

        try {
            return await poller.result();
        } catch (err) {
            if (fallback && resolveNodeModulesDirectory(name)) {
                return getFallback(name);
            }

            throw err;
        }
    }

    async function pollerImport <T : Object>(path = '') : T {
        let { modulePath } = await pollerGet();
        // $FlowFixMe
        return require(join(modulePath, path)); // eslint-disable-line security/detect-non-literal-require
    }

    async function pollerRead(path? : string = '') : Promise<string> {
        const { modulePath } = await pollerGet();
        const filePath = join(modulePath, path);
        const file = await readFile(filePath);
        return file;
    }

    function pollerCancel() {
        for (let tag of tags) {
            pollers[tag].stop();
        }
    }

    function pollerMarkStable(version : string) {
        for (let tag of tags) {
            pollers[tag].markStable(version);
        }
    }

    function pollerMarkUnstable(version : string) {
        for (let tag of tags) {
            pollers[tag].markUnstable(version);
        }
    }

    return {
        get:          pollerGet,
        import:       pollerImport,
        read:         pollerRead,
        cancel:       pollerCancel,
        markStable:   pollerMarkStable,
        markUnstable: pollerMarkUnstable
    };
}

npmPoll.flushCache = () => {
    memoize.clear();
};
