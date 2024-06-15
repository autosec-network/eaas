# Encryption as a Service

Inspired by [Hashicorp's Vault's Transit secrets engine](https://developer.hashicorp.com/vault/docs/v1.14.x/secrets/transit) (pre license change - AUG 10 2023), powered by [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/), [`node:crypto`](https://nodejs.org/api/crypto.html), [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) and runs completely on Cloudflare Workers.

Keep your own storage system and just pass-through encrypt/decrypt and stay up to date and compliant. No data is ever stored and only lives long enough to do the operation. Per request additional wrapping to counter MITM/TLS inspection is also available.

Currently under development, see progress under the [Projects](https://github.com/autosec-network/eaas/projects) tab.

Current plans:

-   [ ] Free (community supported) hosted version
    -   [ ] 3 month logging (operation metadata only - no actual data)
    -   [ ] BYO key vault (initially will only support Bitwarden)

## Sponsors

[![Cloudflare](https://github.com/Cloudflare.png?size=75)](https://www.cloudflare.com/developer-expert-program/)
[![ChainFuse](https://github.com/ChainFuse.png?size=75)](https://chainfuse.ai)
