import { NoDeviceAvailableError, osVersionSatisfies, type AllocationCriteria, type DeviceInfo, type Platform } from '@mobilewright/protocol';
import type { PinnedDevice } from './capabilities.js';
import type { RestApiClient, TestingBotDevice } from './rest-api.js';

/** How long a fetched device list stays fresh. The device pool retries
 *  NoDeviceAvailableError in a loop; without this cache those retries would
 *  eat into TestingBot's REST rate limit (2000 requests / 5 min). */
const CACHE_TTL_MS = 10_000;

export class DeviceCatalog {
  private readonly api: RestApiClient;
  private cache: { devices: TestingBotDevice[]; fetchedAt: number } | undefined;

  constructor(api: RestApiClient) {
    this.api = api;
  }

  /**
   * Pick a concrete real device matching the criteria, for pinning into
   * `appium:deviceName`/`appium:platformVersion`. Throws NoDeviceAvailableError
   * when nothing currently matches (the pool treats that as "retry later").
   * `pinCounts` refcounts device names pinned by this run's other slots; the
   * pick is registered in it synchronously (no await between choosing and
   * reserving), so concurrent allocates spread across devices instead of
   * racing for the same one. The caller decrements on release/failure.
   */
  async pickRealDevice(criteria: AllocationCriteria, pinCounts: Map<string, number>): Promise<PinnedDevice> {
    const devices = await this.getAvailable();
    const matching = devices.filter((d) => matches(d, criteria));
    if (matching.length === 0) {
      this.cache = undefined; // refetch on the pool's next retry
      throw new NoDeviceAvailableError(
        `No available TestingBot real device matches ${describeCriteria(criteria)}.`,
      );
    }
    const preferred = matching.find((d) => !pinCounts.has(d.name)) ?? matching[0]!;
    pinCounts.set(preferred.name, (pinCounts.get(preferred.name) ?? 0) + 1);
    return { deviceName: preferred.name, platformVersion: String(preferred.version) };
  }

  /** Resolve a user-pinned physical device id to its name/version. */
  async resolveDeviceId(deviceId: string): Promise<PinnedDevice> {
    const device = await this.api.getDevice(deviceId);
    if (!device?.name) {
      throw new Error(`TestingBot device id "${deviceId}" was not found (GET /devices/${deviceId}).`);
    }
    return { deviceName: device.name, platformVersion: String(device.version) };
  }

  /** All physical devices mapped to the protocol's DeviceInfo shape. */
  async listDevices(platform?: Platform): Promise<DeviceInfo[]> {
    const [all, available] = await Promise.all([
      this.api.getDevices(false),
      this.api.getDevices(true),
    ]);
    const availableIds = new Set(available.map((d) => d.id));
    return all
      .filter((d) => !platform || toPlatform(d) === platform)
      .map((d) => ({
        id: String(d.id),
        name: d.name,
        platform: toPlatform(d),
        type: 'real' as const,
        state: availableIds.has(d.id) ? ('online' as const) : ('offline' as const),
        model: d.model_number,
        osVersion: String(d.version),
      }));
  }

  private async getAvailable(): Promise<TestingBotDevice[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.devices;
    }
    const devices = await this.api.getDevices(true);
    this.cache = { devices, fetchedAt: now };
    return devices;
  }
}

function matches(device: TestingBotDevice, criteria: AllocationCriteria): boolean {
  if (criteria.platform && toPlatform(device) !== criteria.platform) return false;
  if (criteria.deviceNamePattern && !new RegExp(criteria.deviceNamePattern, 'i').test(device.name)) return false;
  if (criteria.osVersion && !osVersionSatisfies(String(device.version), criteria.osVersion)) return false;
  return true;
}

function toPlatform(device: TestingBotDevice): Platform {
  return device.platform_name?.toLowerCase() === 'ios' ? 'ios' : 'android';
}

function describeCriteria(criteria: AllocationCriteria): string {
  const parts: string[] = [];
  if (criteria.platform) parts.push(`platform=${criteria.platform}`);
  if (criteria.deviceNamePattern) parts.push(`name~/${criteria.deviceNamePattern}/`);
  if (criteria.osVersion) parts.push(`osVersion "${criteria.osVersion}"`);
  return parts.length ? parts.join(', ') : 'any criteria';
}
