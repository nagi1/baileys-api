import type { Boom } from '@hapi/boom';
import makeWASocket, {
    BaileysEventMap,
    Browsers,
    ConnectionState,
    DisconnectReason,
    isJidBroadcast,
    makeCacheableSignalKeyStore,
    proto,
    SocketConfig,
} from '@whiskeysockets/baileys';
import { Response } from 'express';
import NodeCache from 'node-cache';
import ProxyAgent from 'proxy-agent';
import { toDataURL } from 'qrcode';
import type { WebSocket } from 'ws';
import { useLogger, usePrisma } from './shared';
import { Store } from './store';
import { useSession } from './useSession';
import { delay, pick, response, sendWebhook } from './utils';
import { sessions, SESSION_CONFIG_ID } from './whatsappInit';

export const retries = new Map<string, number>();
export const QRGenerations = new Map<string, number>();

export const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL || 0);
export const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES || 5);
export const MAX_QR_GENERATION = Number(process.env.MAX_QR_GENERATION || 5);

export type SessionOptions = {
    sessionId: string;
    res?: Response;
    SSE?: boolean;
    readIncomingMessages?: boolean;
    proxy?: string;
    webhook?: {
        enabled: boolean;
        url: string | string[] | null;
        events: 'all' | (keyof BaileysEventMap)[];
    };
    socketConfig?: SocketConfig;
    usePairingCode?: boolean;
    phoneNumber?: string;
};

export function shouldReconnect(sessionId: string) {
    const maxRetries = parseInt(process.env.MAX_RECONNECT_RETRIES) || 5;
    let attempts = retries.get(sessionId) ?? 0;

    if (attempts < MAX_RECONNECT_RETRIES || maxRetries === -1) {
        attempts = attempts + 1;

        useLogger().info({ attempts, sessionId }, 'Reconnecting...');

        retries.set(sessionId, attempts);

        return true;
    }

    return false;
}

export class Session {
    private connectionState: Partial<ConnectionState> = { connection: 'close' };
    private lastGeneratedQR: string | null = null;
    public readonly socket: ReturnType<typeof makeWASocket>;
    public readonly store: Store;

    constructor(
        private readonly sessionState: Awaited<ReturnType<typeof useSession>>,
        private readonly options: SessionOptions
    ) {
        const { sessionId, socketConfig, proxy } = options;

        this.socket = makeWASocket({
            printQRInTerminal: true,
            browser: Browsers.ubuntu('Chrome'),
            generateHighQualityLinkPreview: true,
            ...socketConfig,
            logger: useLogger(),
            agent: proxy ? new ProxyAgent() : undefined,
            msgRetryCounterCache: new NodeCache({ stdTTL: 60, checkperiod: 120 }),
            auth: {
                creds: sessionState.state.creds,
                keys: makeCacheableSignalKeyStore(sessionState.state.keys, useLogger()),
            },
            shouldIgnoreJid: (jid) => isJidBroadcast(jid),
            getMessage: async (key) => {
                const data = await usePrisma().message.findFirst({
                    where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
                });

                return (data?.message || undefined) as proto.IMessage | undefined;
            },
        });

        this.bindEvents();
        this.store = new Store(sessionId, this.socket.ev);
        sessions.set(sessionId, this);
    }

    public static async create(options: SessionOptions) {
        const {
            sessionId,
            readIncomingMessages = false,
            proxy,
            webhook,
            socketConfig,
            usePairingCode,
            phoneNumber,
        } = options;

        const configID = `${SESSION_CONFIG_ID}-${sessionId}`;

        const data = JSON.stringify({
            usePairingCode,
            phoneNumber,
            readIncomingMessages,
            proxy,
            webhook,
            ...socketConfig,
        });

        const [sessionState, _]: [Awaited<ReturnType<typeof useSession>>, any] = await Promise.all([
            useSession(sessionId),
            usePrisma().session.upsert({
                create: {
                    id: configID,
                    sessionId,
                    data,
                },
                update: { data },
                where: { sessionId_id: { id: configID, sessionId } },
            }),
        ]);

        return new Session(sessionState, options);
    }

    public static list() {
        return Array.from(sessions.entries()).map(([id, session]) => ({
            id,
            status: session.status(),
        }));
    }

    public static get(sessionId: string) {
        return sessions.get(sessionId) ?? null;
    }

    public static async delete(sessionId: string) {
        await Session.get(sessionId)?.destroy();
    }

    public static exists(sessionId: string) {
        return sessions.has(sessionId);
    }

    public QR() {
        return this.lastGeneratedQR;
    }

    public status() {
        const state = ['CONNECTING', 'CONNECTED', 'DISCONNECTING', 'DISCONNECTED'];
        let status = state[(this.socket.ws as WebSocket).readyState];
        status = this.socket.user ? 'AUTHENTICATED' : status;
        return status;
    }

    public async jidExists(jid: string, type: 'group' | 'number' = 'number') {
        try {
            if (type === 'number') {
                const [result] = await this.socket.onWhatsApp(jid);
                return !!result?.exists;
            }

            const groupMetadata = await this.socket.groupMetadata(jid);
            return !!groupMetadata.id;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    public async destroy(logout = true) {
        const { sessionId } = this.options;
        const ws = this.socket.ws;
        try {
            await Promise.all([
                logout && ws.readyState !== ws.CLOSING && ws.readyState !== ws.CLOSED && this.socket.logout(),
                usePrisma().session.deleteMany({ where: { sessionId } }),
                // usePrisma().chat.deleteMany({ where: { sessionId } }),
                // usePrisma().contact.deleteMany({ where: { sessionId } }),
                // usePrisma().message.deleteMany({ where: { sessionId } }),
            ]);

            useLogger().info(`Session ${sessionId} destroyed`);
        } catch (e) {
            useLogger().error(e, 'An error occured during session destroy');
        } finally {
            sessions.delete(sessionId);
            retries.delete(sessionId);
            QRGenerations.delete(sessionId);
        }
    }

    private async bindEvents() {
        const { sessionId, readIncomingMessages, webhook } = this.options;

        process.on('uncaughtException', async (error) => {
            useLogger().error(error, 'Uncaught Exception');

            this.reconnect();
        });

        process.on('unhandledRejection', async (reason, promise) => {
            useLogger().error({ promise, reason }, 'Unhandled Rejection');
        });

        this.socket.ev.on('creds.update', this.sessionState.saveCreds);

        this.socket.ev.on('connection.update', async (update) => {
            this.connectionState = update;

            const { connection } = update;

            if (connection) useLogger().info('Connection Status: ' + connection);

            if (connection === 'open') {
                this.lastGeneratedQR = null;
                retries.delete(sessionId);
                QRGenerations.delete(sessionId);

                useLogger().info('Session ' + sessionId + ' created');
            } else if (connection === 'close') await this.handleConnectionClose();

            this.handleConnectionUpdate();
        });

        if (readIncomingMessages) {
            this.socket.ev.on('messages.upsert', async (messageEvent) => {
                const message = messageEvent.messages[0];

                if (message.key.fromMe || messageEvent.type !== 'notify') return;

                await delay(1000);
                await this.socket.readMessages([message.key]);
            });
        }

        if (webhook?.enabled) {
            const { url: webhookUrls, events } = webhook;

            const url = webhookUrls ?? process.env.WEBHOOK_URL ?? null;

            if (!url?.length) {
                useLogger().warn('No webhook url provided');
                return;
            }

            this.socket.ev.process(async (socketEvents) => {
                let eventData = events === 'all' ? socketEvents : pick(socketEvents, events);

                if (Object.keys(eventData).length <= 0) return;

                const data = {
                    ...eventData,
                    session: sessionId,
                };

                try {
                    await Promise.any((typeof url === 'string' ? [url] : url).map((url) => sendWebhook(url, data)));
                } catch (e) {
                    useLogger().error(e, 'An error occured during webhook request');
                }
            });
        }
    }

    private async handleConnectionUpdate() {
        const { sessionId, res, SSE, usePairingCode = false, phoneNumber = null } = this.options;

        if (
            usePairingCode &&
            phoneNumber &&
            !this.sessionState.state.creds.registered &&
            !this.sessionState.state.creds.account
        ) {
            await this.socket.waitForConnectionUpdate((update) => Boolean(update.qr));
            const code = await this.socket.requestPairingCode(phoneNumber);

            if (res && !res.headersSent && code !== undefined) {
                return response(res, 200, true, 'Verify on your phone and enter the provided code.', { code });
            } else {
                useLogger().error(`Unable to send pairing code to phone number ${phoneNumber}`);

                response(res, 500, false, 'Unable to create session.');
            }
        }

        const { qr } = this.connectionState;
        let generatedQR: string | null = null;
        const currentQRGenerations = QRGenerations.get(sessionId) ?? -1;

        if (qr) {
            try {
                generatedQR = await toDataURL(qr);
                this.lastGeneratedQR = generatedQR;
                QRGenerations.set(sessionId, currentQRGenerations + 1);
            } catch (e) {
                useLogger().error(e, 'An error occured during QR generation');
            }
        }

        const limitReached = currentQRGenerations >= MAX_QR_GENERATION;

        if (limitReached) this.destroy();

        if (!res || res.writableEnded) return;

        if (SSE) {
            res.write(
                `data: ${JSON.stringify(
                    limitReached
                        ? { error: 'QR max generation attempts reached' }
                        : { ...this.connectionState, qr: generatedQR }
                )}\n\n`
            );
            if (limitReached) res.end();
        } else {
            if (limitReached) res.status(500).json({ error: 'QR max generation attempts reached' }).end();
            else if (!limitReached && qr && generatedQR) res.status(200).json({ qr: generatedQR });
            else if (!limitReached && qr && !generatedQR) res.status(500).json({ error: 'Unable to generate QR' });
        }
    }

    private async handleConnectionClose() {
        const { sessionId, res, SSE } = this.options;
        const reasonCode = (this.connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;

        switch (reasonCode) {
            case DisconnectReason.badSession:
                useLogger().error(`Bad Session, Please Delete /auth and Scan Again`);
                break;
            case DisconnectReason.connectionClosed:
                useLogger().warn('Connection closed, reconnecting....');
                break;
            case DisconnectReason.connectionLost:
                useLogger().warn('Connection Lost from Server, reconnecting...');
                break;
            case DisconnectReason.connectionReplaced:
                useLogger().error(
                    'Connection Replaced, Another New Session Opened, Please Close Current Session First'
                );
                break;
            case DisconnectReason.loggedOut:
                useLogger().error(`Device Logged Out, Please Delete /auth and Scan Again.`);
                break;
            case DisconnectReason.restartRequired:
                useLogger().info('Restart Required, Restarting...');
                break;
            case DisconnectReason.timedOut:
                useLogger().warn('Connection TimedOut, Reconnecting...');
                break;
            default:
                useLogger().warn(`Unknown DisconnectReason: ${reasonCode}: ${this.connectionState.connection}`);
                break;
        }

        const doNotReconnect = !shouldReconnect(sessionId);

        if (reasonCode === DisconnectReason.loggedOut || doNotReconnect) {
            if (res && !res.writableEnded) {
                !SSE && res.status(500).json({ error: 'Unable to create session' });
                res.end();
            }

            return await this.destroy(doNotReconnect);
        }

        this.reconnect();
    }

    public reconnect() {
        const reasonCode = (this.connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
        const restartRequired = reasonCode === DisconnectReason.restartRequired;

        setTimeout(() => Session.create(this.options), restartRequired ? 0 : RECONNECT_INTERVAL);
    }
}
