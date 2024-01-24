import { PrismaClient } from '@prisma/client';
import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { promises as fsPromises } from 'fs';
import pino from 'pino';
import { Session } from './session';
import { useLogger, usePrisma } from './shared';
import { initStore } from './store';

export const sessions = new Map<string, Session>();
export const SESSION_CONFIG_ID = 'session-config';

// initialize logger
// make sure logs/wa.log exists
const logFilePath = `${__dirname}/logs/wa.log`;
fsPromises.mkdir(`${__dirname}/logs`, { recursive: true });
fsPromises.writeFile(logFilePath, '');

const loggerTransport = pino.transport({
    targets: [
        {
            target: 'pino/file',
            options: { destination: logFilePath },
        },
        {
            target: 'pino-pretty',
        },
    ],
});

export async function init() {
    // initialize store (DB) and set logger config
    initStore({
        prisma: new PrismaClient(),
        logger: pino(
            {
                level: process.env.LOG_LEVEL || 'debug',
            },
            loggerTransport
        ) as any,
    });

    // Fetch all sessions from DB
    const sessions = await usePrisma().session.findMany({
        select: { sessionId: true, data: true },
        where: { id: { startsWith: SESSION_CONFIG_ID } },
    });

    // Fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion();
    useLogger().info(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    // Create sessions
    for (const { sessionId, data } of sessions) {
        const { readIncomingMessages, proxy, webhook, usePairingCode, phoneNumber, ...socketConfig } = JSON.parse(data);

        socketConfig.version = version;

        // Create session
        Session.create({ sessionId, readIncomingMessages, proxy, webhook, usePairingCode, phoneNumber, socketConfig });
    }
}
