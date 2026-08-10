import rootPkg from '../../../package.json' with { type: 'json' };

declare const BUILD_VERSION: string | undefined;

export const MONAD_VERSION: string = typeof BUILD_VERSION === 'string' ? BUILD_VERSION : rootPkg.version;
