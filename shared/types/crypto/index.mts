export enum KeyAlgorithms {
	'RSASSA-PKCS1-v1_5' = 'rsassa-pkcs1-v1_5',
	'RSA-PSS' = 'rsa-pss',
	'RSA-OAEP' = 'rsa-oaep',
	ECDSA = 'ecdsa',
	ECDH = 'ecdh',
	HMAC = 'hmac',
	'AES-CTR' = 'aes-ctr',
	'AES-CBC' = 'aes-cbc',
	'AES-GCM' = 'aes-gcm',
	'AES-KW' = 'aes-kw',
	Ed25519 = 'ed25519',
	X25519 = 'x25519',
	'ML-KEM' = 'ml-kem',
	'ML-DSA' = 'ml-dsa',
	'SLH-DSA-SHA2-S' = 'slh-dsa-sha2-s',
	'SLH-DSA-SHA2-F' = 'slh-dsa-sha2-f',
	'SLH-DSA-SHAKE-S' = 'slh-dsa-shake-s',
	'SLH-DSA-SHAKE-F' = 'slh-dsa-shake-f',
}

export enum EncryptionAlgorithms {
	'AES-GCM' = 'aes-gcm',
	'AES-CBC' = 'aes-cbc',
	'AES-CTR' = 'aes-ctr',
}
