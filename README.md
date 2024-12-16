# Encryption as a Service

Inspired by [Hashicorp's Vault's Transit secrets engine](https://developer.hashicorp.com/vault/docs/v1.14.x/secrets/transit) (pre license change - AUG 10 2023), powered by [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/), [`node:crypto`](https://nodejs.org/api/crypto.html), [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) and runs completely on Cloudflare Workers.

Keep your own storage system and just pass-through encrypt/decrypt and stay up to date and compliant. No data is ever stored and only lives long enough to do the operation. Per request additional wrapping to counter MITM/TLS inspection is also available.

## Versioning

> [!NOTE]
> Currently under development, see progress under the [Projects](https://github.com/autosec-network/eaas/projects) tab.

Breaking api changes will use a new api version and a depreciation schedule for the previous respective version.

| Version | Status  | Support                  |
| ------- | ------- | ------------------------ |
| `v0`    | `ALPHA` | From `2024-12-14` to `?` |

- `ALPHA`: Expect breaking changes at any time
- `BETA`: Should no longer have breaking changes, but not fully stable yet.
- `GA`: Maintenance (bug/security fixes) changes only.
- `DEPRECATED`: Still maintenance only, but endpoints will be shutdown soon. Migrate to new endpoint by the corresponding date above.
- `RETIRED`: Shut down.

## Plans

### Legend

- Generative operations
    - encryption
    - signing
    - hmac
    - randomness
- Retreival operations
    - decryption
    - key rewraps
    - verify
    - hash

### Pricing

- [ ] Free (community supported) managed version
    - [ ] 3 month logging (operation metadata only)
    - [ ] Bitwarden BYO key vault
    - [ ] `Unlimited` seats and machine api keys
    - [ ] `TBA` keyrings
    - [ ] `3.5 million ops` monthly **total** operations. Upon hitting limit, only retreival operations will go through.
    - [ ] Automated key rotation (time & usage based) with webhook notifications
    - [ ] Manual key rotation
    - [ ] PQC key generation - current NIST forerunner(s)
    - [ ] PQC encryption - current NIST forerunner(s)
- [ ] Paid (`TBA` support) managed version
    - [ ] Everything in free
    - [ ] `TBA` logging (operation metadata only)
    - [ ] `Unlimited` external log push
    - [ ] Other vendors BYO key vault
    - [ ] `Unlimited` keyrings
    - [ ] (`$TBA`/million ops) monthly generative operations
    - [ ] `Unlimited free` retreival operations
    - [ ] Key rotations now include webhook customization and email notifications

> We pledge that retreival operations will always be free and accessible. We never want to be in a situation where we're keeping your data hostage.

## Sponsors

[![Cloudflare](https://github.com/Cloudflare.png?size=75)](https://www.cloudflare.com/developer-expert-program/)
[![ChainFuse](https://github.com/ChainFuse.png?size=75)](https://chainfuse.ai)
