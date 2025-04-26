import { getCiphers, getCurves, getHashes } from 'node:crypto';

console.log({
	// ciphers: Array.from(new Set(getCiphers().map(cipher => cipher.replace(/\-?(128|192|256)/, "")))),
	ciphers: getCiphers(),
	curves: getCurves(),
	hashes: getHashes(),
});
