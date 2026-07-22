import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(scriptDir, 'messages');

// Load all .json files from the messages directory
const allFiles = await readdir(messagesDir);
const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));

type MessageMap = Record<string, string>;

const readJson = (file: string): Promise<MessageMap> => readFile(join(messagesDir, file), 'utf-8').then((raw) => JSON.parse(raw) as MessageMap);

const writeJson = (file: string, data: MessageMap): Promise<void> => writeFile(join(messagesDir, file), JSON.stringify(data, null, '\t') + '\n', 'utf-8');

const sortKeys = (data: MessageMap): MessageMap => {
	const schema = data['$schema'];
	const sorted = Object.keys(data)
		.filter((k) => k !== '$schema')
		.sort((a, b) => a.localeCompare(b))
		.reduce<MessageMap>((acc, k) => {
			acc[k] = data[k]!;
			return acc;
		}, {});

	if (schema !== undefined) {
		return { $schema: schema, ...sorted };
	}
	return sorted;
};

// Step 1 & 2: Remove stale keys from non-en files; detect missing keys.
// Translation itself is no longer automated here (Inlang discontinued its machine-translate service) — whoever edits en.json, human or model, is expected to hand-translate the same keys directly into each other messages/<language>.json file. This script only cleans up afterward.
const en = await readJson('en.json');
const enKeys = new Set(Object.keys(en).filter((k) => k !== '$schema'));
const otherFiles = jsonFiles.filter((f) => f !== 'en.json');

const missingByFile = new Map<string, string[]>();

for (const file of otherFiles) {
	const locale = await readJson(file);

	// Remove keys not present in en.json
	for (const key of Object.keys(locale)) {
		if (key !== '$schema' && !enKeys.has(key)) {
			console.log(`[${file}] Removing stale key: ${key}`);
			delete locale[key];
		}
	}

	// Detect missing keys so they can be reported below; not auto-filled
	const missing = Array.from(enKeys).filter((key) => !(key in locale));
	if (missing.length > 0) {
		missingByFile.set(file, missing);
	}

	await writeJson(file, locale);
}

// Step 3: Sort all files alphabetically (en.json included), $schema always first
for (const file of jsonFiles) {
	const data = await readJson(file);
	await writeJson(file, sortKeys(data));
	console.log(`[${file}] Sorted keys.`);
}

if (missingByFile.size > 0) {
	console.error('\nMissing translations — add these keys by hand to each file, then rerun this script:');
	for (const [file, keys] of missingByFile) {
		console.error(`  [${file}] ${keys.join(', ')}`);
	}
	process.exitCode = 1;
} else {
	console.log('Done.');
}
