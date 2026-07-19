# ZeroDrift — TikTok voiceover script (EN)

Source footage: two landscape GIFs in `docs/assets/` — crop to 9:16 per scene in your editor.

- **Part 1** `zerodrift-tiktok-part1.gif` — concept + setup + Avellaneda explained
- **Part 2** `zerodrift-tiktok-part2.gif` — the click, live orders, Perpl exchange view

Timecodes are beats, not hard cuts — pace to your edit. Total ~90s (trim to 60s by
dropping the WHY section if needed).

---

## HOOK · 0:00–0:05 · [P1: terminal wide shot, price ticking]

> I built a bot that farms exchange points with almost zero price risk.
> Let me show you how it works.

## CONCEPT · 0:05–0:20 · [P1: guide page, strategy section]

> The trick is called delta-neutral. I hold MON in my wallet — that's my long.
> Then I short the exact same amount on Perpl, a perp DEX on Monad.
> Price pumps? The short loses, the bag wins. Price dumps? The opposite.
> Net exposure: zero. I don't care where the price goes.

## WHY BOTHER · 0:20–0:32 · [P1: statusbar close-up — funding APR, fees, points]

> So why do it? Three numbers.
> Maker volume farms points on Perpl.
> Funding pays shorts seventeen percent APR right now — I'm the short.
> And maker fees are basically free: zero point nine basis points.

## AVELLANEDA · 0:32–0:48 · [P1: strategy picker → AS panel: QUOTING, ±6.4 bps]

> The engine runs Avellaneda-Stoikov — an actual market-making model
> from a 2008 quant paper.
> It quotes a bid AND an ask around the mid price,
> captures the spread every time both sides fill,
> and skews its quotes to hold the hedge steady.
> This isn't wash trading. It's real two-sided liquidity.

## THE CLICK · 0:48–0:58 · [P2: auto-farm toggle flips on → "2 maker orders resting"]

> One click. Auto-pilot.
> Orders are signed right inside the browser — my keys never leave this machine,
> and by design they can't withdraw a cent.

## IT'S ALIVE · 0:58–1:10 · [P2: drift gauge "In balance" 0.00%, orders resting, fills]

> And it's live. Two maker orders resting on the book.
> Drift: zero point zero zero percent. Perfectly hedged, farming the spread.

## EXCHANGE SIDE · 1:10–1:25 · [P2: app.perpl.xyz MON book — our orders, fills ticking]

> Same thing from the exchange side — those are MY orders sitting in the MON book.
> Watch them fill... and instantly re-quote. Over and over. All day. While I sleep.

**Money shot in P2:** a real maker fill lands ON CAMERA — green toast "MON short
position size 2776 was reduced", Open Orders (2)→(1), PnL ticks up. Freeze that
frame and circle the toast.

## CLOSE · 1:25–1:35 · [P2: back on terminal — on-chain epochs, registry, green lights]

> Every hedge writes a receipt on-chain — a verified, permissionless registry on Monad.
> ZeroDrift. Delta-neutral points farming.
> Link in bio.

---

## Edit notes

- 9:16 crops: statusbar scenes → crop the left 40%; hedge-card scenes → crop the
  right third; book scenes → center on the ladder.
- The GIFs run at capture pace — freeze-frame the money shots (drift 0.00%, the A/B
  table, "2 maker orders resting") for 1–2s each in the edit.
- Numbers said aloud (17% APR, 0.9 bps, 0.00% drift) appear on screen in the same
  scene — point captions at them.
- Honest-mode caption for the CLICK scene: "not financial advice · maker fees still
  apply" keeps comments friendly.
