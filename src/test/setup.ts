import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';
import { setActiveAccount } from '../lib/indexeddb/cache';

// Set default test account partition
setActiveAccount('test_default');

// Global mocks for testing environment
if (typeof window !== 'undefined') {
  // Mock navigator.storage.persist
  if (!navigator.storage) {
    Object.defineProperty(navigator, 'storage', {
      value: {
        persist: async () => true,
        persisted: async () => true,
        estimate: async () => ({ quota: 1000000000, usage: 10000 }),
      },
      writable: true,
    });
  }
}
