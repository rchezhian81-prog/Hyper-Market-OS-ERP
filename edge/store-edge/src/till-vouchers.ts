// The store computer's coupons and gift cards for its tills (W3 · D06-FR-03 · OB-673 · D07-FR-04 · OB-677 · §31 · hard
// rules #1 #2 #10 · P-01 · P-08).
//
// Head office's copy rides the signed store pack (`coupons`, `giftCards`); what the tills did since is read back from this
// box's own sale log at boot and noted as each sale is saved — nothing kept separately that could disagree with the log, so
// a restart with the cable out forgets no redemption. A sale that spends a gift card is decided and saved one at a time on
// this box (`serialise`), so two tills cannot both spend a card's last rupees between the check and the disk. The rules are
// the pure ones in packages/loyalty/src/till-vouchers.ts.

import {
  readCouponPack, readGiftCardPack, vouchersOfSaleRecord, giftCardAvailable, assessGiftCardTenders, assessGiftCardSale, couponForTill,
  type LocalVoucherUses, type LocalGiftCardSpend, type LocalGiftCardSold, type GiftCardAvailability, type CouponForTill, type VoucherCheck,
  type CouponPack, type GiftCardPack,
} from '../../../packages/loyalty/src/till-vouchers';
import type { Redemption } from '../../../packages/loyalty/src/coupons';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

export interface TillVouchersSource {
  /** The pack's `coupons` section and `giftCards` section as this box holds them now, and when that pack arrived. */
  readonly sections: () => { readonly coupons?: unknown; readonly giftCards?: unknown; readonly receivedAt: string | null };
  /** Whether this box can reach head office now (OB-677: the offline limit applies only while it cannot). */
  readonly linkUp: () => boolean;
  /** The shop's IANA zone (the store pack's) — a card's expiry is judged on the shop's date. */
  readonly timeZone: () => string | undefined;
  readonly now?: () => string;
}

export class TillVouchers {
  private readonly spends: LocalGiftCardSpend[] = [];
  private readonly sold: LocalGiftCardSold[] = [];
  private readonly couponUses: Redemption[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly source: TillVouchersSource) {}

  /** Restore what the tills did from the saved sales (each a raw sale-log record). */
  static open(source: TillVouchersSource, saleRecords: readonly string[]): TillVouchers {
    const v = new TillVouchers(source);
    for (const raw of saleRecords) {
      try { v.note(JSON.parse(raw) as unknown); } catch { /* an unreadable record holds no voucher this box can vouch for */ }
    }
    return v;
  }

  private now(): string { return this.source.now?.() ?? new Date().toISOString(); }
  private uses(): LocalVoucherUses { return { spends: this.spends, sold: this.sold, couponUses: this.couponUses }; }
  private today(): string { return shopDateIn(this.now(), this.source.timeZone()); }

  couponPack(): CouponPack | undefined {
    const s = this.source.sections();
    return readCouponPack(s.coupons, s.receivedAt ?? this.now());
  }
  giftCardPack(): GiftCardPack | undefined {
    const s = this.source.sections();
    return readGiftCardPack(s.giftCards, s.receivedAt ?? this.now());
  }
  linkUp(): boolean { return this.source.linkUp(); }

  /** A coupon as the till may judge it, for the customer this bill names (their member code stays on this box). */
  coupon(code: string, memberRef?: string, isMember?: boolean): CouponForTill {
    return couponForTill({ pack: this.couponPack(), code, uses: this.uses(), ...(memberRef === undefined ? {} : { memberRef }), ...(isMember === undefined ? {} : { isMember }), now: this.now() });
  }

  /** What this till may take from a gift card now. */
  giftCard(code: string, laneId: string): GiftCardAvailability {
    return giftCardAvailable({ pack: this.giftCardPack(), code, uses: this.uses(), laneId, linkUp: this.linkUp(), today: this.today() });
  }

  /** A sale's gift-card tenders, decided before the disk; the record comes back stamped (taken offline or not). */
  checkTenders(record: Record<string, unknown>, laneId: string): VoucherCheck {
    return assessGiftCardTenders({ record, pack: this.giftCardPack(), uses: this.uses(), laneId, linkUp: this.linkUp(), today: this.today() });
  }

  /** A gift card's sale, decided before the disk. */
  checkSale(record: Record<string, unknown>): VoucherCheck {
    return assessGiftCardSale({ record, pack: this.giftCardPack(), uses: this.uses() });
  }

  /** What a sale now on the disk did. A re-sent sale is not counted twice. */
  note(record: unknown): void {
    const u = vouchersOfSaleRecord(record);
    for (const s of u.spends) if (!this.spends.some((x) => x.movementId === s.movementId)) this.spends.push(s);
    for (const s of u.sold) if (!this.sold.some((x) => x.code === s.code && x.saleId === s.saleId)) this.sold.push(s);
    for (const r of u.couponUses) if (!this.couponUses.some((x) => x.redemptionId === r.redemptionId)) this.couponUses.push(r);
  }

  /** Run one gift-card decide-and-save alone on this box. */
  serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
