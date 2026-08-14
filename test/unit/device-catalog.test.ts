import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DeviceCatalog } from '../../src/device-catalog.js';
import type { RestApiClient, TestingBotDevice } from '../../src/rest-api.js';

const devices: TestingBotDevice[] = [
  { id: 1, name: 'Galaxy S23', platform_name: 'Android', version: '13' },
  { id: 2, name: 'Pixel 8', platform_name: 'Android', version: '14' },
  { id: 3, name: 'iPhone 15', platform_name: 'iOS', version: '17.4' },
];

const browsers = [
  { name: 'chrome', platformName: 'Android', deviceName: 'Pixel 9', version: '16.0' },
  { name: 'chrome', platformName: 'Android', deviceName: 'Galaxy S23', version: '14.0' },
  { name: 'chrome', platformName: 'Android', deviceName: 'ChromeOS Large', version: '16.0' },
  { name: 'safari', platformName: 'iOS', deviceName: 'iPhone 15', version: '17.5' },
  { name: 'safari', platformName: 'iOS', deviceName: 'iPhone 14', version: '16.4' },
  { name: 'safari', platform: 'SEQUOIA', version: '18.0' },
];

function fakeApi(available = devices) {
  return {
    getDevices: vi.fn(async () => available),
    getDevice: vi.fn(async (id: string | number) => devices.find((d) => String(d.id) === String(id))),
    getBrowsers: vi.fn(async () => browsers),
  } as unknown as RestApiClient & { getDevices: ReturnType<typeof vi.fn>; getBrowsers: ReturnType<typeof vi.fn> };
}

describe('DeviceCatalog.pickRealDevice', () => {
  it('filters by platform, name pattern and osVersion expression', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const pick = await catalog.pickRealDevice(
      { platform: 'android', deviceNamePattern: 'pixel', osVersion: '>=14' },
      new Map(),
    );
    expect(pick).toEqual({ deviceName: 'Pixel 8', platformVersion: '14', real: true });
  });

  it('throws NoDeviceAvailableError when nothing matches', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    await expect(
      catalog.pickRealDevice({ platform: 'ios', osVersion: '>=18' }, new Map()),
    ).rejects.toBeInstanceOf(NoDeviceAvailableError);
  });

  it('prefers devices not already pinned by other slots and reserves its pick', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const pins = new Map([['Galaxy S23', 1]]);
    const pick = await catalog.pickRealDevice({ platform: 'android' }, pins);
    expect(pick.deviceName).toBe('Pixel 8');
    expect(pins.get('Pixel 8')).toBe(1);
  });

  it('caches the device list within the TTL', async () => {
    const api = fakeApi();
    const catalog = new DeviceCatalog(api);
    await catalog.pickRealDevice({ platform: 'android' }, new Map());
    await catalog.pickRealDevice({ platform: 'android' }, new Map());
    expect(api.getDevices).toHaveBeenCalledTimes(1);
  });

  it('drops the cache after a miss so the pool retry refetches', async () => {
    const api = fakeApi();
    const catalog = new DeviceCatalog(api);
    await expect(catalog.pickRealDevice({ platform: 'ios', osVersion: '>=18' }, new Map()))
      .rejects.toBeInstanceOf(NoDeviceAvailableError);
    await expect(catalog.pickRealDevice({ platform: 'ios', osVersion: '>=18' }, new Map()))
      .rejects.toBeInstanceOf(NoDeviceAvailableError);
    expect(api.getDevices).toHaveBeenCalledTimes(2);
  });
});

describe('DeviceCatalog.pickVirtualDevice', () => {
  it('resolves osVersion ranges against the simulator/emulator catalog', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const pick = await catalog.pickVirtualDevice({ platform: 'ios', deviceType: 'simulator', osVersion: '>=16 <18' });
    // Newest matching version wins deterministically.
    expect(pick).toEqual({ deviceName: 'iPhone 15', platformVersion: '17.5', real: false });
  });

  it('resolves deviceName regexes and ignores ChromeOS/desktop rows', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const pick = await catalog.pickVirtualDevice({ platform: 'android', deviceNamePattern: 'galaxy.*' });
    expect(pick.deviceName).toBe('Galaxy S23');
    const any = await catalog.pickVirtualDevice({ platform: 'android' });
    expect(any.deviceName).toBe('Pixel 9'); // ChromeOS filtered despite same version
  });

  it('treats no virtual match as a config error, not a retriable shortage', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const attempt = catalog.pickVirtualDevice({ platform: 'ios', osVersion: '>=99' });
    await expect(attempt).rejects.toThrow(/No TestingBot simulator matches/);
    await expect(attempt).rejects.not.toBeInstanceOf(NoDeviceAvailableError);
  });

  it('caches the browsers list', async () => {
    const api = fakeApi();
    const catalog = new DeviceCatalog(api);
    await catalog.pickVirtualDevice({ platform: 'ios' });
    await catalog.pickVirtualDevice({ platform: 'android' });
    expect(api.getBrowsers).toHaveBeenCalledTimes(1);
  });
});
