export const workersCryptoCatalog = {
	ciphers: ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-ofb', 'aes-192-ofb', 'aes-256-ofb', 'des-ecb', 'des-ede', 'des-ede-cbc', 'rc2-cbc'],
	curves: ['secp224r1', 'prime256v1', 'secp384r1', 'secp521r1'],
	hashes: ['md4', 'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'md5-sha1', 'RSA-MD5', 'RSA-SHA1', 'RSA-SHA224', 'RSA-SHA256', 'RSA-SHA384', 'RSA-SHA512', 'DSA-SHA', 'DSA-SHA1', 'ecdsa-with-SHA1'],
} as const;
