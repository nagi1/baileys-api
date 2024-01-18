import { useDBAuthState } from './authStateManagers/useDBAuthState';
import { AuthenticationCreds } from './Types';

interface AuthStateManagerConfig {
  sessionName: string;
}

type AuthState = {
  creds: AuthenticationCreds;
  keys: {
    get: (type: string, ids: Array<string>) => Promise<object>;
    set: (data: Array<object>) => Promise<void>;
  };
};

type SupportedDrivers = 'database';

interface AuthStateManager {
  state: AuthState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}

const createAuthStateManager = async (
  driver: SupportedDrivers,
  config: AuthStateManagerConfig
): Promise<AuthStateManager> => {
  switch (driver) {
    case 'database':
      return await useDBAuthState(config);
    default:
      throw new Error('Invalid driver');
  }
};

export {
  createAuthStateManager,
  AuthStateManager,
  AuthStateManagerConfig,
  SupportedDrivers,
  AuthState,
};
