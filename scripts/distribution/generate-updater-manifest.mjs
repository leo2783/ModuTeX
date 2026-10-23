import fs from 'node:fs';
import path from 'node:path';

const allowedFlags = new Set([
	'version',
	'tag',
	'repo',
	'installer-name',
	'signature-file',
	'output',
	'notes',
	'pub-date'
]);

const requiredFlags = [
	'version',
	'tag',
	'repo',
	'installer-name',
	'signature-file',
	'output'
];

const seen = new Set();
const options = {};

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (!arg.startsWith('--')) {
		console.error(`Unexpected positional argument: "${arg}"`);
		process.exit(1);
	}
	const key = arg.slice(2);
	if (!allowedFlags.has(key)) {
		console.error(`Unknown option: "--${key}"`);
		process.exit(1);
	}
	if (seen.has(key)) {
		console.error(`Duplicate option: "--${key}"`);
		process.exit(1);
	}
	seen.add(key);

	const val = args[i + 1];
	if (val === undefined || val.startsWith('--')) {
		console.error(`Missing value for option: "--${key}"`);
		process.exit(1);
	}
	options[key] = val;
	i++;
}

for (const req of requiredFlags) {
	if (!options[req]) {
		console.error(`Missing required option: "--${req}"`);
		process.exit(1);
	}
}

const version = options.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
	console.error(`Version must be strict stable SemVer without prerelease: "${version}"`);
	process.exit(1);
}

const tag = options.tag;
if (tag !== `v${version}`) {
	console.error(`Tag must strictly match "v${version}", got "${tag}"`);
	process.exit(1);
}

const repo = options.repo;
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
	console.error(`Invalid repository format: "${repo}"`);
	process.exit(1);
}

const installerName = options['installer-name'];
if (!/^[a-zA-Z0-9_.-]+\.exe$/.test(installerName)) {
	console.error(`Invalid installer name: "${installerName}"`);
	process.exit(1);
}

let pubDate = options['pub-date'];
if (pubDate) {
	const parsed = new Date(pubDate);
	if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(pubDate)) {
		console.error(`Invalid RFC3339 publication date: "${pubDate}"`);
		process.exit(1);
	}
} else {
	pubDate = new Date().toISOString();
}

const sigPath = path.resolve(process.cwd(), options['signature-file']);
if (!fs.existsSync(sigPath)) {
	console.error(`Signature file not found: "${sigPath}"`);
	process.exit(1);
}

const sigStat = fs.statSync(sigPath);
if (!sigStat.isFile()) {
	console.error(`Signature path is not a file: "${sigPath}"`);
	process.exit(1);
}

if (sigStat.size === 0 || sigStat.size > 16384) {
	console.error(`Signature file size out of bounds (1..16384 bytes): ${sigStat.size} bytes`);
	process.exit(1);
}

const signature = fs.readFileSync(sigPath, 'utf8').trim();
if (!signature) {
	console.error('Signature file is empty');
	process.exit(1);
}

const outputPath = path.resolve(process.cwd(), options.output);
if (outputPath === sigPath) {
	console.error('Output path must not overwrite signature file');
	process.exit(1);
}

if (path.basename(outputPath) === installerName) {
	console.error('Output path must not overwrite installer file');
	process.exit(1);
}

const url = `https://github.com/${repo}/releases/download/${tag}/${installerName}`;
const notes = options.notes ?? `Official ModuTeX desktop release ${tag}`;

const manifest = {
	version,
	notes,
	pub_date: pubDate,
	platforms: {
		'windows-x86_64': {
			url,
			signature
		}
	}
};

const outputDir = path.dirname(outputPath);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, '\t') + '\n', { flag: 'wx' });

console.log(`Generated updater manifest at ${outputPath}`);
