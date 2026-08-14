import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DeviceCatalog } from '../../src/device-catalog.js';
import type { RestApiClient, TestingBotDevice } from '../../src/rest-api.js';

const devices: TestingBotDevice[] = [
  { id: 1, name: 'Galaxy S23', platform_name: 'Android', version: '13' },
  { id: 2, name: 'Pixel 8', platform_name: 'Android', version: '14' },
  { id: 3, name: 'iPhone 15', platform_name: 'iOS', version: '17.4' },
];

function fakeApi(available = devices) {
  return {
    getDevices: vi.fn(async () => available),
    getDevice: vi.fn(async (id: string | number) => devices.find((d) => String(d.id) === String(id))),
  } as unknown as RestApiClient & { getDevices: ReturnType<typeof vi.fn> };
}

describe('DeviceCatalog.pickRealDevice', () => {
  it('filters by platform, name pattern and osVersion expression', async () => {
    const catalog = new DeviceCatalog(fakeApi());
    const pick = await catalog.pickRealDevice(
      { platform: 'android', deviceNamePattern: 'pixel', osVersion: '>=14' },
      new Map(),
    );
    expect(pick).toEqual({ deviceName: 'Pixel 8', platformVersion: '14' });
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
