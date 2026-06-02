# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Commits follow [Conventional Commits](https://www.conventionalcommits.org), so
release notes can be generated from history.

## [0.1.1](https://github.com/Monadix-AI/monad/compare/v0.1.0...v0.1.1) (2026-06-22)


### Bug Fixes

* **web:** use bun --bun for static export to avoid CJS/ESM conflict ([b42c3f7](https://github.com/Monadix-AI/monad/commit/b42c3f79eab0f03c9e824aae86076327aa735d10))

## [0.1.0](https://github.com/Monadix-AI/monad/compare/v0.0.1...v0.1.0) (2026-06-22)


### Features

* **backlog:** add TOML configuration format idea with reasoning and implications ([92e25ea](https://github.com/Monadix-AI/monad/commit/92e25ea3b3239fd2331bbb3e4704baa87025ae21))
* enable endpoint overrides for various settings APIs ([6cebf45](https://github.com/Monadix-AI/monad/commit/6cebf45cf2f71d4aff6c185ccf25ed646fb9a1e0))
* implement monad-sandbox-launcher for Linux and Windows ([a71e2e3](https://github.com/Monadix-AI/monad/commit/a71e2e30848f959446e6a6dac912b6cd39e77dff))
* init project with base structure ([6877e4d](https://github.com/Monadix-AI/monad/commit/6877e4dd5a408600be7e86e9f0f9c35bd90917d4))
* **lan-pairing:** remote-access infrastructure + monad pair CLI command ([0491049](https://github.com/Monadix-AI/monad/commit/0491049627212652116cb28687ccd927bb873b26))
* **lf:** move knip job to pre-commit and remove pre-push knip job ([b628e07](https://github.com/Monadix-AI/monad/commit/b628e07bdcaa51c56d381621ba1d77b8d1e8ab52))
* **licenses:** add monad licenses command and web settings panel ([300017d](https://github.com/Monadix-AI/monad/commit/300017d05c7917434e75b6613e66dd2f047c2299))
* **licenses:** add monad licenses command and web settings panel ([b4f8f3c](https://github.com/Monadix-AI/monad/commit/b4f8f3cfb8df4feace9496a4bd672137e930346c))
* **loop:** slash command context — ephemeral skill expansion, /handoff command ([5cd3594](https://github.com/Monadix-AI/monad/commit/5cd3594a4f18542f41fa5517159b7aeadcae3e2b))
* **memory:** add GET /v1/graph read endpoint + e2e for the L2 graph ([e86b282](https://github.com/Monadix-AI/monad/commit/e86b2827f2f5c100c26feb37f8b57f2bd190909b))
* **memory:** add L2 extraction, consolidation, and graph query tools ([ac29e36](https://github.com/Monadix-AI/monad/commit/ac29e369ce4446c3184f2ae02a443d4c0e3e39b1))
* **memory:** add self-built L2 graph store (P0) ([4bf9c74](https://github.com/Monadix-AI/monad/commit/4bf9c74ca61aa2dabf9f91bfd9e33438281f2564))
* **memory:** auto-consolidate graph on configurable interval ([80eb728](https://github.com/Monadix-AI/monad/commit/80eb7289315354cd8208ed46d40d2fbdae2c9f8c))
* **memory:** expose qdrant lifecycle status to web UI ([b9e460a](https://github.com/Monadix-AI/monad/commit/b9e460ad6b85d0326834539eb07909ff062bcd1f))
* **memory:** persistent mem0 by default via a daemon-managed local qdrant ([47504e9](https://github.com/Monadix-AI/monad/commit/47504e98587ea3c08fbcfb6c09943fe1a8ebcfb7))
* **memory:** wire auto-consolidate timer into daemon ([0bf6937](https://github.com/Monadix-AI/monad/commit/0bf69375ad990b757a4a0a4775956d3de67546a5))
* **memory:** wire L2 graph into the daemon + /consolidate-graph command ([dde26e5](https://github.com/Monadix-AI/monad/commit/dde26e5aba0cf0bc1e9678d1745340ce5c413975))
* **memory:** wire mem0 vector store config end-to-end for persistence ([f793fdc](https://github.com/Monadix-AI/monad/commit/f793fdc3a751ade48b6f6206ba6a69896d30347d))
* **mo:** activity-aware poses, startup greeting, and idle fidgets ([fe342a4](https://github.com/Monadix-AI/monad/commit/fe342a44d53a0a380e7cd1606adc967cc1aece4f))
* **mo:** adopt Codex atlas-pet sprite standard ([486367a](https://github.com/Monadix-AI/monad/commit/486367ab8aa6822ced1d3bdc40ad07a251c9aecf))
* **mo:** bundle Mo in releases + daemon auto-locate ([f9e3e33](https://github.com/Monadix-AI/monad/commit/f9e3e33291df2f1b2e2286f434c312305a89d02e))
* **mo:** desktop sprite — native shells + daemon drop/launch/quit/status ([23c7150](https://github.com/Monadix-AI/monad/commit/23c71508030b8de0fe5ca00cea171e5e2ed543a4))
* **mo:** enable Mo by default + persist the on/off toggle ([a501dd2](https://github.com/Monadix-AI/monad/commit/a501dd247ef372d91947277c2ab9559b7fd9bfbc))
* **mo:** waiting pose while input box is open + click to open web UI ([db43d0f](https://github.com/Monadix-AI/monad/commit/db43d0fb2001dfb7540838d6cd8f44639c64e9bd))
* OpenAI Responses API proxy + SDK type alignment ([#25](https://github.com/Monadix-AI/monad/issues/25)) ([a8af99b](https://github.com/Monadix-AI/monad/commit/a8af99b661277fdc2e0cf989482c94d72dceab95))
* **skills:** add security audit for private keys, credential URLs, and secret vars ([2a73701](https://github.com/Monadix-AI/monad/commit/2a7370123493b12536c9296c2e7bf885e08ac391))
* **tools/sandbox:** add Linux bubblewrap launcher (P1+P2) ([92c33bc](https://github.com/Monadix-AI/monad/commit/92c33bc1276a97fc9cec052b7bb9fd06bc044351))
* **upgrade-reset:** add upgrade + granular reset commands with web UI ([8dcc09b](https://github.com/Monadix-AI/monad/commit/8dcc09b59933d0b86e0e17f7c76e914dc0ba8944))
* **web:** add a knowledge-graph viewer panel (react-flow) ([228ab9f](https://github.com/Monadix-AI/monad/commit/228ab9f84e7aed01f979183d095ab9e24ee4498e))
* **web:** add a mem0 explorer — stored memories, stats, and a vector cluster map ([adc9ee4](https://github.com/Monadix-AI/monad/commit/adc9ee444e3e15db4827e2a1d4c459a57a68611a))
* **web:** add Mo settings tab — launch/stop + animation preview ([d3d2811](https://github.com/Monadix-AI/monad/commit/d3d2811d5517bdf3e789bbc56880cbf156a250de))


### Bug Fixes

* address all 8 code-review findings from bwrap sandbox implementation ([6ea20e3](https://github.com/Monadix-AI/monad/commit/6ea20e31989d3131d0393b24c522b54b12b2b5eb))
* **build:** use tsc for monad declarations; client typecheck depends on monad build ([112724e](https://github.com/Monadix-AI/monad/commit/112724ec991e14c1b58ec7f78532c3b1262e2499))
* **channels:** remove double as-cast by making Instance.adapter optional ([ea5ece6](https://github.com/Monadix-AI/monad/commit/ea5ece629c4a279d92db1eff23f8a1b1fca9e624))
* **ci:** add backup to MonadPaths test fixtures + fix sandbox launcher path ([647e254](https://github.com/Monadix-AI/monad/commit/647e2544839dd9d0bb0c7c45c9f13662c4241066))
* **ci:** resolve mem0ai upgrade breakage + nightly llvm-mingw 404 ([a76f6bc](https://github.com/Monadix-AI/monad/commit/a76f6bc30594fac99229db6f42d9dd5f3722340b))
* **ci:** resolve three cross-platform test failures ([f9894b5](https://github.com/Monadix-AI/monad/commit/f9894b55ce553908a89e0e0ba205982c77fdda2d))
* **ci:** resolve Windows test + knip failures ([58c324f](https://github.com/Monadix-AI/monad/commit/58c324f15ecbcb1a6bc846ef5fdc2cd432f693fd))
* **ci:** skip docker tests on Windows + fix i18n key assertion ([6b99253](https://github.com/Monadix-AI/monad/commit/6b9925346bc938793ea521216cb0055e1fb3b222))
* **ci:** skip unix-socket tests on Windows + fix qdrant binary name ([a4a7b51](https://github.com/Monadix-AI/monad/commit/a4a7b51eca8f1816dbd17de63ed242dafa8fb982))
* **ci:** use regex for i18n-unstable session search assertion ([d9097b6](https://github.com/Monadix-AI/monad/commit/d9097b60560b6e9f5ca98a022f2276fa25eafeb0))
* **cli:** reset is local; usage subcommand builds its own client ([a23e954](https://github.com/Monadix-AI/monad/commit/a23e9543e862b8d6455dfa98b9eacfddaabce1d7))
* **dev:** restore apps/cli staged typecheck by pre-building monad declarations ([f1ac226](https://github.com/Monadix-AI/monad/commit/f1ac2262de2e30ae49394b2ebfc79cd439f7f782))
* **dev:** restore packages/client-rtk staged typecheck + fix test type errors ([a4db0a8](https://github.com/Monadix-AI/monad/commit/a4db0a87a32f28761f16024d7c8a0487ec9b0452))
* **i18n:** extract hardcoded strings + fill missing zh translations ([eae3311](https://github.com/Monadix-AI/monad/commit/eae3311c855fa12c3974e195f9996f06d63b11cf))
* **i18n:** fill remaining cli.json zh gaps + model.ts unknownAction ([bafbb46](https://github.com/Monadix-AI/monad/commit/bafbb4628732cb33669ceafb8dffafc256b6a3fc))
* **i18n:** i18n-ize obscura, api settings + CLI error messages ([1984b33](https://github.com/Monadix-AI/monad/commit/1984b334eeda05a5e8637f8a89439e3f9d93b3da))
* **imports:** update import paths for handlers and mock model ([6918ea4](https://github.com/Monadix-AI/monad/commit/6918ea4811065a8ab3515c27b1a104ff07231d0c))
* **licenses:** address 8 code-review findings ([a39015d](https://github.com/Monadix-AI/monad/commit/a39015ddd1926d7e495559eaac0ca82905be86d2))
* **licenses:** address 8 code-review findings ([8ad827f](https://github.com/Monadix-AI/monad/commit/8ad827f0c09475ac1ecbf1dc9c1f20489214b1e7))
* **memory:** contain qdrant to its data dir, fall back to in-RAM, derive port per-worktree ([0f54714](https://github.com/Monadix-AI/monad/commit/0f54714672356a971e68690d959e5437b8a7cbf7))
* **memory:** contain qdrant to its data dir, fall back to in-RAM, derive port per-worktree ([e8a4a93](https://github.com/Monadix-AI/monad/commit/e8a4a9317a67d784fb56ea40c467c75dd44d08d6))
* **memory:** create mem0 history dir; dedupe test path fixtures into a shared helper ([1eab9ca](https://github.com/Monadix-AI/monad/commit/1eab9cae10ccf4ad8f9709e06d6496bbc9037869))
* **memory:** map openrouter LLM to openai provider and set default base URL ([096e09a](https://github.com/Monadix-AI/monad/commit/096e09acd017c70c91143826bf21388207ce956a))
* **memory:** supervise qdrant — auto-restart on crash, bounded backoff, discard bad binary ([081ed0b](https://github.com/Monadix-AI/monad/commit/081ed0b7113ff8765b08655868c48dba65b509b3))
* **memory:** supervise qdrant — auto-restart on crash, bounded backoff, discard bad binary ([935ca93](https://github.com/Monadix-AI/monad/commit/935ca9392bd418ebb0d78eb75ed1092afef00d83))
* **mo:** address code-review findings ([1fedfbe](https://github.com/Monadix-AI/monad/commit/1fedfbe8fa990ea183165f36343acef4d70bc531))
* **mo:** avoid empty-array nounset error on bash 3.2 ([7058bbe](https://github.com/Monadix-AI/monad/commit/7058bbeb5527b951fbe8ac2a107f204a6645faaa))
* **mo:** dev auto-locate + actionable launch error ([0fa088c](https://github.com/Monadix-AI/monad/commit/0fa088c5a20f6aaff624c8dc1b25434309023ed2))
* **openai-compat:** change default approval policy from 'auto' to 'local' ([459d21b](https://github.com/Monadix-AI/monad/commit/459d21b29fe71310a14220b23156bedd07c6a7fe))
* **openrouter:** also explicitly fetch audio modality models ([af4a970](https://github.com/Monadix-AI/monad/commit/af4a97037bfb1ab9c0d6b92e400d0f2c416b2bdc))
* **openrouter:** append known embedding models omitted from /v1/models ([6943625](https://github.com/Monadix-AI/monad/commit/6943625a0157b02dbfbf2a62e97b915e60fec660))
* **openrouter:** exclude zero prices from listModels output ([8800e19](https://github.com/Monadix-AI/monad/commit/8800e192e3eb80047a86b05a963bfbd0d7655d97))
* **openrouter:** exclude zero prices from listModels output ([e2e384c](https://github.com/Monadix-AI/monad/commit/e2e384cce778098369e3dfd2a6e9ea16829e6bad))
* **openrouter:** fetch all model categories via ?output_modalities filters ([91d747a](https://github.com/Monadix-AI/monad/commit/91d747a451553a624084d1be5606fbb8edfc23e2))
* **openrouter:** fetch all non-default model categories from OpenRouter API ([8858aa6](https://github.com/Monadix-AI/monad/commit/8858aa60921a5d2a74c2734b7e53737a7c7581fc))
* **openrouter:** fetch embedding models via ?output_modalities=embeddings ([63b6056](https://github.com/Monadix-AI/monad/commit/63b6056ff3a58ea5b6734ddc6c4ff056cee0defb))
* **openrouter:** fetch image/speech/embedding models missing from default API ([7a4020f](https://github.com/Monadix-AI/monad/commit/7a4020f243add3400b44d3a3270dba986eaf7ba5))
* **openrouter:** surface embedding models and enable embed calls ([6c6f1db](https://github.com/Monadix-AI/monad/commit/6c6f1dbdb53cf70be936aee458ef88a82024af90))
* **openrouter:** surface embedding models and enable embed calls ([e53b7ef](https://github.com/Monadix-AI/monad/commit/e53b7efc2c96dd7ee138efbe0c7afc4b21b73aee))
* **oversight:** address code-review findings in dangling-interrupt cleanup ([fdf1279](https://github.com/Monadix-AI/monad/commit/fdf1279d9e09a1a9f90f3e9dc3d4d2daf8f00454))
* **oversight:** address code-review findings in dangling-interrupt cleanup ([a4ae367](https://github.com/Monadix-AI/monad/commit/a4ae3672659d1bffeb3eee01094c4b1627173f45))
* **oversight:** resolve dangling approval/clarify cards after daemon restart ([a36b087](https://github.com/Monadix-AI/monad/commit/a36b08710a2ad2d3abe00bad407c4c13b249ee2c))
* **oversight:** resolve dangling approval/clarify cards after daemon restart ([3e9525b](https://github.com/Monadix-AI/monad/commit/3e9525be8d2c2b5b206c9e9f83310b7aa699bf3e))
* **platform:** windows process-tree kill + graceful shutdown via HTTP RPC ([01a117a](https://github.com/Monadix-AI/monad/commit/01a117a6b61fc8b66efc854bf86beaad120522bf))
* replace non-null assertion in LEGACY_PATHS loop with forEach ([22b7aef](https://github.com/Monadix-AI/monad/commit/22b7aef289ac8ff29de4914affc69052c02bf004))
* **review:** address 4 code-review findings ([bc79598](https://github.com/Monadix-AI/monad/commit/bc795987c983f6ddd05c4249a8d15e3158b77ed3))
* **review:** address 4 code-review findings ([21fd3d5](https://github.com/Monadix-AI/monad/commit/21fd3d547d66caac097b1197826eea7d14c2fdb5))
* security hardening for OpenAI-compat and Responses API controllers ([0dd9112](https://github.com/Monadix-AI/monad/commit/0dd91121a7bd7d5b23d661b07af65468b5c580af))
* security hardening for Responses API and OpenAI-compat controllers ([244b9f9](https://github.com/Monadix-AI/monad/commit/244b9f95e8ee10591d85216d2722f429679011de))
* **security:** block javascript:/data: URLs in card actions (XSS) ([094d470](https://github.com/Monadix-AI/monad/commit/094d470d4ad9161ef9903046bc434b8e701eb234))
* **security:** block sandbox write-escape through a symlink leaf ([e5aa2fc](https://github.com/Monadix-AI/monad/commit/e5aa2fcd5d9a293b1835d224fef80b89d525c04a))
* **security:** close code-review follow-ups in the security hardening ([3b4de36](https://github.com/Monadix-AI/monad/commit/3b4de36262c02f3110ba3386a9d30345f74ba83f))
* **security:** close code-review follow-ups in the security hardening ([f3de019](https://github.com/Monadix-AI/monad/commit/f3de019ef0022f3b6a5daf13fbe331de613b773d))
* **security:** close responses-api auth bypass + licenses path traversal ([6a9e59c](https://github.com/Monadix-AI/monad/commit/6a9e59cd060a91eb7cba9245dfe1f42df82d26a9))
* **security:** enforce net:'none' in-kernel on Linux + honest x-platform sandbox logging ([b43c82c](https://github.com/Monadix-AI/monad/commit/b43c82caf89961e64de0c6bd7d476a3f2a340869))
* **security:** guard pack-declared MCP servers from SSRF + secret exfil ([0dbe6bf](https://github.com/Monadix-AI/monad/commit/0dbe6bf059da34e858504d13888ab88f84783b9f))
* **security:** harden OpenAI-compat ingress (auth, approval default, session/agent scoping) ([02189cf](https://github.com/Monadix-AI/monad/commit/02189cff438b673c641bd130421e407eaabf396a))
* **security:** re-verify atom-pack integrity hash at load time ([c079026](https://github.com/Monadix-AI/monad/commit/c0790261a1ec6571fa4c096ea51429665edf2ad7))
* **security:** webhook channels must not listen without signature verification ([fa3c8d0](https://github.com/Monadix-AI/monad/commit/fa3c8d01853cdec849e2ced4207a24c5ecf6ddbe))
* **skill-scan:** close three security review findings ([cac6099](https://github.com/Monadix-AI/monad/commit/cac6099dae4c10966620882b710aa5240d572239))
* **skill-scan:** harden security scan coverage and correctness ([d35fe28](https://github.com/Monadix-AI/monad/commit/d35fe28f5c05dea44cbb004da866947952fa5968))
* **skill-scan:** patch two minor pattern gaps from security review ([ccf8a14](https://github.com/Monadix-AI/monad/commit/ccf8a14f263ee3f11a2b554d1ad6de81ecf4eef0))
* **skills:** add scan to git/http/clawhub install paths ([69a98d4](https://github.com/Monadix-AI/monad/commit/69a98d409394422643024d61571d07e90f833d7f))
* **skills:** scan all files in a skill package, not just SKILL.md ([8738117](https://github.com/Monadix-AI/monad/commit/8738117251cf4fcd13f5eac860d6df5a282e6583))
* **test:** add auth token to responses-api e2e tests ([8e8d219](https://github.com/Monadix-AI/monad/commit/8e8d219e5056578607b85e0a0ae549695827a7f1))
* **test:** add explicit timeouts to Docker code-exec tests ([6ac8870](https://github.com/Monadix-AI/monad/commit/6ac8870a232d68e7b71ac8efd1377b7bf5c0acbe))
* **test:** narrow errorData cast to non-null type to fix TS never inference ([b35cdb8](https://github.com/Monadix-AI/monad/commit/b35cdb83c629cb6ffaadf2cfe1b6091c289a0559))
* **test:** responses-api reader body!.getReader + errorData! narrowing ([2df3b60](https://github.com/Monadix-AI/monad/commit/2df3b601987b7cf1e530789623aadb290d27cd3e))
* **tests:** resolve all local test failures before CI push ([4d04cf4](https://github.com/Monadix-AI/monad/commit/4d04cf49c75ea78c20f776647ea8465742a8ffd3))
* **test:** update command list, fix Windows path sep, skip bwrap on non-Linux ([96351a3](https://github.com/Monadix-AI/monad/commit/96351a3c01d41d616b1aee374b4082be9b12f721))
* **tools/sandbox:** add --unshare-pid and harden bwrapBin path resolution ([99cdb35](https://github.com/Monadix-AI/monad/commit/99cdb35acc0669b387027ca28f8b8403d1ae8240))
* **web:** color graph nodes by scope so agents stay distinguishable ([5780e48](https://github.com/Monadix-AI/monad/commit/5780e48d5013856d2c80ca9fb161c4d90678954c))
* **web:** fall back to type-coloring when the graph has a single scope ([053eff6](https://github.com/Monadix-AI/monad/commit/053eff65819a079611e9da59ea48743373f5a61a))
* **web:** suppress optimistic echo when history already has the message ([8c1ef4e](https://github.com/Monadix-AI/monad/commit/8c1ef4ee80fe8808e974aaa8ffa6b26dd19b8529))


### Performance

* **ci:** extract typecheck job + add build matrix + move single-platform jobs to macOS ([689e463](https://github.com/Monadix-AI/monad/commit/689e463e81ceb2eeeebe6d6b61d4b5671a9025ce))
* **ci:** run typecheck only on Linux ([3beed68](https://github.com/Monadix-AI/monad/commit/3beed689305b55bb5b0dfeeef5fd73cea7e6eafe))
* **config:** parallelize loadAll file reads with Promise.all ([f366885](https://github.com/Monadix-AI/monad/commit/f36688514af9f7c4bff2bfe2f292acec992f76da))
* **memory:** cut graph-extraction cost — prose-only input + char budget ([ccb729e](https://github.com/Monadix-AI/monad/commit/ccb729e4b08b51cbb67d0e91a83ad7079e65a738))


### Refactors

* **agent:** split loop/index.ts into focused modules ([a07fce7](https://github.com/Monadix-AI/monad/commit/a07fce764e1be11f11da98d6487eff79edd4fb5e))
* **client-rtk:** move shared useModelSettings to @monad/client-rtk ([4100e0b](https://github.com/Monadix-AI/monad/commit/4100e0b3a9df2b83b7a5ff914ebccb6789e8b791))
* **cli:** split commands into local vs daemon categories ([c3d0a33](https://github.com/Monadix-AI/monad/commit/c3d0a33e85cebb01bab8557e922799cd828c004b))
* **home:** extract config error formatting into config-errors.ts ([c5ffa8b](https://github.com/Monadix-AI/monad/commit/c5ffa8b25211fa0ce0d8e67b2fa409469a5be0b1))
* **home:** put all binary DBs under {home}/db, keep memory/ user-readable ([bd6b4b8](https://github.com/Monadix-AI/monad/commit/bd6b4b88ca1c4906ceb6750492394addf6105181))
* **home:** put all binary DBs under {home}/db, keep memory/ user-readable ([3c8917e](https://github.com/Monadix-AI/monad/commit/3c8917ee9c18a40359ea6ffa7ada0380f946e20f))
* **monad:** flatten http controllers, group services/, organize unit tests ([c4537d2](https://github.com/Monadix-AI/monad/commit/c4537d2ad6663ce9fc452918255e7accf72dceac))
* **monad:** reorganize src/ for clearer domain boundaries ([b1a2a7a](https://github.com/Monadix-AI/monad/commit/b1a2a7a78a899b35b77aefaf60d545d35dd12d40))
* **openrouter:** use openAiPrice, add cacheWrite, inject fetch ([049f392](https://github.com/Monadix-AI/monad/commit/049f3922b05622daa82fb3b856b86946f9945a07))
* **openrouter:** use openAiPrice, add cacheWrite, inject fetch ([978a416](https://github.com/Monadix-AI/monad/commit/978a416b7617cc232e2c4e50e8bebb31de790417))
* **set-sandbox:** switch to sessionsApi for injecting endpoints ([d0e1314](https://github.com/Monadix-AI/monad/commit/d0e1314628d0d7a5893d0417d29f8cdbb90fd6ab))
* **skills:** externalize scan rules to scan-rules.json ([22adaf6](https://github.com/Monadix-AI/monad/commit/22adaf6c49c632e5b647af609ae43b99444bf5fd))
* **web:** extract useAsyncAction hook, eliminate 5 inline copies ([5738210](https://github.com/Monadix-AI/monad/commit/573821072e2f0193d9fd66294b23dd48ac630597))
* **web:** split chat.tsx into focused component files ([bf342ed](https://github.com/Monadix-AI/monad/commit/bf342ede82f14ce97020ee3d4f9f6fd15f42b2a6))


### Documentation

* **memory:** mark L2 timer catch-up as shipped (auto-consolidate) ([3426155](https://github.com/Monadix-AI/monad/commit/3426155777025e07b2555e6a61773ad43c7039a5))
* **memory:** note mem0 persists by default via the managed local qdrant ([634fcda](https://github.com/Monadix-AI/monad/commit/634fcda901df47df9b749b77a81890656bfdaf0f))

## [Unreleased]

[Unreleased]: https://github.com/monadix-labs/monad/commits/main
