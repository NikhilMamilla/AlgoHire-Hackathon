import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib.js';

export type OutgoingMessage = { to: string; body: string; idempotencyKey: string };

export interface WhatsAppProvider {
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

export class ProviderError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Simulated WhatsApp provider. OutboundMessage is its own "sent messages" store; sends are idempotent
 * on idempotencyKey, like a real provider's idempotency header.
 * Per send, `random` is drawn once for latency, then (flaky mode only) once for the outcome.
 */
export class SimulatedWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private opts: { mode?: 'flaky' | 'healthy' | 'down'; random?: () => number; latencyMs?: [number, number]; slowMs?: number } = {},
  ) {}

  async send(msg: OutgoingMessage) {
    const random = this.opts.random ?? Math.random;
    const [min, max] = this.opts.latencyMs ?? [100, 600];
    await sleep(min + random() * (max - min));

    const mode = this.opts.mode ?? config.whatsappMode;
    if (mode === 'down') throw new ProviderError('503 upstream unavailable');
    if (mode === 'flaky') {
      const r = random();
      if (r < 0.25) throw new ProviderError('503 upstream unavailable');
      if (r < 0.35) {
        // Accepted but slow: the message IS sent, but the answer arrives after the caller's timeout.
        const sent = await this.record(msg);
        await sleep(this.opts.slowMs ?? 6000);
        return sent;
      }
    }
    return this.record(msg);
  }

  private async record(msg: OutgoingMessage) {
    const where = { idempotencyKey: msg.idempotencyKey };
    try {
      const m = await prisma.outboundMessage.upsert({
        where,
        update: {},
        create: { ...msg, providerMessageId: `wamid.${randomUUID()}` },
      });
      return { providerMessageId: m.providerMessageId };
    } catch (e) {
      // Two concurrent upserts can both try the insert; the loser reads the winner's message.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { providerMessageId: (await prisma.outboundMessage.findUniqueOrThrow({ where })).providerMessageId };
      }
      throw e;
    }
  }
}
