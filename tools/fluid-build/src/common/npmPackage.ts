/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { queue } from "async";
import * as chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import sortPackageJson from "sort-package-json";
import { logStatus, logVerbose } from "./logging";
import {
    copyFileAsync,
    execWithErrorAsync,
    rimrafWithErrorAsync,
    unlinkAsync,
    writeFileAsync,
    ExecAsyncResult,
} from "./utils"

import { options } from "../fluidBuild/options";

interface IPerson {
    name: string;
    email: string;
    url: string;
}

interface IPackage {
    name: string;
    version: string;
    description: string;
    keywords: string[];
    homepage: string;
    bugs: { url: string; email: string };
    license: string;
    author: IPerson;
    contributors: IPerson[];
    files: string[];
    main: string;
    // Same as main but for browser based clients (check if webpack supports this)
    browser: string;
    bin: { [key: string]: string };
    man: string | string[];
    repository: string | { type: string; url: string };
    scripts: { [key: string]: string | undefined };
    config: { [key: string]: string };
    dependencies: { [key: string]: string };
    devDependencies: { [key: string]: string };
    peerDependencies: { [key: string]: string };
    bundledDependencies: { [key: string]: string };
    optionalDependencies: { [key: string]: string };
    engines: { node: string; npm: string };
    os: string[];
    cpu: string[];
    [key: string]: any;
};

export class Package {
    private static packageCount: number = 0;
    private static readonly chalkColor = [
        chalk.default.red,
        chalk.default.green,
        chalk.default.yellow,
        chalk.default.blue,
        chalk.default.magenta,
        chalk.default.cyan,
        chalk.default.white,
        chalk.default.grey,
        chalk.default.redBright,
        chalk.default.greenBright,
        chalk.default.yellowBright,
        chalk.default.blueBright,
        chalk.default.magentaBright,
        chalk.default.cyanBright,
        chalk.default.whiteBright,
    ];

    public readonly packageJson: Readonly<IPackage>;
    private readonly packageId = Package.packageCount++;
    private _matched: boolean = false;
    private _markForBuild: boolean = false;

    constructor(private readonly packageJsonFileName: string) {
        this.packageJson = require(packageJsonFileName);
        logVerbose(`Package Loaded: ${this.nameColored}`);
    }

    public get name(): string {
        return this.packageJson.name;
    }

    public get nameColored(): string {
        return this.color(this.name);
    }

    public get version(): string {
        return this.packageJson.version;
    }

    public get matched() {
        return this._matched;
    }

    public setMatched() {
        this._matched = true;
        this._markForBuild = true;
    }

    public get markForBuild() {
        return this._markForBuild;
    }

    public setMarkForBuild() {
        this._markForBuild = true;
    }

    public get dependencies() {
        return this.packageJson.dependencies ? Object.keys(this.packageJson.dependencies) : [];
    }

    public get combinedDependencies() {
        const it = function* (packageJson: IPackage) {
            for (const item in packageJson.dependencies) {
                yield ({ name: item, version: packageJson.dependencies[item] });
            }
            for (const item in packageJson.devDependencies) {
                yield ({ name: item, version: packageJson.devDependencies[item] });
            }
        }
        return it(this.packageJson);
    }

    public get directory(): string {
        return path.dirname(this.packageJsonFileName);
    }

    private get color() {
        return Package.chalkColor[this.packageId % Package.chalkColor.length];
    }

    public getScript(name: string): string | undefined {
        return this.packageJson.scripts[name];
    }

    public async cleanNodeModules() {
        return rimrafWithErrorAsync(path.join(this.directory, "node_modules"), this.nameColored);
    }

    public async savePackageJson() {
        return writeFileAsync(this.packageJsonFileName, `${JSON.stringify(sortPackageJson(this.packageJson), undefined, 2)}\n`);
    }

    public async noHoistInstall(repoRoot: string) {
        // Fluid specific
        const rootNpmRC = path.join(repoRoot, ".npmrc")
        const npmRC = path.join(this.directory, ".npmrc");
        const npmCommand = "npm i --no-package-lock --no-shrinkwrap";

        await copyFileAsync(rootNpmRC, npmRC);
        const result = await execWithErrorAsync(npmCommand, { cwd: this.directory }, this.nameColored);
        await unlinkAsync(npmRC);

        return result;
    }
};

interface TaskExec<TItem, TResult> {
    item: TItem;
    resolve: (result: TResult) => void;
    reject: (reason?: any) => void;
};

async function queueExec<TItem, TResult>(items: Iterable<TItem>, exec: (item: TItem) => Promise<TResult>, messageCallback?: (item: TItem) => string) {
    let numDone = 0;
    const timedExec = messageCallback ? async (item: TItem) => {
        const startTime = Date.now();
        const result = await exec(item);
        const elapsedTime = (Date.now() - startTime) / 1000;
        logStatus(`[${++numDone}/${p.length}] ${messageCallback(item)} - ${elapsedTime.toFixed(3)}s`);
        return result;
    } : exec;
    const q = queue(async (taskExec: TaskExec<TItem, TResult>, callback) => {
        try {
            taskExec.resolve(await timedExec(taskExec.item));
        } catch (e) {
            taskExec.reject(e);
        }
        callback();
    }, options.concurrency);
    const p: Promise<TResult>[] = [];
    for (const item of items) {
        p.push(new Promise<TResult>((resolve, reject) => q.push({ item, resolve, reject })));
    }
    return Promise.all(p);
}

export class Packages {

    public static load(dirs: string[]) {
        const packages: Package[] = [];
        for (const dir of dirs) {
            packages.push(...Packages.loadCore(dir));
        }
        return new Packages(packages);
    }

    private static loadCore(dir: string) {
        const packages: Package[] = [];
        const files = fs.readdirSync(dir, { withFileTypes: true });
        files.map((dirent) => {
            if (dirent.isDirectory()) {
                if (dirent.name !== "node_modules") {
                    packages.push(...Packages.loadCore(path.join(dir, dirent.name)));
                }
                return;
            }
            if (dirent.isFile() && dirent.name === "package.json") {
                const packageJsonFileName = path.join(dir, "package.json");
                packages.push(new Package(packageJsonFileName))
            }
        });
        return packages;
    }

    private constructor(public readonly packages: Package[]) {
    }

    public async cleanNodeModules() {
        return this.queueExecOnAllPackage(pkg => pkg.cleanNodeModules(), "rimraf node_modules");
    }

    public async noHoistInstall(repoRoot: string) {
        return this.queueExecOnAllPackage(pkg => pkg.noHoistInstall(repoRoot), "npm i");
    }

    public async forEachAsync<TResult>(exec: (pkg: Package) => Promise<TResult>, parallel: boolean, message?: string) {
        if (parallel) { return this.queueExecOnAllPackageCore(exec, message) };

        const results: TResult[] = [];
        for (const pkg of this.packages) {
            results.push(await exec(pkg));
        }
        return results;
    }

    public static async clean(packages: Package[], status: boolean) {
        const cleanP: Promise<ExecAsyncResult>[] = [];
        let numDone = 0;
        const execCleanScript = async (pkg: Package, cleanScript: string) => {
            const startTime = Date.now();
            const result = await execWithErrorAsync(cleanScript, {
                cwd: pkg.directory,
                env: { PATH: `${process.env["PATH"]}${path.delimiter}${path.join(pkg.directory, "node_modules", ".bin")}` }
            }, pkg.nameColored);

            if (status) {
                const elapsedTime = (Date.now() - startTime) / 1000;
                logStatus(`[${++numDone}/${cleanP.length}] ${pkg.nameColored}: ${cleanScript} - ${elapsedTime.toFixed(3)}s`);
            }
            return result;
        };
        for (const pkg of packages) {
            const cleanScript = pkg.getScript("clean");
            if (cleanScript) {
                cleanP.push(execCleanScript(pkg, cleanScript));
            }
        };
        const results = await Promise.all(cleanP);
        return !results.some(result => result.error);
    }

    private async queueExecOnAllPackageCore<TResult>(exec: (pkg: Package) => Promise<TResult>, message?: string) {
        const messageCallback = message ? (pkg: Package) => ` ${pkg.nameColored}: ${message}` : undefined;
        return queueExec(this.packages, exec, messageCallback);
    }

    private async queueExecOnAllPackage(exec: (pkg: Package) => Promise<ExecAsyncResult>, message?: string) {
        const results = await this.queueExecOnAllPackageCore(exec, message);
        return !results.some(result => result.error);
    }
}
