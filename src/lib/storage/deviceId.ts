import { nanoid } from 'nanoid';

let cachedDeviceId: string | null = null;

/**
 * Returns a stable, persistent device ID for this browser installation.
 * Used to distinguish own sequential uploads from genuine external concurrent edits.
 */
export function getClientDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;

  if (typeof localStorage !== 'undefined') {
    const existing = localStorage.getItem('kurippu_client_device_id');
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
    const newId = `dev_${nanoid(16)}`;
    try {
      localStorage.setItem('kurippu_client_device_id', newId);
    } catch {
      // Ignore storage errors in restricted contexts
    }
    cachedDeviceId = newId;
    return newId;
  }

  if (!cachedDeviceId) {
    cachedDeviceId = `dev_${nanoid(16)}`;
  }
  return cachedDeviceId;
}

/**
 * Helper for unit tests to simulate different devices.
 */
export function setClientDeviceIdForTesting(id: string | null): void {
  cachedDeviceId = id;
  if (typeof localStorage !== 'undefined') {
    if (id) {
      localStorage.setItem('kurippu_client_device_id', id);
    } else {
      localStorage.removeItem('kurippu_client_device_id');
    }
  }
}
