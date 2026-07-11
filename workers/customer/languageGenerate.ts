import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

// Step 1 & 2: Remove stale keys from non-en files; detect missing keys
const en = await readJson('en.json');
const enKeys = new Set(Object.keys(en).filter((k) => k !== '$schema'));
const otherFiles = jsonFiles.filter((f) => f !== 'en.json');

let needsTranslation = false;

for (const file of otherFiles) {
	const locale = await readJson(file);

	// Remove keys not present in en.json
	for (const key of Object.keys(locale)) {
		if (key !== '$schema' && !enKeys.has(key)) {
			console.log(`[${file}] Removing stale key: ${key}`);
			delete locale[key];
		}
	}

	// Check for missing keys
	for (const key of enKeys) {
		if (!(key in locale)) {
			console.log(`[${file}] Missing key: ${key}`);
			needsTranslation = true;
		}
	}

	await writeJson(file, locale);
}

// Step 3: Run translate if any locale is missing keys relative to en.json
if (needsTranslation) {
	console.log('Running translation for missing keys...');
	const { stdout, stderr } = await execFileAsync('npm', ['--workspace', 'customer', 'run', 'translate'], {
		cwd: resolve(scriptDir, '..', '..'),
		shell: true,
	});
	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);
}

// Step 4: Sort all files alphabetically (en.json included), $schema always first
for (const file of jsonFiles) {
	const data = await readJson(file);
	await writeJson(file, sortKeys(data));
	console.log(`[${file}] Sorted keys.`);
}

console.log('Done.');
