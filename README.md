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
    - rewraps\*
    - verify
    - hash

> \* counted as a generative operation for key usage reasons (key auto-rotate, in-use datakeys, etc) but as a retreival operation for billing purposes (always free)

### Pricing

> Checkmarks below mean it's live and/or enforced.

- [x] Free (community supported) managed version
    - [x] 3 month logging (operation metadata only)
    - [ ] Bitwarden BYO key vault
    - [x] `Unlimited` seats and machine api keys
    - [ ] `TBA` keyrings
    - [ ] `3.5 million ops` monthly **total** operations. Upon hitting limit, only retreival operations will go through.
    - [ ] Automated key rotation (time & usage based) with webhook notifications
    - [x] Manual key rotation
    - [ ] Up to the last `TBA` (in-use: has been used for a generation op at least once) datakeys are stored per keyring.
    - [x] PQC key generation - current NIST forerunner(s)
    - [ ] PQC encryption - current NIST forerunner(s)
- [ ] (`$TBA`/month) Paid (`TBA` support) managed version
    - [x] Everything in free
    - [ ] `TBA` logging (operation metadata only)
    - [ ] `Unlimited free` external log push
    - [ ] Other vendors BYO key vault
    - [ ] `Unlimited free` keyrings
    - [ ] (`$TBA`/million ops) monthly generative operations
        - [ ] Base price already includes `TBA` monthly generative operations
    - [ ] `Unlimited free` retreival operations
    - [ ] Key rotations now include webhook customization and email notifications
    - [ ] (`$TBA`/`TBA` in-use datakeys) per keyring
        - [ ] Base price already includes `TBA` datakeys per keyring

> We pledge that retreival operations will always be free and accessible. We never want to be in a situation where we're keeping your data hostage.

[Full terminology](https://github.com/autosec-network/eaas/wiki/Terminology)

## Sponsors

[![Cloudflare](https://github.com/Cloudflare.png?size=75)](https://www.cloudflare.com/developer-expert-program/)
[![ChainFuse](https://github.com/ChainFuse.png?size=75)](https://chainfuse.ai)
