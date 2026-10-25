# Paying a character in eddies

Added 2026-10-26 (branch `fix/eddies-payment`). **Settings > Help > Misc > Pay characters in eddies**, off by default (the first build had it on the Companion behavior
page, it moved to Help, section Misc, the same day: experimental extras live there).

A player asked to pay (or be paid by) characters when hiring them. Before this, "I gave you 500 eddies" was only words: the model was told V is the one paying
(`MONEY_NOTE`, docs/DYNAMIC_INFO.md "Money talk") but no money moved and the game showed nothing. With the switch On, when V **types** a plain payment to one of V's
own characters, the eddies leave V's balance with the game's own eddies pop-up, and the character's prompt says plainly "V just paid you N eddies".

## What counts

Only a typed line, to one of **our own copies**: a party member, a visitor V invited (Immersive invitations) or a housemate standing in the world
(`companions.payable`, the mod's own list of copies). Never a character the game placed (they have no entry, so no offer is ever made), never an ordinary NPC,
a phone chat, a holocall, a group round, an automatic reaction or a made character (those turns do not go through the offer). **A spoken line does not pay yet**
(its words are not known when the turn is admitted, and Convai's model hears audio, not text): the words-only note stays for it. Type the payment.

## Design: the amount comes from V's words, never from the reply

The invitations' actions let the model's reply choose (a tag or a Convai action) and the game checks it. For money that is the wrong trust: a model could be talked
into paying, or hallucinate an amount. So here **the bridge decides from V's own typed words, the reply decides nothing**, and the game checks everything again.

```
V types "I paid you 500 eddies" to Judy (our copy)
  game  (mod/gameplay-actions.lua capture 'private-text'): switch On + Judy is ours -> mod/eddies-payment.lua offer(): {available, actor, balance, max = min(balance, 100000)}
        the offer rides in the request (`payOffer`) and is leased (request id, entity, profile, world token, generation, 125 s)
  bridge (bridge/eddies-payment.mjs): parsePayOffer -> screenPayment(text) -> paymentDecision: pay 500?  yes: one packet {action 'companion-pay', pay: {amount}, payOffer}
        into runtime/companion-actions.json (the mailbox the actions use), after the mailbox was cleared for this turn; the prompt gets paidNote(500)
  game  (gameplay-actions.lua update): packet must match the lease (request, entity, profile, source, world, times, the offer EXACTLY, amount whole 1..offer.max)
        -> the pay offer is spent (before the native call) -> eddies-payment.lua pay(): re-checks switch, offer, whole number 1..max and the 100000 cap, that Judy is still ours,
           V's live balance >= amount -> RemoveItem(player, Items.money, amount) -> reads the balance back: paid only if it went down by exactly the amount
```

A payment spends **only** the pay offer. A ride, a fight or a meeting leased by the same line stays available (every other offer is consumed whole by its own packet).

### The pop-up

The game's inventory listener does it: `ItemsNotificationQueue` registers a `CurrencyChangeInventoryCallback` on V (`cyberpunk/UI/fullscreen/notification/itemsQueue.script`,
`currencyNotification.script`): `OnItemQuantityChanged(item, diff, total, flaggedAsSilent)` for `Items.money`, not silent, calls `PushCurrencyNotification(diff, total)`.
`TransactionSystem.RemoveItem(player, MarketSystem.Money(), amount)` is what the vendors, the Delamain taxi (`delamainTaxiSystem.script` `OnPayTravelRequest`), the
quest payment condition and the ripperdoc use (`MarketSystem.Money()` is the `Items.money` item id, the one `mod/turn-context.lua` reads for the balance band). So the mod adds
**no notification of its own** on success. A refusal the game side makes (`balance` or anything else) shows one mod notice: "You do not have enough eddies for that." or
"The payment could not be made." (the same path an action the game refuses uses).

## The screen (`screenPayment`)

It reads the typed line in the 15 menu languages (en de fr es it pt pl ru uk tr cs hu ja ko zh) and answers an amount only when the line **plainly says V pays now**. A word
that is missing from a language can only make it refuse, never pay.

Pays: exactly one amount of money (`500 eddies`, `1,000 euro-dollars`, `5k eddies`, `€$500`, `500€$`, full-width digits; the money words are eddies and the in-game
currency of each language) **and** either V as the subject of a payment verb with the character next to it and nobody else (`I paid you 500 eddies`, `I gave Judy 300 eddies`,
`Ich zahle dir 500 Eddies`, `Te pago 500 eddies`, `Я плачу тебе 500 эдди`, `我给你500欧元`, `500エディ払うよ`), or a hand-over at the start of the clause (`Here, take 500 eddies`,
`Tiens, prends 500 eddies`), or "500 eddies for you".

Never pays (refused, with the reason kept for the character's note): a question (`?`), a condition or wish (`if`, `would`, `maybe`, `want`, `need`, `let me`), a promise or a future
(`will`, `'ll`, `going to`, `tomorrow`, `later`), a negation (`not`, `never`, `no`, `without`), a past payment (`yesterday`, `already`, `last week`), a debt (`owe`, `refund`, `back`),
taking from somewhere (`from`, `out of`, `steal`), a request (`give me`, `pay me`, `lend me`), someone else paying or being paid (`he paid you`, `I paid him`, `you paid me`),
two amounts or the same amount twice, zero, a negative number, a fraction (`0.5`, `1,5`, `2.55k`; `1.000` and `1,000` are thousands), a number with no money word (`I paid you 500`),
number words (`five hundred`: write digits) and more than 600 characters of line. Then the hard limits: a whole number from 1 up to V's balance, never above **100000** (`PAY_CAP`,
`M.CAP`; the same number on both sides).

## What the character is told

One note in the volatile tail of every provider's context (Convai dynamic info, Mistral, Local AI, Custom), replacing the words-only `Money:` note on a turn that carries the offer:

* paid: "Money: V just paid you N eddies, right now and in person, and you have them. Take it as done and thank V in your own way. Do not ask for the eddies again and do not offer them back."
* more than V has, or above the cap: "...V spoke of paying you N eddies, but the game took none of it ... You received nothing."
* V's words speak of money but no payment was made (a promise, a question, "if"): "Money: no eddies changed hands this turn, whatever V says about money. Never say you have received eddies now. V is the one who would pay you ..."
* a line that is not about money: nothing.

A turn with no offer (switch Off, a game-placed character, a spoken line, a phone chat) keeps the words-only note exactly as before.

## Safety rules, all of them

1. **Switch Off by default**; Off: no offer is made, the balance is not even read, a packet is refused (`off`).
2. Amount decided by the bridge from V's own typed words; the reply, the model and the provider decide nothing.
3. A positive whole number, at most the balance and at most 100000, checked on both sides, the game side against V's **live** balance at the moment of payment.
4. One payment per turn: the bridge sends one packet per request id, and the game spends the pay offer before it calls the native.
5. The game side re-checks switch, offer (echoed exactly), person, request, world, times, amount, ownership (`companions.payable`) and balance, then reads the balance back.
6. Only the mod's own copies; a game-placed character gets no offer.
7. Typed private lines only (no group round, call, phone chat, reaction or spoken line).
8. No per-frame work: one boolean and one balance read when a typed line to an eligible character is admitted, one more pair of reads when a payment arrives.

## What only the game can confirm

The eddies pop-up (a `-500` line from the inventory listener), the balance going down by exactly the amount (the log says `Eddies payment: person=... amount=500 paid=yes`; a
mismatch says `Eddies payment unconfirmed: asked=... moved=...`), that `RemoveItem` on `Items.money` works from CET with these arguments (the unit tests use a strict fake wallet),
that `companions.payable` is true for the three kinds of copy (party, invited visitor, housemate) and false for the game's own Judy, and that a payment sent while the same line leases a ride
reaches the game before the ride's own packet (they share one mailbox; the pay packet is written first and read within a tick).

## Probe lines (since the live test of 2026-10-26)

A payment that "did nothing" left no trace, so every decision point now leaves one compact line. They only appear for a typed line that talks of money (the game
side: a digit and a money word; the bridge side: an amount of money the screen can read), so an ordinary conversation adds nothing.

Game, `runtime/probe.log` (`mod/eddies-payment.lua`, one line per such typed line, named for the person):

* `Eddies payment: offer=no(switch-off) person=judy-alvarez`: the switch is Off (or was not saved yet). The first thing to read when nothing happened.
* `offer=no(not-ours)`: the character is not one of our copies (a game-placed character, an ordinary NPC, a stale entity); `not-ours:error` when the check threw.
* `offer=no(context)` (group round, holocall, automatic reaction, Johnny, add-on voice), `offer=no(no-player)`, `offer=no(no-eddies)` (balance under 1),
  `offer=no(balance-unreadable:<type>)` (the transaction system's answer was not a whole number: its Lua type is named).
* `offer=yes balance=1200436 max=100000`: the offer went to the bridge.
* after the bridge's packet: `Eddies payment: person=... amount=500 paid=yes`, or `Eddies payment refused: <off|offer|amount|not-ours|no-player|unreadable|balance>`,
  `Eddies payment failed: ...` (the removal threw), `Eddies payment unconfirmed: asked=... moved=...`, and `Eddies payment packet refused: <fault>` from the lease.

Bridge, `bridge.stderr.log` (`[Payment]`, `bridge/eddies-payment.mjs`):

* `Eddies payment: person=judy-alvarez paid=no(no-offer: the switch is off, the character is not one of our copies, or the line was spoken)`: the line talked of
  money and no offer came with it, so the game side never made one (read its `offer=no(...)` line for the reason).
* `paid=no(refused:<reason> amount=N)`: an amount the screen or the limits refused (`question`, `conditional-or-negated`, `not-a-payment`, `several-amounts`,
  `fraction`, `negative`, `not-positive`, `balance`, `cap`).
* `paid=no(<code>)` for the guards after a good decision (`source:...`, `channel`, `send-not-allowed`, `stale-world`, `already-paid-this-turn`, ...), and
  `amount=500 handed-over=yes` when the packet was written.

## What the live test of 2026-10-26 showed

Owner, game 2.5, 0.3.2 build: "I pay you 500 eddies" typed to Judy (a party copy), switch On by the owner's account: no pop-up, no `Eddies payment` line anywhere.

* The line did reach the game as a typed private turn to a ready party copy (`probe.log`: talk target `judy-alvarez/11149673ULL ... party`, `Native input captured:
  generation=2 bytes=20` at 22:32:28Z, 20 bytes is exactly that line), with the balance readable (`money=rich(1200436)` on the same turn).
* The installed Lua and bridge were the repository's files (same commit `4b1c89bf`), so nothing was stale.
* The bridge writes a `[Payment]` line whenever it hands a payment over or refuses one after a good decision, and on every guard: the whole `bridge.stderr.log` has
  none. So the bridge never held a pay offer with a payment decision for that turn: no offer arrived.
* The offer is made by `mod/eddies-payment.lua offer()` inside the lease capture. The first build wrote nothing when it returned nothing, so the log cannot name
  the reason. Every link was rebuilt in `bridge/eddies-payment-live.test.mjs` with the REAL modules (companions.lua party and housemate copies, eddies-payment.lua over a
  strict fake wallet that only answers the `Items.money` id, gameplay-actions.lua in CET's no-`_G` environment with a JSON codec, the bridge's request parser,
  knowledge preparation, the screen, the packet, and the lease taking it back to `RemoveItem`): the owner's three lines ("I pay you 500 eddies", lower case, "here, take
  500 eddies") pay 500, a housemate pays, a game-placed character and a switch that is Off give no offer. So the code path is sound end to end with these inputs, and
  no defect was found in it. What only the game can still say is one of: the switch was not yet On when that line was sent (the settings file was last written at
  22:47Z, fifteen minutes after it), or a native answered unexpectedly (the balance's type, `Game.GetPlayer`). The probe lines above name which, the next time. The
  balance is now also read through `tonumber`, so a boxed integer cannot silently refuse the offer.

## Not in this job

Receiving eddies from a character (robbing V, paying V back, a reward) is **not built**: idea only. The same lease could carry a `give` offer in the other direction, with the same
rule that the amount comes from the game's own rules, never from the model. Spoken payments (the recognised words reach the bridge after the turn is admitted) and number words are
the other follow-ups.

## Files and tests

`bridge/eddies-payment.mjs` (offer parser, screen, decision, notes, `PaymentActions`), `bridge/protocol.mjs` (`payOffer`), `bridge/turn-context.mjs` (`moneyNote`),
`bridge/companion-actions.mjs` (`clearing`), `bridge/convai-bridge.mjs` (one call after the admission), `mod/eddies-payment.lua`, `mod/gameplay-actions.lua` (the pay offer in the lease),
`mod/companions.lua` (`payable`), `mod/init.lua` (wiring), `mod/manager.lua` and `mod/manager-ui.lua` (the setting), the 15 locales (four strings), `packaging/release-plan.json`,
`scripts/development-files.json`, `packaging/runtime-layout.mjs`.

Tests: `bridge/eddies-payment-live.test.mjs` (the owner's lines through the real game and bridge modules, end to end, and the probe lines), `bridge/eddies-payment.test.mjs` (the screen in about 50 paying phrasings and over 100 refusals across all 15 languages, the offer parser, the decision, the packet, the prompt),
`bridge/eddies-payment-game.test.mjs` (the game half on a strict fake wallet and the real lease: off, offer, every re-check, a removal that throws or does nothing, a leftover lease,
the other offers kept), plus `bridge/manager.test.mjs`, `bridge/support-help-ui.test.mjs` (the Misc section on Help: Off by default, saved, Restore defaults), `bridge/settings-file-lua.test.mjs` and `npm run test:ui-languages`.
