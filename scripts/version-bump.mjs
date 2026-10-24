#!/usr/bin/env node
/**
 * Runs from `npm version <x.y.z>`: copies the new version into manifest.json
 * and records which Obsidian version it needs in versions.json, as Obsidian's
 * plugin directory expects. `.npmrc` keeps tags bare ("0.3.0", not "v0.3.0").
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
if (!version) {
  console.error('Run this through `npm version <x.y.z>`.');
  process.exit(1);
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const manifest = readJson('manifest.json');
manifest.version = version;
writeJson('manifest.json', manifest);

const versions = readJson('versions.json');
versions[version] = manifest.minAppVersion;
writeJson('versions.json', versions);
