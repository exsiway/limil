# Third-party notices

limil is MIT licensed (see `LICENSE`). It ships the following third-party
work, each under its own license, reproduced in full where the license asks
for it.

## Fonts (bundled in the extension, `extension/fonts/`)

| Font | Files | Copyright | License |
|---|---|---|---|
| Manrope 4.504 | `manrope.woff2`, `manrope-cyr.woff2` | Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope) | SIL Open Font License 1.1, `extension/licenses/OFL-Manrope.txt` |
| JetBrains Mono 2.211 | `jetbrains.woff2`, `jetbrains-cyr.woff2` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1, `extension/licenses/OFL-JetBrainsMono.txt` |

Both licenses travel with the extension package (`npm run pack:store`
copies `extension/licenses/` into the store zip), as the OFL requires of a
distribution.

## Runtime dependency (bundled into `extension/dist/`)

| Package | Version | License | Text shipped as |
|---|---|---|---|
| viem | 2.56.3 | MIT | `licenses/MIT-viem.txt` |
| ox | 0.14.44 | MIT | `licenses/MIT-ox.txt` |
| abitype | 1.2.3 | MIT | `licenses/MIT-abitype.txt` |
| isows | 1.0.7 | MIT | `licenses/MIT-isows.txt` |
| @noble/curves | 1.9.1 | MIT | `licenses/MIT-noble-curves.txt` |
| @noble/hashes | 1.8.0 | MIT | `licenses/MIT-noble-hashes.txt` |
| @scure/base | 1.2.6 | MIT | `licenses/MIT-scure-base.txt` |
| @scure/bip32 | 1.7.0 | MIT | `licenses/MIT-scure-bip32.txt` |
| @scure/bip39 | 1.6.0 | MIT | `licenses/MIT-scure-bip39.txt` |

Only `viem` is a dependency of this project; the rest arrive through it and
ship executable code, not only types. MIT requires the copyright and
permission notice to travel with the code, so every text above is inside the
extension folder and therefore inside every archive built from it, next to
this project's own licence (`licenses/LICENSE-limil.txt`) and the two font
licences.

The list is not written by hand from package.json. `test/licenses.test.mjs`
asks esbuild which packages the bundles actually contain and fails when one of
them has no text shipped, because reading a dependency list is how `abitype`,
`ox`, `isows` and the three `@scure` packages were missed.

## Development only (not shipped)

esbuild (MIT), solc (MIT), @ethereumjs/vm, @ethereumjs/common, @ethereumjs/util
(MPL-2.0). They build and test the extension and the contracts and are not
part of any package a user installs.
