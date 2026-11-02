import { create } from 'zustand';

export interface UserProfile {
  email: string;
  name: string;
  picture?: string;
  sub: string;
}

interface AuthState {
  user: UserProfile | null;
  accessToken: string | null;
  tokenExpiresAt: number | null;
  isDriveAuthorized: boolean;
  isLoading: boolean;
  error: string | null;

  setUser: (user: UserProfile | null) => void;
  setAccessToken: (token: string | null, expiresInSeconds?: number) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  tokenExpiresAt: null,
  isDriveAuthorized: false,
  isLoading: false,
  error: null,

  setUser: (user) => set({ user }),
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
  signOut: () => set({
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
    isDriveAuthorized: false,
    error: null,
  }),
}));
