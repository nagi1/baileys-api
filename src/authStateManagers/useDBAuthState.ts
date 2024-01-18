import { proto } from '@whiskeysockets/baileys';
import { AuthStateManager, AuthStateManagerConfig } from '../authStateManager';
import { prisma } from '../shared';
import { AuthenticationCreds } from '../Types';
import { BufferJSON, initAuthCreds } from '../utils';

export const useDBAuthState = async (config: AuthStateManagerConfig): Promise<AuthStateManager> => {
  const session = config.sessionName;

  const readData = async (id: string) => {
    const data = await prisma.auth.findMany({
      select: { value: true },
      where: { id, session },
      take: 1,
    });

    if (!data[0]?.value) {
      return null;
    }

    const creds = JSON.stringify(data[0].value);
    return JSON.parse(creds, BufferJSON.reviver);
  };

  const writeData = async (id: string, value: object) => {
    const valueFixed = JSON.stringify(value, BufferJSON.replacer);

    // Todo convert this to upsert
    await prisma.$executeRaw`INSERT INTO auth (value, id, session) VALUES (${valueFixed}, ${id}, ${session}) ON DUPLICATE KEY UPDATE value = ${valueFixed}`;
  };

  const removeData = async (id: string) => {
    await prisma.auth.deleteMany({ where: { id, session } });
  };

  const removeAll = async () => {
    await prisma.auth.deleteMany({ where: { session } });
  };

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: Array<string>) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data: Array<object>) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const name = `${category}-${id}`;
              if (value) {
                await writeData(name, value);
              } else {
                await removeData(name);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    removeCreds: async () => {
      await removeAll();
    },
  };
};
