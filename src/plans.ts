/**
 * Plans, limits and paying for them. Money goes through CoinPay, crypto only:
 * write the payment down as pending before the buyer leaves, verify the
 * webhook over the raw bytes, and only a settled status grants.
 *
 * A lapsed plan never switches anything off. A dead man's switch that quietly
 * stops protecting someone because a renewal was missed is the one failure
 * this product cannot have, so existing switches keep running on free
 * channels; only new switches, bigger bundles and phone calls need a plan.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, User } from './db.js'

export type Limits = { switches: number; recipients: number; bundleBytes: number; calls: boolean }
export const FREE: Limits = { switches: 1, recipients: 2, bundleBytes: 64 * 1024, calls: false }
export const PRO: Limits = { switches: 10, recipients: 10, bundleBytes: 5 * 1024 * 1024, calls: true }

export type Product = 'year' | 'lifetime'
export const PRODUCTS: Record<Product, { label: string; cents: number }> = {
  year: { label: 'Keeper, one year', cents: Number(process.env.PRICE_YEAR_USD ?? 49) * 100 },
  lifetime: { label: 'Keeper, for life', cents: Number(process.env.PRICE_LIFETIME_USD ?? 149) * 100 },
}

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type PlanConfig = { coinpay: CoinPay | null; chains: string[]; admins: Set<string> }

export const DEFAULT_CHAINS = ['USDC_SOL', 'USDC_POL', 'USDC_ETH', 'USDT_POL', 'BTC', 'ETH', 'SOL', 'POL', 'DOGE', 'BCH', 'XRP', 'ADA', 'BNB']
export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDT_POL: 'USDT on Polygon',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
}

export function planConfig(env: Record<string, string | undefined> = process.env): PlanConfig {
  const chains = (env.COINPAY_CHAINS ?? '').split(/[\s,]+/).filter(Boolean)
  return {
    coinpay:
      env.COINPAY_API_KEY && env.COINPAY_BUSINESS_ID
        ? {
            baseUrl: (env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''),
            apiKey: env.COINPAY_API_KEY,
            businessId: env.COINPAY_BUSINESS_ID,
            webhookSecret: env.COINPAY_WEBHOOK_SECRET ?? '',
          }
        : null,
    chains: chains.length ? chains : DEFAULT_CHAINS,
    admins: new Set((env.ADMIN_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)),
  }
}

export function isPaid(cfg: PlanConfig, user: User, now = Date.now()): boolean {
  if (cfg.admins.has(user.email)) return true
  if (user.plan === 'lifetime') return true
  return user.plan === 'pro' && Boolean(user.plan_until && user.plan_until.getTime() > now)
}

export const limitsFor = (cfg: PlanConfig, user: User) => (isPaid(cfg, user) ? PRO : FREE)

export function planLabel(cfg: PlanConfig, user: User): string {
  if (cfg.admins.has(user.email)) return 'Keeper (admin)'
  if (user.plan === 'lifetime') return 'Keeper, for life'
  if (isPaid(cfg, user)) return `Keeper, until ${user.plan_until!.toISOString().slice(0, 10)}`
  return 'Free'
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

/** Start a crypto payment; returns CoinPay's checkout page. */
export async function startCheckout(
  cfg: PlanConfig,
  store: Store,
  args: { user: User; product: Product; chain: string; successUrl: string; cancelUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<{ checkoutUrl: string; ref: string }> {
  if (!cfg.coinpay) throw new Error('payments are not set up on this server yet')
  if (!cfg.chains.includes(args.chain)) throw new Error('pick a currency from the list')
  const product = PRODUCTS[args.product]
  if (!product) throw new Error('pick a plan')
  const res = await fetcher(`${cfg.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: cfg.coinpay.businessId,
      amount: product.cents / 100,
      currency: 'USD',
      blockchain: args.chain,
      payment_method: 'crypto',
      description: `deadman.switch ${product.label}`,
      metadata: { user_id: args.user.id, product: args.product },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  // { success, payment: {...} }: the id is nested, not body.id.
  const payment = body?.payment ?? body
  const ref = payment?.id ?? payment?.payment_id
  if (!ref) throw new Error('CoinPay returned no payment reference')
  // Written before the buyer leaves: a webhook can beat the redirect.
  await store.recordPayment({ ref: String(ref), user_id: args.user.id, product: args.product, amount_cents: product.cents, chain: args.chain, raw: body })
  return { checkoutUrl: `${cfg.coinpay.baseUrl}/pay/${ref}`, ref: String(ref) }
}

/** `t=<unix>,v1=<hex hmac of "t.rawBody">`, within five minutes. */
export function verifyWebhook(secret: string, rawBody: string, header: string | null | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > 300) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex'), 'hex')
  const given = Buffer.from(String(parts.v1), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const SETTLED = new Set(['paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled'])

/** The live webhook is { id: "evt_…", type, data: { payment_id, status, metadata } }; the top-level id is the event. */
export function readWebhook(payload: any): { ref: string | null; status: string } {
  const data = payload?.data ?? payload
  return { ref: data?.payment_id ?? data?.id ?? null, status: String(data?.status ?? '').toLowerCase() }
}
