export interface MockBuild {
  id: string
  name: string
  version: string
  platform: 'ios' | 'android'
  bundleId: string
  label?: string
}

export const MOCK_BUILDS: MockBuild[] = [
  {
    id: 'b1',
    name: 'Acme Shopping',
    version: '2.4.1',
    platform: 'ios',
    bundleId: 'com.acme.shopping',
    label: 'Production',
  },
  {
    id: 'b2',
    name: 'Acme Shopping',
    version: '2.5.0-beta',
    platform: 'ios',
    bundleId: 'com.acme.shopping',
    label: 'Beta',
  },
  {
    id: 'b3',
    name: 'Acme Dashboard',
    version: '1.1.0',
    platform: 'ios',
    bundleId: 'com.acme.dashboard',
    label: 'Staging',
  },
  {
    id: 'b4',
    name: 'Acme Shopping',
    version: '2.4.1',
    platform: 'android',
    bundleId: 'com.acme.shopping',
    label: 'Production',
  },
]
