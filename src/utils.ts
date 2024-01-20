import { toNumber } from '@whiskeysockets/baileys';
import { randomBytes } from 'crypto';
import fs from 'fs';
import { curve } from 'libsignal';
import Long from 'long';
import { v4 } from 'uuid';
import {
  KeyPair,
  MakeSerializedPrisma,
  MakeTransformedPrisma,
  valueReplacer,
  valueReviver,
} from './Types';

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const generateKeyPair = () => {
  const { pubKey, privKey } = curve.generateKeyPair();
  return {
    private: Buffer.from(privKey),
    public: Buffer.from(pubKey.slice(1)),
  };
};

const generateSignalPubKey = (pubKey: Uint8Array) => {
  return pubKey.length === 33 ? pubKey : Buffer.concat([Buffer.from([5]), pubKey]);
};

const sign = (privateKey: object, buf: Uint8Array) => {
  return curve.calculateSignature(privateKey, buf);
};

const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
  const preKey = generateKeyPair();
  const pubKey = generateSignalPubKey(preKey.public);
  const signature = sign(identityKeyPair.private, pubKey);
  return { keyPair: preKey, signature, keyId };
};

export const BufferJSON = {
  replacer: (_: string, value: valueReplacer) => {
    if (value?.type === 'Buffer' && Array.isArray(value?.data)) {
      return {
        type: 'Buffer',
        data: Buffer.from(value?.data).toString('base64'),
      };
    }
    return value;
  },
  reviver: (_: string, value: valueReviver) => {
    if (value?.type === 'Buffer') {
      return Buffer.from(value?.data, 'base64');
    }
    return value;
  },
};

export const initAuthCreds = () => {
  const identityKey = generateKeyPair();
  return {
    noiseKey: generateKeyPair(),
    pairingEphemeralKeyPair: generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: signedKeyPair(identityKey, 1),
    registrationId: Uint16Array.from(randomBytes(2))[0] & 16383,
    advSecretKey: randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: {
      unarchiveChats: false,
    },
    deviceId: Buffer.from(v4().replace(/-/g, ''), 'hex').toString('base64url'),
    phoneId: v4(),
    identityId: randomBytes(20),
    backupToken: randomBytes(20),
    registered: false,
    registration: {},
    pairingCode: undefined,
  };
};

/** Transform object props value into Prisma-supported types */
export function transformPrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeTransformedPrisma<T> {
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Uint8Array) {
      obj[key] = Buffer.from(val);
    } else if (typeof val === 'number' || val instanceof Long) {
      obj[key] = toNumber(val);
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

/** Transform prisma result into JSON serializable types */
export function serializePrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeSerializedPrisma<T> {
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Buffer) {
      obj[key] = val.toJSON();
    } else if (typeof val === 'bigint' || val instanceof BigInt) {
      obj[key] = val.toString();
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

export const debugEvents = (socket, events) => {
  //   make sure that "debug" folder exists
  const folderPath = `${__dirname}/debug`;
  fs.mkdirSync(folderPath, { recursive: true });

  // log every event in it's own file in append mode
  events.forEach((event) => {
    socket.on(event, (data) => {
      let filePath = `${folderPath}/${event}.json`;
      let i = 1;

      while (fs.existsSync(filePath)) {
        filePath = `${folderPath}/${event}-${i}.json`;
        i++;
      }

      fs.appendFileSync(filePath, JSON.stringify(data, BufferJSON.replacer, 2));
    });
  });
};
