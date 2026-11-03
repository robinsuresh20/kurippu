import { create } from 'zustand';

export interface UserProfile {
  email: string;
  name: string;
  picture?: string;
  sub: string;
}

export type StorageMode = 'drive' | 'mock';

interface AuthState {
  user: UserProfile | null;
  storageMode: StorageMode;
  accessToken: string | null;
  tokenExpiresAt: number | null;
  isDriveAuthorized: boolean;
  isLoading: boolean;
  error: string | null;

  setUser: (user: UserProfile | null) => void;
  setStorageMode: (mode: StorageMode) => void;
  setAccessToken: (token: string | null, expiresInSeconds?: number) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  signOut: () => void;
}

const getInitialUser = (): UserProfile | null => {
  try {
    const saved = localStorage.getItem('kurippu_user_profile');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
};

const getInitialStorageMode = (): StorageMode => {
  try {
    const saved = localStorage.getItem('kurippu_storage_mode');
    if (saved === 'drive' || saved === 'mock') return saved;
    if (localStorage.getItem('kurippu_gcp_client_id')) return 'drive';
    return 'mock';
  } catch {
    return 'mock';
  }
};

export const useAuthStore = create<AuthState>((set) => ({
  user: getInitialUser(),
  storageMode: getInitialStorageMode(),
  accessToken: null,
  tokenExpiresAt: null,
  isDriveAuthorized: false,
  isLoading: false,
  error: null,

  setUser: (user) => {
    if (user) {
      try {
        localStorage.setItem('kurippu_user_profile', JSON.stringify(user));
      } catch (err) {
        console.warn('Failed to save user profile to localStorage', err);
      }
    } else {
      localStorage.removeItem('kurippu_user_profile');
    }
    set({ user });
  },

  setStorageMode: (mode: StorageMode) => {
    try {
      localStorage.setItem('kurippu_storage_mode', mode);
    } catch (err) {
      console.warn('Failed to save storage mode to localStorage', err);
    }
    set({ storageMode: mode });
  },

  setAccessToken: (token, expiresInSeconds = 3600) => {
    if (!token) {
      set({ accessToken: null, tokenExpiresAt: null, isDriveAuthorized: false });
      return;
    }
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    set({
      accessToken: token,
      tokenExpiresAt: expiresAt,
      isDriveAuthorized: true,
      error: null,
    });
  },

  setError: (error) => set({ error }),
  setLoading: (isLoading) => set({ isLoading }),

  signOut: () => {
    localStorage.removeItem('kurippu_user_profile');
    set({
      user: null,
      accessToken: null,
      tokenExpiresAt: null,
      isDriveAuthorized: false,
      error: null,
    });
  },
}));
