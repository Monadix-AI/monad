# Changelog

## [0.1.5](https://github.com/Monadix-AI/monad/compare/v0.1.4...v0.1.5) (2026-08-12)


### Features

* **developer:** add new routes for live events in development settings ([fca35ec](https://github.com/Monadix-AI/monad/commit/fca35eceb49c2d6dbf1b7b552a86fabbdcdccc6c))
* **developer:** persist and replay native live events ([6b9b79e](https://github.com/Monadix-AI/monad/commit/6b9b79e8096140d3ee7743453934a44f584fb000))
* **installer:** start Monad after interactive install ([a49cf9e](https://github.com/Monadix-AI/monad/commit/a49cf9e0bc0facbb39e1b0401c4a5c13bbd91056))
* **observation:** normalize native live event projections ([d00cf67](https://github.com/Monadix-AI/monad/commit/d00cf673df7025554e7b25bd0ba27fb50984308d))
* **ui:** add thinking orbs to agent activity ([fef1403](https://github.com/Monadix-AI/monad/commit/fef140321f8415c9d586f59854eae8a98cfce544))
* **upgrade:** verify and apply updates in process ([a167694](https://github.com/Monadix-AI/monad/commit/a167694f9107b892a8d8b0f0bf6c62dac091d0bf))
* **web:** add sidebar theme choices ([07cec08](https://github.com/Monadix-AI/monad/commit/07cec08e5f1d623e7e3d397478ec4e0b5fae92b8))
* **workplace:** add rich file viewing and stable observation UI ([16e19f4](https://github.com/Monadix-AI/monad/commit/16e19f45b39f5a62b2a7b66d3830ab33a96c311e))


### Bug Fixes

* **chat:** avoid redundant message retrievals ([a1bdfb3](https://github.com/Monadix-AI/monad/commit/a1bdfb30ead1643db2c2434b1f6483336938f888))
* **ci:** satisfy release quality checks ([693e6d0](https://github.com/Monadix-AI/monad/commit/693e6d09dd5b651ee493dfa6eaa9dd3074753fcd))
* **codex:** keep completed turns settled ([b344de8](https://github.com/Monadix-AI/monad/commit/b344de8b20158df5f101ebdb001e8f9188d3a40a))
* **developer:** follow live replay step selection ([ba46e7a](https://github.com/Monadix-AI/monad/commit/ba46e7a9861852ab8a5082d7e1a7f32ca312b0e8))
* **installer:** suppress terminal input during animations ([815e903](https://github.com/Monadix-AI/monad/commit/815e9037c897e317ec85dc87e0b2370b8126c912))
* **mesh:** drop a request whose write never reached the child ([0ba3fd1](https://github.com/Monadix-AI/monad/commit/0ba3fd14ae95175c34f6117423dcc5c80ad13a38))
* **mesh:** join runtime shutdown and output settlement ([eb78d83](https://github.com/Monadix-AI/monad/commit/eb78d83994513bd11224b74336926888ef4334d4))
* **mesh:** observe an activation nobody is left to await ([afc908f](https://github.com/Monadix-AI/monad/commit/afc908f5fb48ed731a72e8123cd5ecce9f2642b5))
* **mesh:** reserve placeholders before initial turns ([dac5f4f](https://github.com/Monadix-AI/monad/commit/dac5f4f76ac86583d1a92e153c9013928b88885e))
* **monad:** join managed runtimes before restart ([37775f8](https://github.com/Monadix-AI/monad/commit/37775f891b17a5d23cb83a2737f1ddc1079e0f5d))
* **monad:** join the in-flight activation when a runtime stops ([81ce63e](https://github.com/Monadix-AI/monad/commit/81ce63ede8a0e108b48b6bd964284b39efe88ef7))
* **monad:** settle codex channel writes when a session stops mid-attach ([fd90fee](https://github.com/Monadix-AI/monad/commit/fd90fee4339a5d50f3cfebf0599f9cb265ad2059))
* **observation:** reconcile Monad tool cards ([e576747](https://github.com/Monadix-AI/monad/commit/e576747e3da1de950717add982a029feb506195e))
* **release:** address draft publication by repository ([7a6ccf3](https://github.com/Monadix-AI/monad/commit/7a6ccf3d50213148509003002a4f0ca5b6875cfb))
* **release:** make published notes and assets deterministic ([2643fe0](https://github.com/Monadix-AI/monad/commit/2643fe0829ef66eb82c7664c5119e94ec909c9b1))
* **release:** merge Windows ARM64 artifact restoration ([2ff430d](https://github.com/Monadix-AI/monad/commit/2ff430db8a4a13f6be72a69d55707a776fda372f))
* **release:** restore Windows ARM64 artifacts ([ac97d1e](https://github.com/Monadix-AI/monad/commit/ac97d1eff5e17e4549e498239775026c6db1b91a))
* **security:** harden untrusted parsing and dependencies ([876593b](https://github.com/Monadix-AI/monad/commit/876593bad4b12d725697f14f780ac3925d61fc57))
* **ui:** keep compact path segments adjacent ([0ef3cc1](https://github.com/Monadix-AI/monad/commit/0ef3cc199c1e9ae01ead617f26600271773696df))
* **ui:** preserve virtual list scroll anchors ([67134e8](https://github.com/Monadix-AI/monad/commit/67134e839cb41d3622de889adf2266b0eb7fe76c))
* **workplace:** use provider icons for agent members ([9b49ba2](https://github.com/Monadix-AI/monad/commit/9b49ba267ac5ae4405ea7e2e738c2219a31a82f0))


### Performance

* **environment:** create the home directories in one pass ([5e56dea](https://github.com/Monadix-AI/monad/commit/5e56dea938be10ee92755ce31b3372523aff6370))


### Refactors

* **docker:** consolidate container configuration ([b79ef0a](https://github.com/Monadix-AI/monad/commit/b79ef0ac261ab5054a34c7453032784261c088dc))
* **release:** consolidate dist configuration at root ([203a9e1](https://github.com/Monadix-AI/monad/commit/203a9e1d1ce12bc45e95f4e4d15db3ec04dfeba5))
* **web:** keep resolveThemePreference module-private ([bb69c36](https://github.com/Monadix-AI/monad/commit/bb69c360b79e47ac1cc75a49e405b6003c9a3f3b))

## [0.1.4](https://github.com/Monadix-AI/monad/compare/v0.1.3...v0.1.4) (2026-08-10)


### Features

* **chat:** refine session headers and member roster ([a5674e5](https://github.com/Monadix-AI/monad/commit/a5674e5c5229c32e912439d0fc2c4d7950243f1f))
* **observation:** normalize provider event metadata ([1fd52a9](https://github.com/Monadix-AI/monad/commit/1fd52a9983b45fc75a14f34321ce00739d1800a3))
* **observation:** refine tool and message cards ([60bbaf2](https://github.com/Monadix-AI/monad/commit/60bbaf20598a64564f134d91766068ce498c39dd))
* **release:** migrate updates to dist ([4c87dae](https://github.com/Monadix-AI/monad/commit/4c87daeed1433e6e14d2b77e6c0463647e38f35a))
* **ui:** add reusable file and shell cards ([c57cf88](https://github.com/Monadix-AI/monad/commit/c57cf88d55f093afeaa779f66c5fbeee595bdb24))


### Bug Fixes

* **ci:** satisfy release quality gates ([faba96b](https://github.com/Monadix-AI/monad/commit/faba96b8963375329057b85b86cdad6319db39d9))
* **release:** grant attestation permissions ([8bb9b27](https://github.com/Monadix-AI/monad/commit/8bb9b27d1e363ac0dae990c9ed691c7b8704cad7))
* **web:** add sidebar scroll affordances ([6e73a37](https://github.com/Monadix-AI/monad/commit/6e73a37d8ff3e6e734521edd7396f0ef1e809503))
* **web:** hide mesh chats from sidebar ([169eec7](https://github.com/Monadix-AI/monad/commit/169eec797e578131dd0be51eec5d73fba8299df3))


### Performance

* **licenses:** accelerate license generation ([92101ea](https://github.com/Monadix-AI/monad/commit/92101ea2ca0fb5d95972a4b3db07d7f8515d8277))

## [0.1.3](https://github.com/Monadix-AI/monad/compare/v0.1.2...v0.1.3) (2026-08-10)


### Bug Fixes

* **composer:** keep attachment titles clear of remove action ([a330e39](https://github.com/Monadix-AI/monad/commit/a330e3959f0c92083adf08731a95b87037927017))
* **i18n:** standardize plural and relative-time copy ([2113329](https://github.com/Monadix-AI/monad/commit/2113329f8c45cbbe3f05fbd15640365456602508))
* **mesh:** create placeholders after runtime admission ([8002810](https://github.com/Monadix-AI/monad/commit/80028102a3563c64342c915f214f908b4a5788d8))
* **mesh:** harden managed project runtimes ([acc0005](https://github.com/Monadix-AI/monad/commit/acc000573aacc23c72abf75354a7956c019b506e))
* **mesh:** rank session and agent usage details ([8ac0cc6](https://github.com/Monadix-AI/monad/commit/8ac0cc6af25853110c2ca3e9f0819ddbef8ef10f))
* **web:** apply project new-session target on first click ([8761ded](https://github.com/Monadix-AI/monad/commit/8761ded0b391fff77fdd9451bce1375d9721a9ea))
* **web:** restore functional sidebar row height ([d86ee2a](https://github.com/Monadix-AI/monad/commit/d86ee2ae526abd06fb38f5b500b04f7095dd8b17))
* **workplace:** reflect agent activity without refresh ([5095b1b](https://github.com/Monadix-AI/monad/commit/5095b1bce820b8a623e48091ed4ff0a8c1421ec7))
* **workplace:** render lifecycle actors from typed events ([1e3169b](https://github.com/Monadix-AI/monad/commit/1e3169bd0fa77a352c99b1f07f04b3718ab1f0df))
* **workplace:** stabilize project and observation experience ([59968f8](https://github.com/Monadix-AI/monad/commit/59968f8284249c14f12583f0c40904dd17beb875))


### Refactors

* **sessions:** require manual project member joins ([52030d9](https://github.com/Monadix-AI/monad/commit/52030d9d51f82dbc40dd3579a40a6a842ba0ec55))

## [0.1.2](https://github.com/Monadix-AI/monad/compare/v0.1.1...v0.1.2) (2026-08-08)


### Bug Fixes

* **cli:** use the installed daemon command ([6b4ef3b](https://github.com/Monadix-AI/monad/commit/6b4ef3b9e426b194db79b323f712f56121ef6976))
* **upgrade:** restart daemon with installed binary ([25273f0](https://github.com/Monadix-AI/monad/commit/25273f0ab0d42a5b77f188c941cb5c1a9925ef23))


### Documentation

* **install:** document wget fallback ([d707187](https://github.com/Monadix-AI/monad/commit/d7071873ddf44239d08133907466b6d64880a686))

## [0.1.1](https://github.com/Monadix-AI/monad/compare/v0.1.0...v0.1.1) (2026-08-07)


### Features

* **channels:** add native commands and harden private replies ([9303834](https://github.com/Monadix-AI/monad/commit/93038346378eebbb7cf3f75bc2373938b67cfda4))
* **daemon:** notify when updates are available ([e8f1ce6](https://github.com/Monadix-AI/monad/commit/e8f1ce601192ad39f4fe3da07cc9ec727e344106))
* **web:** polish sidebar visual style ([f48dd84](https://github.com/Monadix-AI/monad/commit/f48dd84fbb5d0bc158d85e4f12066c3eeeee7d73))


### Bug Fixes

* **chat:** smooth transcript scrolling near the edges ([d42f3a1](https://github.com/Monadix-AI/monad/commit/d42f3a1d033768a32cde2476d9cbf5c425c719b1))
* **ci:** speed up Windows test execution ([6239e35](https://github.com/Monadix-AI/monad/commit/6239e3537e9a0ac8b5bdbdeeecd3b5d65742baa3))
* **ci:** stabilize managed agent response timing ([09ad11c](https://github.com/Monadix-AI/monad/commit/09ad11ccda97161ac7b0a45986e11d6a9fe17a39))
* **ci:** stabilize Windows test paths and config reads ([e4abff1](https://github.com/Monadix-AI/monad/commit/e4abff197c4a41852852f9dbbf3255b5f463fdcc))
* **ci:** stabilize Windows test paths and config reads ([fe508de](https://github.com/Monadix-AI/monad/commit/fe508de298dc0e248e1ab2860fb25489f8a77f1d))
* **cli:** write the status result once, to stdout ([28862fe](https://github.com/Monadix-AI/monad/commit/28862fee7531e3ddc1544ec51f5f2d1e6d1eb820))
* **dev:** link worktrees to Turbo remote cache ([c547758](https://github.com/Monadix-AI/monad/commit/c54775846bb6180a597abc2a8c0b0fbcda67b7e7))
* **release:** publish only validated pending versions ([fd9de00](https://github.com/Monadix-AI/monad/commit/fd9de003bc13783da59afd5572bac89de0d1fb48))


### Documentation

* make pages self-contained and extend Simplified Chinese coverage ([e841acc](https://github.com/Monadix-AI/monad/commit/e841acc7a6306805b89af77c350b9f7ea18ec3a1))

## [0.1.0](https://github.com/Monadix-AI/monad/compare/v0.0.1...v0.1.0) (2026-08-07)


### Features

* all start from here ([a62c359](https://github.com/Monadix-AI/monad/commit/a62c35951a40320a515beee845ed4c2561b7635d))

## Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Commits follow [Conventional Commits](https://www.conventionalcommits.org), so
release notes are generated from history by release-please on each release.

This file is **generated** — do not add entries by hand, or the next release PR will
conflict with them. To influence what appears here, write the commit message: the
`type(scope): subject` line becomes the changelog entry, and `!` plus a
`BREAKING CHANGE:` footer is what marks an incompatible change. Until the first
release is cut, this file is intentionally empty; unreleased work is visible in
[the commit history](https://github.com/Monadix-AI/monad/commits/main) and in the open
release PR.
