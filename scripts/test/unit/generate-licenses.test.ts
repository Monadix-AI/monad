import { describe, expect, test } from 'bun:test';

import { licensePackageFromManifest } from '../../generate-licenses.ts';

describe('license package metadata', () => {
  test('normalizes package metadata into the generated license contract', () => {
    expect(
      licensePackageFromManifest({
        name: '@example/tool',
        version: '1.2.3',
        license: 'SEE LICENSE IN LICENSE.md',
        repository: { url: 'git+https://github.com/example/tool.git' },
        author: 'Example Team <team@example.com> (https://example.com)'
      })
    ).toEqual({
      name: '@example/tool',
      version: '1.2.3',
      license: 'Custom: LICENSE.md',
      homepage: 'https://github.com/example/tool',
      author: 'Example Team'
    });
  });

  test('applies package overrides while preserving multi-license manifests', () => {
    expect([
      licensePackageFromManifest({
        name: '@dicebear/styles',
        version: '10.0.0',
        license: 'unknown'
      }),
      licensePackageFromManifest({
        name: 'dual-license',
        version: '2.0.0',
        licenses: [{ type: 'MIT' }, 'Apache-2.0']
      })
    ]).toEqual([
      { name: '@dicebear/styles', version: '10.0.0', license: 'MIT' },
      { name: 'dual-license', version: '2.0.0', license: 'MIT OR Apache-2.0' }
    ]);
  });
});
